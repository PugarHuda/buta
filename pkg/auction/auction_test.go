package auction

import (
	"encoding/hex"
	"testing"

	"golang.org/x/crypto/sha3"
)

// bid builds an opening whose commitment is REAL: the id seeds the address and
// nonce, and Commit() produces the commitment, so Bid.Opens() holds. Tests that
// want to break the binding do so explicitly.
func bid(id byte, who string, amt uint64) Bid {
	var nonce [32]byte
	nonce[0] = id
	var addr [20]byte
	addr[19] = id
	return Bid{Commitment: Commit(amt, nonce, addr), Bidder: who, Amount: amt, Nonce: nonce, Addr: addr}
}

// recOf is the commitment set the contract would have recorded for these bids.
func recOf(bids ...Bid) []Commitment {
	out := make([]Commitment, len(bids))
	for i, b := range bids {
		out[i] = b.Commitment
	}
	return out
}

// The whole product in one assertion: highest bidder wins, pays the runner-up's
// price, and the losing amounts are not in the returned struct at all.
func TestClearPaysSecondPrice(t *testing.T) {
	bids := []Bid{
		bid(1, "0xaaa", 5194),
		bid(2, "0xbbb", 5218),
		bid(3, "0xccc", 5107),
		bid(4, "0xddd", 5263),
	}
	got, err := Clear(recOf(bids...), bids, 5000)
	if err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if got.Winner != "0xddd" {
		t.Errorf("winner = %q, want 0xddd", got.Winner)
	}
	if got.ClearingPrice != 5218 {
		t.Errorf("clearing = %d, want 5218 (second price, not 5263)", got.ClearingPrice)
	}
	if got.BidCount != 4 {
		t.Errorf("bidCount = %d, want 4", got.BidCount)
	}
}

// The attack this contract exists to stop: hand the enclave a subset so the
// winner clears at its own ask instead of the true second price.
func TestClearRefusesTrimmedSet(t *testing.T) {
	full := []Bid{
		bid(1, "0xaaa", 5194),
		bid(2, "0xbbb", 5218),
		bid(3, "0xccc", 5107),
	}
	recorded := recOf(full...) // the contract recorded all three
	trimmed := []Bid{full[0], full[2]}
	if _, err := Clear(recorded, trimmed, 5000); err != ErrSetMismatch {
		t.Fatalf("err = %v, want ErrSetMismatch", err)
	}
}

// Same size, different membership — must also fail, or substitution replaces
// trimming as the attack.
func TestClearRefusesSubstitutedBid(t *testing.T) {
	real := []Bid{bid(1, "0xaaa", 5194), bid(2, "0xbbb", 5218)}
	recorded := recOf(real...)
	swapped := []Bid{real[0], bid(9, "0xzzz", 9999)}
	if _, err := Clear(recorded, swapped, 5000); err != ErrSetMismatch {
		t.Fatalf("err = %v, want ErrSetMismatch", err)
	}
}

// A bidder committed on-chain to one number and revealed another. The opening
// no longer reproduces its commitment, so the whole clearing is refused.
func TestClearRefusesLyingOpening(t *testing.T) {
	honest := bid(1, "0xaaa", 5194)
	liar := bid(2, "0xbbb", 5218)
	recorded := recOf(honest, liar)

	liar.Amount = 9999 // keep the recorded commitment, change the revealed value
	if _, err := Clear(recorded, []Bid{honest, liar}, 5000); err != ErrOpeningMismatch {
		t.Fatalf("err = %v, want ErrOpeningMismatch", err)
	}
}

func TestClearFloorsAtReserve(t *testing.T) {
	bids := []Bid{
		bid(1, "0xaaa", 5300),
		bid(2, "0xbbb", 5010), // below reserve, so the reserve is the floor
	}
	got, err := Clear(recOf(bids...), bids, 5100)
	if err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if got.ClearingPrice != 5100 {
		t.Errorf("clearing = %d, want 5100 (reserve)", got.ClearingPrice)
	}
}

func TestClearLoneBidderPaysReserve(t *testing.T) {
	b := bid(1, "0xaaa", 9000)
	got, err := Clear(recOf(b), []Bid{b}, 5100)
	if err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if got.ClearingPrice != 5100 {
		t.Errorf("clearing = %d, want 5100 — a lone bidder must not clear at zero", got.ClearingPrice)
	}
}

func TestClearRejectsWhenNothingMeetsReserve(t *testing.T) {
	bids := []Bid{bid(1, "0xaaa", 100), bid(2, "0xbbb", 200)}
	if _, err := Clear(recOf(bids...), bids, 5000); err != ErrReserveUnmet {
		t.Fatalf("err = %v, want ErrReserveUnmet", err)
	}
}

// Two enclaves running the attested image must agree on a tie, or the
// signature over the outcome is worthless.
func TestClearTieIsDeterministic(t *testing.T) {
	seven := bid(7, "0xseven", 5000)
	three := bid(3, "0xthree", 5000)
	rec := recOf(seven, three)

	ra, err := Clear(rec, []Bid{seven, three}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	rb, err := Clear(rec, []Bid{three, seven}, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if ra.Winner != rb.Winner {
		t.Errorf("tie broke differently by input order: %q vs %q", ra.Winner, rb.Winner)
	}
	if ra.SetDigest != rb.SetDigest {
		t.Error("set digest depends on input order; it must not")
	}
}

func TestClearEmpty(t *testing.T) {
	if _, err := Clear(nil, nil, 0); err != ErrNoBids {
		t.Fatalf("err = %v, want ErrNoBids", err)
	}
}

// Pins the digest to the exact bytes Solidity's commitmentDigest produces for
// the same set (vector computed independently with viem). If either side
// changes its digest, this fails on whichever side moved.
func TestDigestCrossLanguageVector(t *testing.T) {
	names := []string{"alice", "bob", "carol"}
	rec := make([]Commitment, len(names))
	for i, n := range names {
		h := sha3.NewLegacyKeccak256()
		h.Write([]byte(n))
		copy(rec[i][:], h.Sum(nil))
	}
	got := digest(rec)
	want := "fe920ed06a5a02cd2a78548c40b9b76e355331fc61c0e14bff27319febdb8a03"
	if hex.EncodeToString(got[:]) != want {
		t.Fatalf("digest = %x, want %s", got, want)
	}
}

// --- solvency screening ---------------------------------------------------

// solvent returns a CanPay that refuses the named bidders outright.
func solvent(broke ...string) CanPay {
	set := map[string]bool{}
	for _, b := range broke {
		set[b] = true
	}
	return func(bidder string, _ uint64) bool { return !set[bidder] }
}

// Without screening, a winner who cannot settle takes the auction down with
// them: the transferFrom in relayClearing reverts and the clearing can never be
// relayed at all. The runner-up who was willing and able gets nothing.
func TestScreenSkipsABidderWhoCannotSettle(t *testing.T) {
	bids := []Bid{
		bid(1, "0xaaa", 5100),
		bid(2, "0xbbb", 5200),
		bid(3, "0xccc", 5300), // highest, and broke
	}
	got, err := ClearScreened(recOf(bids...), bids, 5000, solvent("0xccc"))
	if err != nil {
		t.Fatalf("ClearScreened: %v", err)
	}
	if got.Winner != "0xbbb" {
		t.Errorf("winner = %q, want 0xbbb", got.Winner)
	}
	// 0xbbb pays the best price it actually beat, which is 0xaaa's 5100 — not
	// the 5200 it would have paid if the insolvent bid still counted.
	if got.ClearingPrice != 5100 {
		t.Errorf("clearing = %d, want 5100", got.ClearingPrice)
	}
}

// The property that makes the screen safe rather than merely helpful: bidding
// costs nothing, so if an unfunded bid still set the price, anyone could inflate
// what the real winner pays for free. Skipping it re-runs the auction without
// it, and the shill buys nothing.
func TestInsolventBidCannotInflateThePrice(t *testing.T) {
	real := []Bid{bid(1, "0xaaa", 5100), bid(2, "0xbbb", 5200)}
	honest, err := ClearScreened(recOf(real...), real, 5000, solvent())
	if err != nil {
		t.Fatalf("ClearScreened: %v", err)
	}

	shilled := append([]Bid{bid(9, "0xdead", 9999)}, real...)
	got, err := ClearScreened(recOf(shilled...), shilled, 5000, solvent("0xdead"))
	if err != nil {
		t.Fatalf("ClearScreened: %v", err)
	}
	if got.Winner != honest.Winner || got.ClearingPrice != honest.ClearingPrice {
		t.Errorf("shill changed the outcome: %v/%d, want %v/%d",
			got.Winner, got.ClearingPrice, honest.Winner, honest.ClearingPrice)
	}
}

// A lone survivor still pays the reserve, never zero.
func TestScreenLeavesOneBidderPayingTheReserve(t *testing.T) {
	bids := []Bid{bid(1, "0xaaa", 5100), bid(2, "0xbbb", 5200)}
	got, err := ClearScreened(recOf(bids...), bids, 5000, solvent("0xbbb"))
	if err != nil {
		t.Fatalf("ClearScreened: %v", err)
	}
	if got.Winner != "0xaaa" || got.ClearingPrice != 5000 {
		t.Errorf("got %s at %d, want 0xaaa at 5000", got.Winner, got.ClearingPrice)
	}
}

func TestScreenRejectsWhenNobodyCanSettle(t *testing.T) {
	bids := []Bid{bid(1, "0xaaa", 5100), bid(2, "0xbbb", 5200)}
	if _, err := ClearScreened(recOf(bids...), bids, 5000, solvent("0xaaa", "0xbbb")); err != ErrNoSolventBid {
		t.Fatalf("err = %v, want ErrNoSolventBid", err)
	}
}

// The screen is asked about the price the bidder would actually owe, not their
// own bid — a bidder can be good for the second price and not for their own.
func TestScreenIsAskedAboutThePriceOwedNotTheBid(t *testing.T) {
	bids := []Bid{bid(1, "0xaaa", 5100), bid(2, "0xbbb", 9000)}
	var asked []uint64
	got, err := ClearScreened(recOf(bids...), bids, 5000, func(_ string, price uint64) bool {
		asked = append(asked, price)
		return price <= 6000
	})
	if err != nil {
		t.Fatalf("ClearScreened: %v", err)
	}
	if got.Winner != "0xbbb" {
		t.Errorf("winner = %q, want 0xbbb — it owes 5100, not its own 9000", got.Winner)
	}
	if len(asked) != 1 || asked[0] != 5100 {
		t.Errorf("screen was asked %v, want [5100]", asked)
	}
}

// Screening must not leak how many bidders were passed over.
func TestScreenDoesNotRevealHowManyWereSkipped(t *testing.T) {
	bids := []Bid{bid(1, "0xaaa", 5100), bid(2, "0xbbb", 5200), bid(3, "0xccc", 5300)}
	got, err := ClearScreened(recOf(bids...), bids, 5000, solvent("0xccc", "0xbbb"))
	if err != nil {
		t.Fatalf("ClearScreened: %v", err)
	}
	if got.BidCount != 3 {
		t.Errorf("BidCount = %d, want 3 — the recorded set, not the survivors", got.BidCount)
	}
}

// A nil screen has to behave exactly like the unscreened rule, including its
// error, or every existing caller silently changes meaning.
func TestNilScreenIsUnchangedBehaviour(t *testing.T) {
	bids := []Bid{bid(1, "0xaaa", 100)}
	if _, err := ClearScreened(recOf(bids...), bids, 5000, nil); err != ErrReserveUnmet {
		t.Fatalf("err = %v, want ErrReserveUnmet", err)
	}
}
