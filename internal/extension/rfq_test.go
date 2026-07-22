package extension

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"extension-scaffold/pkg/auction"

	"github.com/ethereum/go-ethereum/common"
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

func commit(t *testing.T, e *Extension, id uint64, bidder string, seed byte, amount uint64) []byte {
	t.Helper()
	// A real commitment: the enclave recomputes keccak(amount||nonce||addr) and
	// rejects the bid if it doesn't match, so the test has to supply the true one.
	var nonce [32]byte
	nonce[0] = seed
	var addrBytes [20]byte
	copy(addrBytes[:], common.HexToAddress(strings.ToLower(bidder)).Bytes())
	comm := auction.Commit(amount, nonce, addrBytes)

	req := commitBidRequest{
		RfqID: id, Bidder: bidder, Amount: amount,
		Commitment: hexutil.Encode(comm[:]), Nonce: hexutil.Encode(nonce[:]),
	}
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

	var n [32]byte
	var ab [20]byte
	copy(ab[:], common.HexToAddress("0xb").Bytes())
	comm := auction.Commit(99, n, ab)
	req := commitBidRequest{RfqID: id, Bidder: "0xb", Amount: 99,
		Commitment: hexutil.Encode(comm[:]), Nonce: hexutil.Encode(n[:])}
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

	// anyone else is refused — with a valid commitment, so the refusal is about
	// the invite, not a malformed bid.
	var n [32]byte
	n[0] = 2
	var ab [20]byte
	copy(ab[:], common.HexToAddress("0xbob").Bytes())
	comm := auction.Commit(20, n, ab)
	req := commitBidRequest{RfqID: id, Bidder: "0xbob", Amount: 20,
		Commitment: hexutil.Encode(comm[:]), Nonce: hexutil.Encode(n[:])}
	body, _ := json.Marshal(req)
	if ar := e.processCommitBid(teetypes.Action{}, &instruction.DataFixed{}, body); ar.Status != 0 {
		t.Fatal("uninvited bidder should have been refused")
	}
}
