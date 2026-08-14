package extension

import (
	"encoding/json"
	"math/big"
	"net/http"
	"strings"
	"testing"

	"buta/internal/config"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
)

// The routing layer had no test at all - every test called a handler directly,
// so the code that decides WHICH handler runs, and whether it may run, was
// never executed. That code holds the one gate that matters: the direct channel
// is plain unauthenticated HTTP, and BUTA_ALLOW_DIRECT_AUCTION is what keeps
// posting, bidding and clearing off it.

func directAction(command string, msg any) teetypes.Action {
	body, _ := json.Marshal(msg)
	inner, _ := json.Marshal(teetypes.DirectInstruction{
		OPType:    teeutils.ToHash(config.OPTypeButa),
		OPCommand: teeutils.ToHash(command),
		Message:   body,
	})
	return teetypes.Action{Data: teetypes.ActionData{
		ID:      common.HexToHash("0x01"),
		Type:    teetypes.Direct,
		Message: inner,
	}}
}

// With the flag off - which is the default, and what a deployed machine runs - 
// the three auction commands must be refused over the direct channel. If they
// were not, anyone who can reach the proxy could post an RFQ, seal a bid or
// CLEAR an auction without ever touching the chain or paying for an
// instruction. Clearing is the worst of the three: it settles.
func TestDirectAuctionOpsAreRefusedByDefault(t *testing.T) {
	if config.AllowDirectAuctionOps {
		t.Fatal("the default must be off - a machine that never sets the env var would accept auction ops over plain HTTP")
	}
	e := newAuctionExtension()

	for _, command := range []string{
		config.OPCommandPostRfq,
		config.OPCommandCommitBid,
		config.OPCommandClearAuction,
	} {
		code, body := e.processAction(directAction(command, map[string]any{"rfqId": 1}))
		if code != http.StatusNotImplemented {
			t.Errorf("%s over the direct channel returned %d, want 501 - it was accepted", command, code)
		}
		if !strings.Contains(string(body), "direct") && !strings.Contains(string(body), command) {
			t.Errorf("%s was refused without saying what was refused: %s", command, body)
		}
	}

	// And nothing was created on the way through.
	code, body := e.processAction(directAction(config.OPCommandListRfqs, map[string]any{}))
	if code != http.StatusOK {
		t.Fatalf("LIST_RFQS is read-only and must always be served: %d %s", code, body)
	}
	var ar teetypes.ActionResult
	if err := json.Unmarshal(body, &ar); err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(ar.Data), "rfqId"); n != 0 {
		t.Fatalf("a refused POST_RFQ still created %d auction(s)", n)
	}
}

// The read-only commands are the ones the desk lives on, and they must work
// with the gate shut - otherwise closing it takes the whole book down.
func TestReadOnlyDirectOpsAlwaysWork(t *testing.T) {
	e := newAuctionExtension()
	for _, command := range []string{
		config.OPCommandListRfqs,
		config.OPCommandGetMyBids,
		config.OPCommandGetRfqState,
	} {
		code, body := e.processAction(directAction(command, map[string]any{
			"rfqId": 1, "bidder": "0x0000000000000000000000000000000000000001",
		}))
		if code != http.StatusOK {
			t.Errorf("%s returned %d with the gate shut: %s", command, code, body)
		}
	}
}

// Turning the gate on is what cmd/dev does for the demo path. The same three
// commands then have to route, or the demo is dead - this is the other half of
// the claim, and without it the test above would pass on a build where the
// commands simply do not exist.
func TestDirectAuctionOpsRouteWhenAllowed(t *testing.T) {
	config.AllowDirectAuctionOps = true
	t.Cleanup(func() { config.AllowDirectAuctionOps = false })

	e := newAuctionExtension()
	code, body := e.processAction(directAction(config.OPCommandPostRfq, postRfqRequest{
		Maker: "0xMAKER", Pair: "FXRP/USDT0", Lot: 480_000, Reserve: 4000, Deadline: 24_109_880,
	}))
	if code != http.StatusOK {
		t.Fatalf("POST_RFQ was refused with the gate open: %d %s", code, body)
	}
	var ar teetypes.ActionResult
	if err := json.Unmarshal(body, &ar); err != nil {
		t.Fatal(err)
	}
	if ar.Status != 1 {
		t.Fatalf("POST_RFQ routed but failed: %s", ar.Log)
	}
}

// Everything that is not ours must be turned away by the router rather than
// reaching a handler that would try to parse it.
func TestUnroutableActionsAreRejected(t *testing.T) {
	e := newAuctionExtension()

	// An action type the extension does not implement.
	if code, _ := e.processAction(teetypes.Action{Data: teetypes.ActionData{Type: "gossip"}}); code != http.StatusBadRequest {
		t.Errorf("an unknown action type returned %d, want 400", code)
	}

	// Our channel, someone else's op type. This is the gate that broke the desk
	// once already, when the frontend defaulted to ORDERBOOK.
	foreign, _ := json.Marshal(teetypes.DirectInstruction{
		OPType:    teeutils.ToHash("ORDERBOOK"),
		OPCommand: teeutils.ToHash(config.OPCommandListRfqs),
		Message:   hexutil.Bytes("{}"),
	})
	code, body := e.processAction(teetypes.Action{Data: teetypes.ActionData{
		Type: teetypes.Direct, Message: foreign,
	}})
	if code != http.StatusNotImplemented {
		t.Errorf("a foreign op type returned %d, want 501", code)
	}
	if !strings.Contains(string(body), "BUTA") {
		t.Errorf("the refusal does not say which op type was expected: %s", body)
	}

	// Ours, but a command that does not exist.
	if code, _ := e.processAction(directAction("SELL_EVERYTHING", map[string]any{})); code != http.StatusNotImplemented {
		t.Errorf("an unknown direct command returned %d, want 501", code)
	}

	// Malformed payloads on both channels.
	for _, typ := range []teetypes.ActionType{teetypes.Direct, teetypes.Instruction} {
		code, _ := e.processAction(teetypes.Action{Data: teetypes.ActionData{
			Type: typ, Message: hexutil.Bytes("not json"),
		}})
		if code != http.StatusBadRequest {
			t.Errorf("undecodable %s message returned %d, want 400", typ, code)
		}
	}
}

// The production path, end to end through the router: an instruction action
// carrying what the contract actually emitted - abi.encode, not the desk's
// JSON. Every other test on this path decodes first and then calls the handler,
// so the translation and the routing had never run together.
func instructionAction(command string, payload []byte) teetypes.Action {
	df, _ := json.Marshal(instruction.DataFixed{
		InstructionID:   common.HexToHash("0x2a"),
		OPType:          teeutils.ToHash(config.OPTypeButa),
		OPCommand:       teeutils.ToHash(command),
		OriginalMessage: payload,
	})
	return teetypes.Action{Data: teetypes.ActionData{
		ID: common.HexToHash("0x2a"), Type: teetypes.Instruction, Message: df,
	}}
}

func TestOnChainInstructionRoutesAndLands(t *testing.T) {
	e := newAuctionExtension()

	// The id comes from the contract, not from us - 4211 is the number the
	// chain would have stamped.
	payload, err := postRfqArgs.Pack(
		big.NewInt(4211), common.HexToAddress("0x1001"), big.NewInt(250_000),
		uint64(9_000_000), common.Address{}, []byte{},
	)
	if err != nil {
		t.Fatal(err)
	}

	code, body := e.processAction(instructionAction(config.OPCommandPostRfq, payload))
	if code != http.StatusOK {
		t.Fatalf("on-chain POST_RFQ was refused: %d %s", code, body)
	}
	var ar teetypes.ActionResult
	if err := json.Unmarshal(body, &ar); err != nil {
		t.Fatal(err)
	}
	if ar.Status != 1 {
		t.Fatalf("on-chain POST_RFQ failed: %s", ar.Log)
	}
	if _, err := e.rfqs.get(4211); err != nil {
		t.Fatalf("the auction the contract created is not in the store: %v", err)
	}

	// The result has to carry the op type and command back, because that is what
	// the contract's callback matches on. A blank one routes nowhere.
	if ar.OPType != teeutils.ToHash(config.OPTypeButa) || ar.OPCommand != teeutils.ToHash(config.OPCommandPostRfq) {
		t.Errorf("result came back as %s/%s", ar.OPType.Hex(), ar.OPCommand.Hex())
	}

	// Unlike the direct channel, the gate does not apply here: an instruction
	// arrived through the diamond and was paid for.
	if config.AllowDirectAuctionOps {
		t.Fatal("this test proves nothing if the direct gate is open")
	}
}

// Garbage in the ABI payload must be refused by the decoder, not stored.
func TestOnChainInstructionWithGarbagePayloadIsRefused(t *testing.T) {
	e := newAuctionExtension()
	code, _ := e.processAction(instructionAction(config.OPCommandPostRfq, []byte{0xde, 0xad}))
	if code != http.StatusBadRequest {
		t.Errorf("a malformed abi payload returned %d, want 400", code)
	}
	if n := len(e.rfqs.rfqs); n != 0 {
		t.Errorf("a refused instruction still created %d auction(s)", n)
	}

	// And a command that is ours but has no on-chain form.
	if code, _ := e.processAction(instructionAction(config.OPCommandListRfqs, nil)); code != http.StatusNotImplemented {
		t.Errorf("LIST_RFQS as an instruction returned %d, want 501 - it is a read, it has no on-chain form", code)
	}
}
