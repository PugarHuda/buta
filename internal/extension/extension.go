package extension

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"buta/internal/config"

	"github.com/ethereum/go-ethereum/common"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"github.com/flare-foundation/tee-node/pkg/processorutils"
)

// Extension is the Buta sealed-bid extension handler.
//
// There is no balance manager here on purpose. The fork arrived with a vault
// (deposit, withdraw, per-token balances), but Buta settles the lot and the
// payment inside ButaInstructionSender itself — that contract has no deposit
// or withdraw function, so nothing could ever reach those handlers. Custody
// that cannot be entered is worse than no custody: it reads like a feature.
type Extension struct {
	mu     sync.RWMutex
	Server *http.Server

	pairs     map[string]config.TradingPairConfig // pair name -> token addresses
	rfqs      *rfqStore                           // sealed auctions, keyed by RFQ id
	admins    map[string]bool                     // admin addresses
	signPort  int                                 // TEE sign server port
	decryptor Decryptor                           // ECIES decrypt; nil = plaintext-only (sim/tests)

	// Solvency screening. Both nil means clearing runs the plain Vickrey rule,
	// which is what an enclave with no chain access has to do — see solvency.go.
	funds             Funds
	instructionSender common.Address // the spender relayClearing pulls through
}

// SetFunds turns on solvency screening: the clearing engine will pass over a
// bidder who cannot settle the price they would owe, instead of awarding to them
// and having relayClearing revert the whole auction.
func (e *Extension) SetFunds(f Funds, instructionSender common.Address) {
	e.funds = f
	e.instructionSender = instructionSender
}

func New(extensionPort, signPort int) *Extension {
	e := &Extension{
		rfqs:     newRfqStore(),
		pairs:    make(map[string]config.TradingPairConfig),
		admins:   make(map[string]bool),
		signPort: signPort,
	}

	for _, addr := range config.AdminAddresses {
		e.admins[strings.ToLower(addr)] = true
	}

	for _, pair := range config.TradingPairs {
		e.pairs[pair.Name] = pair
		logger.Infof("registered trading pair: %s (base=%s, quote=%s)", pair.Name, pair.BaseToken.Hex(), pair.QuoteToken.Hex())
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /action", e.actionHandler)

	e.Server = &http.Server{Addr: fmt.Sprintf(":%d", extensionPort), Handler: mux}

	e.decryptor = newTeeNodeDecryptor(signPort)

	return e
}

// processAction routes by action type (instruction vs direct) and then by OPType/OPCommand.
func (e *Extension) processAction(action teetypes.Action) (int, []byte) {
	switch action.Data.Type {
	case teetypes.Instruction:
		return e.processInstruction(action)
	case teetypes.Direct:
		return e.processDirect(action)
	default:
		return http.StatusBadRequest, []byte(fmt.Sprintf("unsupported action type: %s", action.Data.Type))
	}
}

// processInstruction handles on-chain instruction actions (deposits, withdrawals).
func (e *Extension) processInstruction(action teetypes.Action) (int, []byte) {
	df, err := processorutils.Parse[instruction.DataFixed](action.Data.Message)
	if err != nil {
		return http.StatusBadRequest, []byte(fmt.Sprintf("decoding fixed data: %v", err))
	}

	if !supportedOPType(df.OPType) {
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op type: received %s, expected %s (%s)",
			df.OPType.Hex(), teeutils.ToHash(config.OPTypeButa).Hex(), config.OPTypeButa,
		))
	}

	var ar teetypes.ActionResult

	// On this path the payload is what the contract produced with abi.encode,
	// not the JSON the desk posts. Translate before the handler sees it —
	// see onchain.go.
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandPostRfq):
		msg, derr := decodePostRfq(df.OriginalMessage, e.decryptor)
		if derr != nil {
			return http.StatusBadRequest, []byte(derr.Error())
		}
		ar = e.processPostRfq(action, df, msg)
	case df.OPCommand == teeutils.ToHash(config.OPCommandCommitBid):
		msg, derr := decodeCommitBid(df.OriginalMessage)
		if derr != nil {
			return http.StatusBadRequest, []byte(derr.Error())
		}
		ar = e.processCommitBid(action, df, msg)
	case df.OPCommand == teeutils.ToHash(config.OPCommandClearAuction):
		msg, derr := decodeClearAuction(df.OriginalMessage)
		if derr != nil {
			return http.StatusBadRequest, []byte(derr.Error())
		}
		ar = e.processClearAuction(action, df, msg)
	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported instruction op command: %s", df.OPCommand.Hex(),
		))
	}

	b, _ := json.Marshal(ar)
	return http.StatusOK, b
}

// processDirect handles off-chain direct instruction actions (orders, cancels, state, history).
func (e *Extension) processDirect(action teetypes.Action) (int, []byte) {
	di, err := processorutils.Parse[teetypes.DirectInstruction](action.Data.Message)
	if err != nil {
		return http.StatusBadRequest, []byte(fmt.Sprintf("decoding direct instruction: %v", err))
	}

	if !supportedOPType(di.OPType) {
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op type: received %s, expected %s (%s)",
			di.OPType.Hex(), teeutils.ToHash(config.OPTypeButa).Hex(), config.OPTypeButa,
		))
	}

	df := &instruction.DataFixed{
		InstructionID: action.Data.ID,
		OPType:        di.OPType,
		OPCommand:     di.OPCommand,
	}

	var ar teetypes.ActionResult

	switch {
	case di.OPCommand == teeutils.ToHash(config.OPCommandListRfqs):
		ar = e.processListRfqs(action, df, di.Message)
	case di.OPCommand == teeutils.ToHash(config.OPCommandGetMyBids):
		ar = e.processGetMyBids(action, df, di.Message)
	case di.OPCommand == teeutils.ToHash(config.OPCommandGetRfqState):
		ar = e.processGetRfqState(action, df, di.Message)
	case config.AllowDirectAuctionOps && di.OPCommand == teeutils.ToHash(config.OPCommandPostRfq):
		ar = e.processPostRfq(action, df, di.Message)
	case config.AllowDirectAuctionOps && di.OPCommand == teeutils.ToHash(config.OPCommandCommitBid):
		ar = e.processCommitBid(action, df, di.Message)
	case config.AllowDirectAuctionOps && di.OPCommand == teeutils.ToHash(config.OPCommandClearAuction):
		ar = e.processClearAuction(action, df, di.Message)
	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported direct op command: %s", di.OPCommand.Hex(),
		))
	}

	b, _ := json.Marshal(ar)
	return http.StatusOK, b
}

// supportedOPType accepts only the Buta op type. The fork was born speaking
// ORDERBOOK; that rail and its handlers are gone.
func supportedOPType(h common.Hash) bool {
	return h == teeutils.ToHash(config.OPTypeButa)
}
