package extension

import (
	"bytes"
	"crypto/ecdsa"
	"encoding/json"
	"strings"
	"testing"

	"buta/pkg/auction"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
)

// This exercises the whole sealed lifecycle through the real handlers, and then
// checks the one property the product lives or dies on: no losing bid amount
// ever appears in anything the enclave hands back. If a future refactor starts
// echoing amounts into a response, this test fails.
//
// Bids are signed with real keys — commitBid recovers the signature and refuses
// a sender that doesn't match, so the tests have to do what a wallet does.

func newAuctionExtension() *Extension {
	return &Extension{rfqs: newRfqStore()}
}

type bidder struct {
	key  *ecdsa.PrivateKey
	addr common.Address
}

func (b bidder) hex() string { return strings.ToLower(b.addr.Hex()) }

func newBidder(t *testing.T, seed byte) bidder {
	t.Helper()
	var raw [32]byte
	raw[31] = seed
	k, err := crypto.ToECDSA(raw[:])
	if err != nil {
		t.Fatal(err)
	}
	return bidder{key: k, addr: crypto.PubkeyToAddress(k.PublicKey)}
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

// sealedBid builds a fully honest signed request for b.
func sealedBid(t *testing.T, id uint64, b bidder, seed byte, amount uint64) commitBidRequest {
	t.Helper()
	var nonce [32]byte
	nonce[0] = seed
	var addrBytes [20]byte
	copy(addrBytes[:], b.addr.Bytes())
	comm := auction.Commit(amount, nonce, addrBytes)

	payload := bidSigPayload(id, comm)
	ethHash := crypto.Keccak256Hash([]byte("\x19Ethereum Signed Message:\n32"), payload[:])
	sig, err := crypto.Sign(ethHash[:], b.key)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27 // wallets emit v in {27,28}

	return commitBidRequest{
		RfqID: id, Bidder: b.hex(), Amount: amount,
		Commitment: hexutil.Encode(comm[:]), Nonce: hexutil.Encode(nonce[:]),
		Sig: hexutil.Encode(sig),
	}
}

func commit(t *testing.T, e *Extension, id uint64, b bidder, seed byte, amount uint64) {
	t.Helper()
	body, _ := json.Marshal(sealedBid(t, id, b, seed, amount))
	ar := e.processCommitBid(teetypes.Action{}, &instruction.DataFixed{}, body)
	if ar.Status != 1 {
		t.Fatalf("commit_bid failed: %s", ar.Log)
	}
}

func commitExpectErr(t *testing.T, e *Extension, req commitBidRequest) string {
	t.Helper()
	body, _ := json.Marshal(req)
	ar := e.processCommitBid(teetypes.Action{}, &instruction.DataFixed{}, body)
	if ar.Status != 0 {
		t.Fatalf("commit_bid unexpectedly succeeded")
	}
	return ar.Log
}

func TestSealedLifecycle(t *testing.T) {
	e := newAuctionExtension()
	alice, bob, carol := newBidder(t, 1), newBidder(t, 2), newBidder(t, 3)

	id := post(t, e, postRfqRequest{
		Maker: "0xMAKER", Pair: "FXRP/USDT0", Lot: 480_000, Reserve: 4000, Deadline: 24_109_880,
	})

	// three sealed bids; the amounts here must never resurface downstream
	commit(t, e, id, alice, 1, 5194)
	commit(t, e, id, bob, 2, 5218) // winner
	commit(t, e, id, carol, 3, 5107)

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

	if out.Winner != bob.hex() {
		t.Errorf("winner = %q, want %s", out.Winner, bob.hex())
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

// The hole the reference orderbook leaves open: a sender field taken at face
// value. Here a bid claiming to be from bob but signed by mallory bounces.
func TestCommitBidRejectsForgedSender(t *testing.T) {
	e := newAuctionExtension()
	bob, mallory := newBidder(t, 2), newBidder(t, 9)
	id := post(t, e, postRfqRequest{Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})

	// mallory signs, but the request claims bob is the bidder — and the
	// commitment is honestly bob's, so only the signature check can catch it.
	req := sealedBid(t, id, mallory, 1, 500)
	honest := sealedBid(t, id, bob, 1, 500)
	req.Bidder = honest.Bidder
	req.Commitment = honest.Commitment
	req.Nonce = honest.Nonce
	req.Amount = honest.Amount

	log := commitExpectErr(t, e, req)
	if !strings.Contains(log, "signature") {
		t.Fatalf("expected signature rejection, got: %s", log)
	}
}

// A signature for one auction must not authorise a bid in another.
func TestCommitBidRejectsReplayedSigAcrossRfqs(t *testing.T) {
	e := newAuctionExtension()
	bob := newBidder(t, 2)
	id1 := post(t, e, postRfqRequest{Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})
	id2 := post(t, e, postRfqRequest{Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})

	req := sealedBid(t, id1, bob, 1, 500)
	req.RfqID = id2 // reuse the id1 signature on id2
	log := commitExpectErr(t, e, req)
	if !strings.Contains(log, "signature") {
		t.Fatalf("expected signature rejection, got: %s", log)
	}
}

func TestClearTwiceRejected(t *testing.T) {
	e := newAuctionExtension()
	a := newBidder(t, 1)
	id := post(t, e, postRfqRequest{Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})
	commit(t, e, id, a, 1, 10)

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
	a, b := newBidder(t, 1), newBidder(t, 2)
	id := post(t, e, postRfqRequest{Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})
	commit(t, e, id, a, 1, 10)

	body, _ := json.Marshal(clearAuctionRequest{RfqID: id})
	e.processClearAuction(teetypes.Action{}, &instruction.DataFixed{}, body)

	commitExpectErr(t, e, sealedBid(t, id, b, 2, 99))
}

func TestDirectRailRejectsUninvited(t *testing.T) {
	e := newAuctionExtension()
	alice, bob := newBidder(t, 1), newBidder(t, 2)
	id := post(t, e, postRfqRequest{
		Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1,
		Invited: strings.ToUpper(alice.hex()), // case-normalised on ingest
	})

	// invited party is fine
	commit(t, e, id, alice, 1, 10)

	// anyone else is refused, even with a valid commitment and signature
	log := commitExpectErr(t, e, sealedBid(t, id, bob, 2, 20))
	if !strings.Contains(log, "invited") {
		t.Fatalf("expected invite rejection, got: %s", log)
	}
}
