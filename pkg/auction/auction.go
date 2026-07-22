// Package auction holds the sealed-bid clearing engine.
//
// This is the part of Buta that must run inside the enclave and nowhere else.
// Bids arrive as ciphertext, are decrypted in TEE memory, and are ranked here.
// Only the outcome leaves: the winner, the clearing price, and the digest of the
// bid set that produced them. Losing amounts are never returned, never logged,
// and never written to a response.
//
// The clearing rule is Vickrey: the highest bid wins and pays the second-highest
// price, floored at the maker's reserve. A bidder therefore has no reason to
// shade — which is the whole point of running a sealed auction, and the reason
// the auctioneer must not be able to read the book.
package auction

import (
	"bytes"
	"encoding/binary"
	"errors"
	"sort"

	"golang.org/x/crypto/sha3"
)

var (
	ErrNoBids        = errors.New("auction: no bids")
	ErrReserveUnmet  = errors.New("auction: no bid clears the reserve")
	ErrSetMismatch   = errors.New("auction: bid set does not match the recorded commitments")
	ErrDuplicateBid  = errors.New("auction: duplicate commitment")
	ErrAlreadyClosed = errors.New("auction: already cleared")
	ErrOpeningMismatch = errors.New("auction: opening does not match its commitment")
)

// Commitment is the 32-byte handle the contract records for a sealed bid.
// The enclave clears over exactly the commitments the contract holds, so a
// caller cannot present a trimmed set to suppress the second price.
type Commitment [32]byte

// Commit binds a bid to its commitment: keccak256(amount || nonce || bidder).
// The contract records this on-chain before the amount is known; the enclave
// recomputes it from the decrypted opening and refuses any mismatch. Without
// this, committing on-chain to X and handing the enclave Y would clear at Y —
// the commitment would be theatre.
//
// bidder is the 20-byte address bytes (lowercased upstream; only the bytes
// matter here).
func Commit(amount uint64, nonce [32]byte, bidder [20]byte) Commitment {
	var amt [32]byte
	binary.BigEndian.PutUint64(amt[24:], amount)

	h := sha3.NewLegacyKeccak256()
	h.Write(amt[:])
	h.Write(nonce[:])
	h.Write(bidder[:])

	var out Commitment
	copy(out[:], h.Sum(nil))
	return out
}

// Bid is a decrypted bid. It exists only inside the enclave.
type Bid struct {
	Commitment Commitment
	Bidder     string   // lowercase hex address
	Amount     uint64   // quote units; never leaves the enclave
	Nonce      [32]byte // blinds the commitment; without it commitments would be a lookup table
	Addr       [20]byte // raw address bytes, for recomputing the commitment
}

// Opens reports whether this bid's opening actually produces its commitment.
// A false here means the bidder committed to one number and revealed another.
func (b Bid) Opens() bool {
	return Commit(b.Amount, b.Nonce, b.Addr) == b.Commitment
}

// Outcome is everything the enclave is willing to say out loud.
type Outcome struct {
	Winner        string
	ClearingPrice uint64
	BidCount      int
	SetDigest     Commitment // binds the outcome to the recorded set
}

// Clear ranks the decrypted bids and returns the Vickrey outcome.
//
// recorded is the commitment set the contract accepted, in the order it
// accepted them. bids are the openings the enclave decrypted. The two must
// describe the same set or clearing is refused: that refusal is the mechanism
// that makes "award a subset" impossible rather than merely discouraged.
//
// reserve is the maker's hidden floor. A clearing price is never below it, and
// never below the runner-up's bid.
func Clear(recorded []Commitment, bids []Bid, reserve uint64) (Outcome, error) {
	if len(bids) == 0 || len(recorded) == 0 {
		return Outcome{}, ErrNoBids
	}
	// Every opening must reproduce its own commitment before the set is even
	// compared. This is what makes a commitment binding rather than decorative.
	for _, b := range bids {
		if !b.Opens() {
			return Outcome{}, ErrOpeningMismatch
		}
	}
	if err := matchesRecorded(recorded, bids); err != nil {
		return Outcome{}, err
	}

	// Sort by amount descending. Ties break on the commitment bytes so the
	// result is deterministic across machines — the code hash is attested, so
	// two enclaves running the same set must agree exactly.
	ranked := make([]Bid, len(bids))
	copy(ranked, bids)
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].Amount != ranked[j].Amount {
			return ranked[i].Amount > ranked[j].Amount
		}
		return bytes.Compare(ranked[i].Commitment[:], ranked[j].Commitment[:]) < 0
	})

	top := ranked[0]
	if top.Amount < reserve {
		return Outcome{}, ErrReserveUnmet
	}

	// Vickrey: pay the second price. With a single qualifying bid there is no
	// second price, so the reserve stands in for it — otherwise a lone bidder
	// would clear at zero.
	clearing := reserve
	if len(ranked) > 1 && ranked[1].Amount > clearing {
		clearing = ranked[1].Amount
	}

	return Outcome{
		Winner:        top.Winner(),
		ClearingPrice: clearing,
		BidCount:      len(ranked),
		SetDigest:     digest(recorded),
	}, nil
}

// Winner is a small accessor so callers never reach for b.Amount by habit.
func (b Bid) Winner() string { return b.Bidder }

// matchesRecorded checks the openings against the recorded commitments as
// multisets. Order is irrelevant; membership is not.
func matchesRecorded(recorded []Commitment, bids []Bid) error {
	if len(recorded) != len(bids) {
		return ErrSetMismatch
	}
	want := make(map[Commitment]int, len(recorded))
	for _, c := range recorded {
		want[c]++
	}
	for _, b := range bids {
		n, ok := want[b.Commitment]
		if !ok {
			return ErrSetMismatch
		}
		if n == 1 {
			delete(want, b.Commitment)
		} else {
			want[b.Commitment] = n - 1
		}
	}
	if len(want) != 0 {
		return ErrSetMismatch
	}
	return nil
}

// digest is keccak256 over the commitment set sorted bytewise ascending.
// Order-independent (the sort), collision-resistant (the keccak), and
// byte-identical to Solidity's commitmentDigest — both sides pin the same
// test vector so a drift fails CI on whichever side moved.
func digest(recorded []Commitment) Commitment {
	sorted := make([]Commitment, len(recorded))
	copy(sorted, recorded)
	sort.Slice(sorted, func(i, j int) bool {
		return bytes.Compare(sorted[i][:], sorted[j][:]) < 0
	})
	h := sha3.NewLegacyKeccak256()
	for _, c := range sorted {
		h.Write(c[:])
	}
	var out Commitment
	copy(out[:], h.Sum(nil))
	return out
}
