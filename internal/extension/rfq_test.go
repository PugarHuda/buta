package extension

import (
	"bytes"
	"crypto/ecdsa"
	"encoding/binary"
	"encoding/hex"
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
// Bids are signed with real keys - commitBid recovers the signature and refuses
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
	// ABI, not JSON: the node signs these bytes and relayClearing rebuilds them
	// with abi.encode, so the encoding is the interface between the two.
	outRfq, outWinner, outPrice, _, err := decodeClearingResultData(clAR.Data)
	if err != nil {
		t.Fatal(err)
	}
	_ = outRfq
	out := clearAuctionResponse{Winner: outWinner, ClearingPrice: outPrice}

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

	// mallory signs, but the request claims bob is the bidder - and the
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

func TestClearTwiceReturnsTheSameOutcome(t *testing.T) {
	e := newAuctionExtension()
	a := newBidder(t, 1)
	id := post(t, e, postRfqRequest{Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})
	commit(t, e, id, a, 1, 10)

	body, _ := json.Marshal(clearAuctionRequest{RfqID: id})
	first := e.processClearAuction(teetypes.Action{}, &instruction.DataFixed{}, body)
	if first.Status != 1 {
		t.Fatalf("first clear failed: %s", first.Log)
	}

	// This used to be "the second clear must fail", which was wrong in the one
	// way that mattered. A single requestClearing is delivered more than once - 
	// under a `threshold` tag and an `end` tag, over the main and backup queues
	// - and only the threshold result carries the ABI outcome relayClearing can
	// settle. Failing every delivery after the first meant that whenever `end`
	// arrived first, the settleable result came back as an error and the auction
	// could not be settled at all.
	second := e.processClearAuction(teetypes.Action{}, &instruction.DataFixed{}, body)
	if second.Status != 1 {
		t.Fatalf("second clear must return the outcome, not an error: %s", second.Log)
	}
	if !bytes.Equal(first.Data, second.Data) {
		t.Fatalf("second clear returned a different outcome: first %x, second %x", first.Data, second.Data)
	}

	// And it must be an answer, not a re-run: the openings are zeroed by the
	// first clear, so a second pass through the engine could not reproduce them.
	rfqID, winner, price, _, err := decodeClearingResultData(second.Data)
	if err != nil {
		t.Fatalf("decoding the repeated outcome: %v", err)
	}
	if rfqID != id || winner != e.rfqs.rfqs[id].Outcome.Winner || price != e.rfqs.rfqs[id].Outcome.ClearingPrice {
		t.Fatalf("repeated outcome does not match the stored one: rfq %d winner %s price %d", rfqID, winner, price)
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

// The contract assigns the rfq id, and relayClearing and commitmentDigest are
// both keyed by it. An enclave that numbers auctions on its own agrees with the
// chain only by coincidence - and stops agreeing the moment this process
// restarts, because the book is in volatile memory.
func TestPostRfqUsesTheContractsId(t *testing.T) {
	e := newAuctionExtension()
	id := post(t, e, postRfqRequest{RfqID: 4211, Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})
	if id != 4211 {
		t.Fatalf("id = %d, want 4211 - the enclave renumbered the auction", id)
	}
	if _, err := e.rfqs.get(4211); err != nil {
		t.Fatalf("rfq 4211 not stored: %v", err)
	}
}

// A restart is the case that breaks a local counter: the chain is at 4211 and
// the enclave's book is empty, so its own sequence would hand out 1.
func TestRestartDoesNotRenumberAuctions(t *testing.T) {
	first := newAuctionExtension()
	post(t, first, postRfqRequest{RfqID: 4211, Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})

	restarted := newAuctionExtension() // fresh memory, as after a redeploy
	if id := post(t, restarted, postRfqRequest{RfqID: 4212, Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1}); id != 4212 {
		t.Fatalf("id = %d, want 4212", id)
	}
}

// The same instruction arriving twice must not quietly replace an auction that
// already has bids in it.
func TestPostRfqRejectsADuplicateId(t *testing.T) {
	e := newAuctionExtension()
	post(t, e, postRfqRequest{RfqID: 7, Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})

	msg, _ := json.Marshal(postRfqRequest{RfqID: 7, Maker: "0xm", Pair: "P", Lot: 2, Reserve: 1, Deadline: 1})
	ar := e.processPostRfq(teetypes.Action{}, &instruction.DataFixed{}, msg)
	if ar.Status == 1 {
		t.Fatal("a duplicate rfq id was accepted")
	}
	r, err := e.rfqs.get(7)
	if err != nil {
		t.Fatal(err)
	}
	if r.Lot != 1 {
		t.Errorf("lot = %d, want 1 - the original auction was overwritten", r.Lot)
	}
}

// Mixing the two paths must not collide: after the chain has used 9, a
// simulated post has to land above it, not on top of it.
func TestLocalSequenceStaysAheadOfTheChain(t *testing.T) {
	e := newAuctionExtension()
	post(t, e, postRfqRequest{RfqID: 9, Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})
	if id := post(t, e, postRfqRequest{Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1}); id <= 9 {
		t.Fatalf("simulated id = %d, want > 9", id)
	}
}

// Listing has to depend on how many auctions there are, not on how high the
// chain's counter happens to be. The old loop counted down from next, which was
// the auction count only while the enclave did its own numbering.
func TestListingIsIndependentOfTheChainsCounter(t *testing.T) {
	e := newAuctionExtension()
	post(t, e, postRfqRequest{RfqID: 4211, Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})
	post(t, e, postRfqRequest{RfqID: 9_000_000, Maker: "0xm", Pair: "Q", Lot: 2, Reserve: 1, Deadline: 1})

	ar := e.processListRfqs(teetypes.Action{}, &instruction.DataFixed{}, nil)
	if ar.Status != 1 {
		t.Fatalf("list_rfqs failed: %s", ar.Log)
	}
	var got []rfqStateResponse
	if err := json.Unmarshal(ar.Data, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("listed %d auctions, want 2", len(got))
	}
	// newest first, and sparse ids must not disturb the order
	if got[0].RfqID != 9_000_000 || got[1].RfqID != 4211 {
		t.Errorf("order = %d, %d; want 9000000, 4211", got[0].RfqID, got[1].RfqID)
	}
}

// The same for a bidder's own view, which walked the same counter.
func TestMyBidsIsIndependentOfTheChainsCounter(t *testing.T) {
	e := newAuctionExtension()
	b := newBidder(t, 3)
	id := post(t, e, postRfqRequest{RfqID: 4211, Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})
	commit(t, e, id, b, 3, 100)

	body, _ := json.Marshal(myBidsRequest{Bidder: b.hex()})
	ar := e.processGetMyBids(teetypes.Action{}, &instruction.DataFixed{}, body)
	if ar.Status != 1 {
		t.Fatalf("get_my_bids failed: %s", ar.Log)
	}
	var got []myBidEntry
	if err := json.Unmarshal(ar.Data, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].RfqID != 4211 {
		t.Fatalf("got %+v, want one entry for rfq 4211", got)
	}
}

// An envelope nobody could have meant as a bid is refused before the enclave
// spends anything decoding it.
func TestOversizedCiphertextIsRefused(t *testing.T) {
	e := newAuctionExtension()
	id := post(t, e, postRfqRequest{Maker: "0xm", Pair: "P", Lot: 1, Reserve: 1, Deadline: 1})

	huge := "0x" + strings.Repeat("ab", MaxCiphertextBytes+1)
	body, _ := json.Marshal(commitBidRequest{RfqID: id, Bidder: "0xaaa", Commitment: "0x00", Ciphertext: huge})
	ar := e.processCommitBid(teetypes.Action{}, &instruction.DataFixed{}, body)
	if ar.Status == 1 {
		t.Fatal("an oversized ciphertext was accepted")
	}
	if !strings.Contains(ar.Log, "too large") {
		t.Errorf("log = %q, want it to say the ciphertext is too large", ar.Log)
	}
}

// Pins the exact bytes a wallet signs. Go and the frontend build this payload
// independently, so nothing else stops them drifting - and a drift does not
// throw, it silently rejects every bid as a forged sender.
func TestBidSigPayloadIsPinned(t *testing.T) {
	var c auction.Commitment
	c[0], c[31] = 0xAB, 0xCD

	got := bidSigPayload(7, c)
	// keccak256("BUTA_BID" || uint256(114) || uint256(7) || commitment),
	// computed independently with viem:
	//   keccak256(encodePacked(
	//     ["string","uint256","uint256","bytes32"],
	//     ["BUTA_BID", 114n, 7n, "0xab00…00cd"]))
	want := "0x" + hex.EncodeToString(crypto.Keccak256(
		[]byte("BUTA_BID"),
		padU64(114),
		padU64(7),
		c[:],
	))
	if got.Hex() != want {
		t.Fatalf("payload = %s, want %s", got.Hex(), want)
	}

	// And the chain id is genuinely in it: the same bid on another chain must
	// not produce the same signable payload.
	bidChainID = 19 // Songbird
	defer func() { bidChainID = 114 }()
	if bidSigPayload(7, c) == got {
		t.Fatal("changing the chain id did not change the payload - it is not bound")
	}
}

func padU64(v uint64) []byte {
	var b [32]byte
	binary.BigEndian.PutUint64(b[24:], v)
	return b[:]
}

// After clearing, the enclave keeps no bid amount and no nonce. The auction is
// decided, the second price is public, and everything else is a secret it can
// only leak - including the winner's own bid, which Vickrey never reveals.
func TestClearingWipesTheAmounts(t *testing.T) {
	e := newAuctionExtension()
	alice, bob, carol := newBidder(t, 1), newBidder(t, 2), newBidder(t, 3)

	id := post(t, e, postRfqRequest{
		Maker: "0xMAKER", Pair: "FXRP/USDT0", Lot: 480_000, Reserve: 4000, Deadline: 24_109_880,
	})
	commit(t, e, id, alice, 11, 5194)
	commit(t, e, id, bob, 12, 5107)
	commit(t, e, id, carol, 13, 4880)

	r, err := e.rfqs.get(id)
	if err != nil {
		t.Fatal(err)
	}
	// The premise: before clearing they really are in there. Without this the
	// test below would pass against a build that never stored them.
	held := 0
	for _, b := range r.Openings {
		if b.Amount != 0 {
			held++
		}
	}
	if held != 3 {
		t.Fatalf("only %d of 3 amounts were held before clearing - the wipe check would prove nothing", held)
	}

	body, _ := json.Marshal(clearAuctionRequest{RfqID: id})
	if ar := e.processClearAuction(teetypes.Action{}, &instruction.DataFixed{}, body); ar.Status != 1 {
		t.Fatalf("clear failed: %s", ar.Log)
	}

	for _, b := range r.Openings {
		if b.Amount != 0 {
			t.Errorf("%s's bid of %d survived clearing", b.Bidder, b.Amount)
		}
		if b.Nonce != ([32]byte{}) {
			t.Errorf("%s's nonce survived clearing", b.Bidder)
		}
		// What must survive: the bidder and the commitment, which GET_MY_BIDS
		// reads and which the contract already made public.
		if b.Bidder == "" || b.Commitment == (auction.Commitment{}) {
			t.Errorf("the wipe took the public part too: %+v", b)
		}
	}

	// And the receipt still works, because it is built from those two fields.
	mine, _ := json.Marshal(myBidsRequest{Bidder: alice.hex()})
	ar := e.processGetMyBids(teetypes.Action{}, &instruction.DataFixed{}, mine)
	var mineOut []myBidEntry
	if err := json.Unmarshal(ar.Data, &mineOut); err != nil {
		t.Fatal(err)
	}
	if len(mineOut) != 1 || !mineOut[0].Cleared || !mineOut[0].Won {
		t.Fatalf("alice can no longer see the bid she won after the wipe: %+v", mineOut)
	}
	if bytes.Contains(ar.Data, []byte("5194")) {
		t.Fatal("GET_MY_BIDS leaked an amount")
	}
}

// The commitments are public - the contract records every one of them on-chain
// before anyone knows what is in it - so the desk may as well show them. "3
// bids" is a number you take on trust; three commitment hashes, each marked as
// an amount nobody can read, is the thing itself.
func TestRfqStateReturnsTheRecordedCommitments(t *testing.T) {
	e := newAuctionExtension()
	alice, bob := newBidder(t, 1), newBidder(t, 2)

	id := post(t, e, postRfqRequest{
		Maker: "0xMAKER", Pair: "FXRP/USDT0", Lot: 480_000, Reserve: 4000, Deadline: 24_109_880,
	})
	commit(t, e, id, alice, 21, 5194)
	commit(t, e, id, bob, 22, 5107)

	body, _ := json.Marshal(clearAuctionRequest{RfqID: id})
	ar := e.processGetRfqState(teetypes.Action{}, &instruction.DataFixed{}, body)
	var st rfqStateResponse
	if err := json.Unmarshal(ar.Data, &st); err != nil {
		t.Fatal(err)
	}

	if len(st.Commitments) != 2 {
		t.Fatalf("got %d commitments, want 2", len(st.Commitments))
	}
	if st.BidCount != len(st.Commitments) {
		t.Errorf("bidCount %d disagrees with %d commitments - the desk would show a count it cannot back", st.BidCount, len(st.Commitments))
	}

	// They must be the set the contract recorded, in that order, not a
	// re-derivation: the whole point is that this is what is on-chain.
	r, _ := e.rfqs.get(id)
	for i, c := range r.Recorded {
		if want := hexutil.Encode(c[:]); st.Commitments[i] != want {
			t.Errorf("commitment %d is %s, recorded set has %s", i, st.Commitments[i], want)
		}
	}

	// And they are hashes, not openings. A commitment that revealed its amount
	// would make every other precaution pointless.
	if bytes.Contains(ar.Data, []byte("5194")) || bytes.Contains(ar.Data, []byte("5107")) {
		t.Fatalf("an amount came back with the commitments: %s", ar.Data)
	}
}

// One bid per address, because that is what the contract enforces. Only the
// commitment was checked, and the nonce is random - so the same bidder could
// seal any number of bids on the direct rail, and the enclave would build a set
// the contract will not accept. The digest then never matches and the clearing
// reverts permanently.
func TestOneBidPerAddress(t *testing.T) {
	e := newAuctionExtension()
	alice, bob := newBidder(t, 1), newBidder(t, 2)

	id := post(t, e, postRfqRequest{
		Maker: "0xMAKER", Pair: "FXRP/USDT0", Lot: 480_000, Reserve: 4000, Deadline: 24_109_880,
	})
	commit(t, e, id, alice, 31, 5194)

	// A different amount and a different nonce, so the commitment differs and
	// the duplicate-commitment check cannot catch it. This is exactly the shape
	// that got through.
	msg := sealedBid(t, id, alice, 32, 6000)
	body, _ := json.Marshal(msg)
	ar := e.processCommitBid(teetypes.Action{}, &instruction.DataFixed{}, body)
	if ar.Status == 1 {
		t.Fatal("alice sealed a second bid on the same auction")
	}
	if !strings.Contains(ar.Log, "already sealed") {
		t.Errorf("refused for the wrong reason: %s", ar.Log)
	}

	// Someone else is still welcome, and the first bid is untouched.
	commit(t, e, id, bob, 33, 5107)
	r, _ := e.rfqs.get(id)
	if len(r.Recorded) != 2 {
		t.Fatalf("%d bids recorded, want 2", len(r.Recorded))
	}

	// And the receipt is unambiguous, which is what disclosure depends on.
	mine, _ := json.Marshal(myBidsRequest{Bidder: alice.hex()})
	out := e.processGetMyBids(teetypes.Action{}, &instruction.DataFixed{}, mine)
	var bids []myBidEntry
	if err := json.Unmarshal(out.Data, &bids); err != nil {
		t.Fatal(err)
	}
	if len(bids) != 1 {
		t.Fatalf("alice has %d bids on record for one auction - a disclosure cannot say which is hers", len(bids))
	}
}
