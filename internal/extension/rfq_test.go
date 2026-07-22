package extension

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
)

// This exercises the whole sealed lifecycle through the real handlers, and then
// checks the one property the product lives or dies on: no losing bid amount
// ever appears in anything the enclave hands back. If a future refactor starts
// echoing amounts into a response, this test fails.

func newAuctionExtension() *Extension {
	return &Extension{rfqs: newRfqStore()}
}

func post(t *testing.T, e *Extension, req postRfqRequest) uint64 {
	t.Helper()
	body, _ := json.Marshal(req)
	ar := e.processPostRfq(teetypes.Action{}, &instruction.DataFixed{}, body)
	if ar.Status != 1 {
		t.Fatalf("post_rfq failed: %s", ar.Log)
	}
	var r postRfqResponse
	if err := json.Unmarshal(ar.Data, &r); err != nil {
		t.Fatal(err)
	}
	return r.RfqID
}

func commit(t *testing.T, e *Extension, id uint64, bidder string, c byte, amount uint64) []byte {
	t.Helper()
	var comm [32]byte
	comm[31] = c
	req := commitBidRequest{RfqID: id, Bidder: bidder, Commitment: hexutil.Encode(comm[:]), Amount: amount}
	body, _ := json.Marshal(req)
	ar := e.processCommitBid(teetypes.Action{}, &instruction.DataFixed{}, body)
	if ar.Status != 1 {
		t.Fatalf("commit_bid failed: %s", ar.Log)
	}
	return ar.Data
}

func TestSealedLifecycle(t *testing.T) {
	e := newAuctionExtension()

	id := post(t, e, postRfqRequest{
		Maker: "0xMAKER", Pair: "FXRP/USDT0", Lot: 480_000, Reserve: 4000, Deadline: 24_109_880,
	})

	// three sealed bids; the amounts here must never resurface downstream
	commit(t, e, id, "0xalice", 1, 5194)
	commit(t, e, id, "0xbob", 2, 5218) // winner
	commit(t, e, id, "0xcarol", 3, 5107)

	// before clearing, the public read leaks size + count, nothing else
	stateBody, _ := json.Marshal(clearAuctionRequest{RfqID: id})
	stAR := e.processGetRfqState(teetypes.Action{}, &instruction.DataFixed{}, stateBody)
	if bytes.Contains(stAR.Data, []byte("5194")) ||
		bytes.Contains(stAR.Data, []byte("5107")) ||
		bytes.Contains(stAR.Data, []byte("4000")) { // reserve must stay hidden too
		t.Fatalf("rfq state leaked a hidden number: %s", stAR.Data)
	}

	// clear
	clearBody, _ := json.Marshal(clearAuctionRequest{RfqID: id})
	clAR := e.processClearAuction(teetypes.Action{}, &instruction.DataFixed{}, clearBody)
	if clAR.Status != 1 {
		t.Fatalf("clear failed: %s", clAR.Log)
	}
	var out clearAuctionResponse
	if err := json.Unmarshal(clAR.Data, &out); err != nil {
		t.Fatal(err)
	}

	if out.Winner != "0xbob" {
		t.Errorf("winner = %q, want 0xbob", out.Winner)
	}
	if out.ClearingPrice != 5194 {
		t.Errorf("clearing = %d, want 5194 (second price)", out.ClearingPrice)
	}

	// the load-bearing assertion: the two losing amounts, and the winner's own
	// bid (5218, which Vickrey does NOT charge), are absent from the outcome.
	for _, hidden := range []string{"5218", "5107", "4000"} {
		if bytes.Contains(clAR.Data, []byte(hidden)) {
			t.Errorf("cleared outcome leaked hidden amount %s: %s", hidden, clAR.Data)
		}
	}
}

func TestClearTwiceRejected(t *testing.T) {
	e := newAuctionExtension()
	id := post(t, e, postRfqRequest{Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})
	commit(t, e, id, "0xa", 1, 10)

	body, _ := json.Marshal(clearAuctionRequest{RfqID: id})
	if ar := e.processClearAuction(teetypes.Action{}, &instruction.DataFixed{}, body); ar.Status != 1 {
		t.Fatalf("first clear failed: %s", ar.Log)
	}
	if ar := e.processClearAuction(teetypes.Action{}, &instruction.DataFixed{}, body); ar.Status != 0 {
		t.Fatal("second clear should have failed")
	}
}

func TestCommitAfterClearRejected(t *testing.T) {
	e := newAuctionExtension()
	id := post(t, e, postRfqRequest{Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})
	commit(t, e, id, "0xa", 1, 10)

	body, _ := json.Marshal(clearAuctionRequest{RfqID: id})
	e.processClearAuction(teetypes.Action{}, &instruction.DataFixed{}, body)

	req := commitBidRequest{RfqID: id, Bidder: "0xb", Commitment: hexutil.Encode(make([]byte, 32)), Amount: 99}
	cb, _ := json.Marshal(req)
	if ar := e.processCommitBid(teetypes.Action{}, &instruction.DataFixed{}, cb); ar.Status != 0 {
		t.Fatal("commit after clear should have failed")
	}
}

func TestDirectRailRejectsUninvited(t *testing.T) {
	e := newAuctionExtension()
	id := post(t, e, postRfqRequest{Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1, Invited: "0xALICE"})

	// invited party (case-normalised) is fine
	commit(t, e, id, "0xalice", 1, 10)

	// anyone else is refused
	req := commitBidRequest{RfqID: id, Bidder: "0xbob", Commitment: hexutil.Encode([]byte{2}), Amount: 20}
	body, _ := json.Marshal(req)
	if ar := e.processCommitBid(teetypes.Action{}, &instruction.DataFixed{}, body); ar.Status != 0 {
		t.Fatal("uninvited bidder should have been refused")
	}
}
