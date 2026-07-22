package auction

import "testing"

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
