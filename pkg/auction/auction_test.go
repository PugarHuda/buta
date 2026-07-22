package auction

import "testing"

func c(b byte) Commitment {
	var out Commitment
	out[31] = b
	return out
}

func bid(id byte, who string, amt uint64) Bid {
	return Bid{Commitment: c(id), Bidder: who, Amount: amt}
}

// The whole product in one assertion: highest bidder wins, pays the runner-up's
// price, and the losing amounts are not in the returned struct at all.
func TestClearPaysSecondPrice(t *testing.T) {
	rec := []Commitment{c(1), c(2), c(3), c(4)}
	bids := []Bid{
		bid(1, "0xaaa", 5194),
		bid(2, "0xbbb", 5218),
		bid(3, "0xccc", 5107),
		bid(4, "0xddd", 5263),
	}

	got, err := Clear(rec, bids, 5000)
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
	rec := []Commitment{c(1), c(2), c(3)}
	trimmed := []Bid{
		bid(1, "0xaaa", 5194),
		bid(3, "0xccc", 5107),
	}
	if _, err := Clear(rec, trimmed, 5000); err != ErrSetMismatch {
		t.Fatalf("err = %v, want ErrSetMismatch", err)
	}
}

// Same size, different membership — must also fail, or substitution replaces
// trimming as the attack.
func TestClearRefusesSubstitutedBid(t *testing.T) {
	rec := []Commitment{c(1), c(2)}
	swapped := []Bid{
		bid(1, "0xaaa", 5194),
		bid(9, "0xzzz", 9999),
	}
	if _, err := Clear(rec, swapped, 5000); err != ErrSetMismatch {
		t.Fatalf("err = %v, want ErrSetMismatch", err)
	}
}

func TestClearFloorsAtReserve(t *testing.T) {
	rec := []Commitment{c(1), c(2)}
	bids := []Bid{
		bid(1, "0xaaa", 5300),
		bid(2, "0xbbb", 5010), // below reserve, so the reserve is the floor
	}
	got, err := Clear(rec, bids, 5100)
	if err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if got.ClearingPrice != 5100 {
		t.Errorf("clearing = %d, want 5100 (reserve)", got.ClearingPrice)
	}
}

func TestClearLoneBidderPaysReserve(t *testing.T) {
	rec := []Commitment{c(1)}
	got, err := Clear(rec, []Bid{bid(1, "0xaaa", 9000)}, 5100)
	if err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if got.ClearingPrice != 5100 {
		t.Errorf("clearing = %d, want 5100 — a lone bidder must not clear at zero", got.ClearingPrice)
	}
}

func TestClearRejectsWhenNothingMeetsReserve(t *testing.T) {
	rec := []Commitment{c(1), c(2)}
	bids := []Bid{bid(1, "0xaaa", 100), bid(2, "0xbbb", 200)}
	if _, err := Clear(rec, bids, 5000); err != ErrReserveUnmet {
		t.Fatalf("err = %v, want ErrReserveUnmet", err)
	}
}

// Two enclaves running the attested image must agree on a tie, or the
// signature over the outcome is worthless.
func TestClearTieIsDeterministic(t *testing.T) {
	rec := []Commitment{c(7), c(3)}
	a := []Bid{bid(7, "0xseven", 5000), bid(3, "0xthree", 5000)}
	b := []Bid{bid(3, "0xthree", 5000), bid(7, "0xseven", 5000)}

	ra, err := Clear(rec, a, 1000)
	if err != nil {
		t.Fatal(err)
	}
	rb, err := Clear(rec, b, 1000)
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
