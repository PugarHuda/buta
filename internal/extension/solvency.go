package extension

// Can the winner actually pay?
//
// Without this the answer is found out the hard way: relayClearing does a
// transferFrom on the winner, and if it reverts the whole clearing reverts with
// it. The auction dies, the runner-up who was willing and able gets nothing, and
// the maker gets a wasted deadline. Bidding costs nothing, so this is not a rare
// accident — it is something a maker can be attacked with.
//
// The enclave is the only place the question can be asked without answering a
// different one. It already holds the decrypted amounts, so it can check a
// bidder's balance and allowance and pass over the ones who cannot settle,
// without telling anybody what anyone bid. Everything it learns stays inside;
// only the winner and the price come out, exactly as before.
//
// The settle token is NOT in the instruction payload — the contract encodes
// (rfqId, maker, lot, deadlineBlock, invited, encryptedReserve) and nothing more
// — so it is read back from the contract's own `rfqs` getter rather than trusted
// from a caller. That also means no contract change and no redeploy.

import (
	"context"
	"math/big"
	"strings"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/pkg/errors"

	"buta/pkg/auction"
)

// Funds answers "could this address settle this amount of this token, through
// this spender". Small on purpose: it is the only thing the clearing path is
// allowed to ask the chain.
type Funds interface {
	CanSettle(ctx context.Context, token, owner, spender common.Address, amount *big.Int) (bool, error)
	// SettleToken reads which token an auction settles in, off the contract.
	SettleToken(ctx context.Context, rfqID uint64) (common.Address, error)
}

const erc20AndRfqABI = `[
  {"type":"function","name":"balanceOf","stateMutability":"view",
   "inputs":[{"name":"","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
  {"type":"function","name":"allowance","stateMutability":"view",
   "inputs":[{"name":"","type":"address"},{"name":"","type":"address"}],
   "outputs":[{"name":"","type":"uint256"}]},
  {"type":"function","name":"rfqs","stateMutability":"view",
   "inputs":[{"name":"","type":"uint256"}],
   "outputs":[
     {"name":"maker","type":"address"},
     {"name":"settleToken","type":"address"},
     {"name":"lotToken","type":"address"},
     {"name":"lot","type":"uint256"},
     {"name":"deadlineBlock","type":"uint64"},
     {"name":"invited","type":"address"},
     {"name":"cleared","type":"bool"},
     {"name":"winner","type":"address"},
     {"name":"clearingPrice","type":"uint256"}]}
]`

// chainFunds reads balances over JSON-RPC. Read-only: it holds no key and sends
// no transaction, so the worst a compromised endpoint can do is make the screen
// answer wrongly — which is why a read failure is an error and not a "no".
type chainFunds struct {
	client   *ethclient.Client
	parsed   abi.ABI
	contract common.Address
	timeout  time.Duration
}

// NewChainFunds dials the chain and prepares the two calls the screen needs.
// instructionSender is ButaInstructionSender, the address `rfqs` lives on and
// the spender relayClearing pulls through.
func NewChainFunds(rpcURL string, instructionSender common.Address) (Funds, error) {
	parsed, err := abi.JSON(newReader(erc20AndRfqABI))
	if err != nil {
		return nil, errors.Errorf("parsing abi: %s", err)
	}
	c, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, errors.Errorf("dialing %s: %s", rpcURL, err)
	}
	return &chainFunds{client: c, parsed: parsed, contract: instructionSender, timeout: 8 * time.Second}, nil
}

func (f *chainFunds) call(ctx context.Context, to common.Address, method string, args ...interface{}) ([]interface{}, error) {
	data, err := f.parsed.Pack(method, args...)
	if err != nil {
		return nil, errors.Errorf("packing %s: %s", method, err)
	}
	ctx, cancel := context.WithTimeout(ctx, f.timeout)
	defer cancel()
	out, err := f.client.CallContract(ctx, ethereumCall(to, data), nil)
	if err != nil {
		return nil, errors.Errorf("calling %s: %s", method, err)
	}
	return f.parsed.Unpack(method, out)
}

func (f *chainFunds) SettleToken(ctx context.Context, rfqID uint64) (common.Address, error) {
	vals, err := f.call(ctx, f.contract, "rfqs", new(big.Int).SetUint64(rfqID))
	if err != nil {
		return common.Address{}, err
	}
	if len(vals) < 2 {
		return common.Address{}, errors.New("rfqs returned an unexpected shape")
	}
	token, ok := vals[1].(common.Address)
	if !ok {
		return common.Address{}, errors.New("settleToken is not an address")
	}
	return token, nil
}

func (f *chainFunds) CanSettle(
	ctx context.Context,
	token, owner, spender common.Address,
	amount *big.Int,
) (bool, error) {
	bal, err := f.call(ctx, token, "balanceOf", owner)
	if err != nil {
		return false, err
	}
	allow, err := f.call(ctx, token, "allowance", owner, spender)
	if err != nil {
		return false, err
	}
	b, ok1 := bal[0].(*big.Int)
	a, ok2 := allow[0].(*big.Int)
	if !ok1 || !ok2 {
		return false, errors.New("balanceOf or allowance did not return a uint256")
	}
	// Both, because relayClearing pulls: holding the funds without approving the
	// desk fails in exactly the same way as not holding them.
	return b.Cmp(amount) >= 0 && a.Cmp(amount) >= 0, nil
}

// newReader and ethereumCall keep the imports in this file honest: strings.Reader
// and ethereum.CallMsg are the only two things needed from those packages.
func newReader(s string) *strings.Reader { return strings.NewReader(s) }

func ethereumCall(to common.Address, data []byte) ethereum.CallMsg {
	return ethereum.CallMsg{To: &to, Data: data}
}

// solvencyScreen builds the CanPay the clearing engine walks the ranking with.
//
// Returns nil when no reader is wired, which makes ClearScreened behave exactly
// like plain Clear. That default matters: an enclave that cannot see balances
// must not conclude that nobody can pay and refuse to clear a perfectly good
// auction.
//
// A read that FAILS is treated as "can pay". The screen exists to catch bidders
// who provably cannot settle; an RPC timeout proves nothing, and letting it
// silently disqualify the top bid would hand anyone who can degrade our RPC the
// power to pick the winner.
func (e *Extension) solvencyScreen(rfqID uint64) auction.CanPay {
	return e.solvencyScreenFor(rfqID, "")
}

// solvencyScreenFor takes a fallback token for auctions that exist only in this
// process. The chain is preferred and always wins when it answers.
func (e *Extension) solvencyScreenFor(rfqID uint64, fallback string) auction.CanPay {
	if e.funds == nil {
		return nil
	}
	ctx := context.Background()
	token, err := e.funds.SettleToken(ctx, rfqID)
	if err != nil || token == (common.Address{}) {
		if fallback == "" {
			logger.Warnf("solvency screen off for rfq %d: %v", rfqID, err)
			return nil
		}
		token = common.HexToAddress(fallback)
		logger.Infof("solvency screen for rfq %d using the declared settle token %s", rfqID, token.Hex())
	}
	return func(bidder string, price uint64) bool {
		ok, err := e.funds.CanSettle(
			ctx, token, common.HexToAddress(bidder), e.instructionSender,
			new(big.Int).SetUint64(price),
		)
		if err != nil {
			logger.Warnf("solvency check failed for rfq %d, allowing: %v", rfqID, err)
			return true
		}
		return ok
	}
}
