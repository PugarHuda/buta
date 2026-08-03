package extension

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"

	"buta/pkg/auction"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
)

// The sealed-bid state lives here, in enclave memory, and nowhere else.
//
// Two things about this file matter more than the code in it:
//
//  1. A decrypted bid amount must never reach an ActionResult, a log line, or
//     a GET_RFQ_STATE response. Everything public goes through Outcome.
//  2. The clearing set is whatever the CONTRACT recorded, not whatever the
//     caller submits. commitBid appends to Rfq.Recorded only via an on-chain
//     instruction, so a caller cannot hand the enclave a trimmed set at clear
//     time. auction.Clear enforces the match; this file just has to not
//     undermine it.

var errRfqNotFound = errors.New("rfq not found")

// Rfq is one sealed auction.
type Rfq struct {
	ID       uint64
	Maker    string
	Lot      uint64 // base units offered
	Pair     string
	Reserve  uint64 // hidden floor, decrypted from the maker's ciphertext
	Deadline uint64 // BLOCK NUMBER, stamped by the contract.
	// Never a wall clock: the enclave's clock is not a trust anchor, and a
	// deadline the operator can nudge is not a deadline.

	Recorded []auction.Commitment // the set, in the order the contract accepted it
	Openings []auction.Bid        // decrypted bids; never leaves this struct
	// Invited is the direct rail: a maker scopes a block to one counterparty
	// ("" = open to anyone). A directed RFQ with a single sealed bid IS a
	// bilateral OTC settle — the lone bidder clears at the reserve (Clear floors
	// at reserve when there is no second price). So there is no separate
	// DIRECT_SETTLE opcode: the invited-auction path already is one, with the
	// same commitment, signature, and set-digest guarantees. ponytail: one
	// mechanism, two products.
	Invited string

	Cleared bool
	Outcome auction.Outcome

	// Simulated-path fallback for the solvency screen. Empty on-chain.
	SettleToken string
}

// rfqStore is the in-memory book of open auctions.
type rfqStore struct {
	mu   sync.RWMutex
	rfqs map[uint64]*Rfq
	next uint64
}

func newRfqStore() *rfqStore {
	return &rfqStore{rfqs: make(map[uint64]*Rfq)}
}

// idsDescending lists the auctions actually held, newest first.
//
// The listers used to count down from s.next, which was fine while the enclave
// numbered auctions itself and next was the auction count. Now that the id
// comes from the contract, next is the chain's rfqCount — so one auction at id
// 4211 meant 4211 map lookups per call, holding the read lock the whole way.
// Callers hold the lock.
func (s *rfqStore) idsDescending() []uint64 {
	ids := make([]uint64, 0, len(s.rfqs))
	for id := range s.rfqs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] > ids[j] })
	return ids
}

func (s *rfqStore) get(id uint64) (*Rfq, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.rfqs[id]
	if !ok {
		return nil, errRfqNotFound
	}
	return r, nil
}

// ── wire types ──────────────────────────────────────────────────────────────

type postRfqRequest struct {
	// RfqID is the id the CONTRACT assigned (`rfqId = ++rfqCount`), carried in
	// the instruction. It is authoritative: relayClearing and commitmentDigest
	// are both keyed by it, so an enclave that numbers auctions on its own
	// agrees with the chain only by coincidence — and stops agreeing the first
	// time this process restarts, since the book lives in volatile memory.
	// Zero means the simulated path, where no contract has spoken yet.
	RfqID    uint64 `json:"rfqId"`
	Maker    string `json:"maker"`
	Pair     string `json:"pair"`
	Lot      uint64 `json:"lot"`
	Reserve  uint64 `json:"reserve"` // decrypted before it reaches here
	Deadline uint64 `json:"deadline"`
	Invited  string `json:"invited"`
	// SettleToken is only read on the simulated path. On-chain the token is read
	// back from the contract, which is authoritative; a simulated auction has no
	// contract row to read, so without this the solvency screen silently turns
	// itself off for every auction the desk creates.
	SettleToken string `json:"settleToken"`
}

type postRfqResponse struct {
	RfqID uint64 `json:"rfqId"`
}

type commitBidRequest struct {
	RfqID      uint64 `json:"rfqId"`
	Bidder     string `json:"bidder"`
	Commitment string `json:"commitment"` // 0x + 32 bytes, recorded on-chain
	Amount     uint64 `json:"amount"`     // decrypted opening; stays in the enclave
	Nonce      string `json:"nonce"`      // 0x + 32 bytes; blinds the commitment
	Sig        string `json:"sig"`        // 65-byte personal_sign over bidSigPayload

	// Ciphertext, when present, is the ECIES envelope over {amount, nonce, sig}
	// encrypted to the TEE public key. It is the real path: the operator sees
	// only this blob in transit. The three plaintext fields above are then
	// ignored — filled from the decrypted opening. On the simulated/testing
	// path with no decryptor wired, callers send the plaintext fields directly.
	Ciphertext string `json:"ciphertext"`
}

type commitBidResponse struct {
	RfqID    uint64 `json:"rfqId"`
	BidCount int    `json:"bidCount"`
}

type clearAuctionRequest struct {
	RfqID uint64 `json:"rfqId"`
}

// clearAuctionResponse is deliberately the whole public surface of a cleared
// auction. If a field is not here, it does not leave the enclave.
type clearAuctionResponse struct {
	RfqID         uint64 `json:"rfqId"`
	Winner        string `json:"winner"`
	ClearingPrice uint64 `json:"clearingPrice"`
	BidCount      int    `json:"bidCount"`
	SetDigest     string `json:"setDigest"`
}

type rfqStateResponse struct {
	RfqID    uint64 `json:"rfqId"`
	Maker    string `json:"maker"`
	Pair     string `json:"pair"`
	Lot      uint64 `json:"lot"`
	Deadline uint64 `json:"deadline"`
	BidCount int    `json:"bidCount"`
	Cleared  bool   `json:"cleared"`
	// No reserve, no amounts. An open auction leaks its size and its
	// deadline, and nothing else.
	Winner        string `json:"winner,omitempty"`
	ClearingPrice uint64 `json:"clearingPrice,omitempty"`
}

type myBidsRequest struct {
	Bidder string `json:"bidder"`
}

// myBidEntry is one bid the caller placed. It carries the commitment (public)
// and outcome, never an amount — the bidder holds their own amount locally.
type myBidEntry struct {
	RfqID      uint64 `json:"rfqId"`
	Pair       string `json:"pair"`
	Commitment string `json:"commitment"`
	Cleared    bool   `json:"cleared"`
	Won        bool   `json:"won"`
}

// ── handlers ────────────────────────────────────────────────────────────────

// processPostRfq opens an auction. On-chain instruction: the deadline block and
// the RFQ id have to come from a transaction, not from a caller's say-so.
func (e *Extension) processPostRfq(action teetypes.Action, df *instruction.DataFixed, msg hexutil.Bytes) teetypes.ActionResult {
	var req postRfqRequest
	if err := json.Unmarshal(msg, &req); err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding post_rfq: %w", err))
	}
	if req.Lot == 0 {
		return buildResult(action, df, nil, 0, errors.New("zero lot"))
	}

	e.rfqs.mu.Lock()
	id := req.RfqID
	if id == 0 {
		// Simulated path: nobody has assigned one, so keep our own sequence.
		e.rfqs.next++
		id = e.rfqs.next
	} else {
		if _, exists := e.rfqs.rfqs[id]; exists {
			e.rfqs.mu.Unlock()
			return buildResult(action, df, nil, 0, fmt.Errorf("rfq %d already exists", id))
		}
		// Keep the local sequence ahead of anything the chain has used, so a
		// later simulated post cannot collide with a real one.
		if id > e.rfqs.next {
			e.rfqs.next = id
		}
	}
	e.rfqs.rfqs[id] = &Rfq{
		ID:          id,
		Maker:       strings.ToLower(req.Maker),
		Pair:        req.Pair,
		Lot:         req.Lot,
		Reserve:     req.Reserve,
		Deadline:    req.Deadline,
		Invited:     strings.ToLower(req.Invited),
		SettleToken: strings.ToLower(req.SettleToken),
	}
	e.rfqs.mu.Unlock()

	b, _ := json.Marshal(postRfqResponse{RfqID: id})
	return buildResult(action, df, b, 1, nil)
}

// processCommitBid records one sealed bid.
func (e *Extension) processCommitBid(action teetypes.Action, df *instruction.DataFixed, msg hexutil.Bytes) teetypes.ActionResult {
	var req commitBidRequest
	if err := json.Unmarshal(msg, &req); err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding commit_bid: %w", err))
	}

	// If the bid arrived sealed, open it inside the enclave and fill the
	// opening fields from the plaintext. This is the only place the amount is
	// ever in the clear, and it never leaves this process.
	if req.Ciphertext != "" {
		// Size first: it is the cheapest check and the only one that does not
		// need anything to be wired up.
		if len(req.Ciphertext) > 2*MaxCiphertextBytes+2 { // 0x + two chars a byte
			return buildResult(action, df, nil, 0, errors.New("ciphertext is too large to be a bid"))
		}
		if e.decryptor == nil {
			return buildResult(action, df, nil, 0, errors.New("no decryptor: cannot open a sealed bid"))
		}
		ctBytes, err := hexutil.Decode(req.Ciphertext)
		if err != nil {
			return buildResult(action, df, nil, 0, errors.New("ciphertext must be 0x-hex"))
		}
		plain, err := e.decryptor.Decrypt(ctBytes)
		if err != nil {
			return buildResult(action, df, nil, 0, fmt.Errorf("opening sealed bid: %w", err))
		}
		var open sealedOpening
		if err := json.Unmarshal(plain, &open); err != nil {
			return buildResult(action, df, nil, 0, fmt.Errorf("malformed opening: %w", err))
		}
		req.Amount, req.Nonce, req.Sig = open.Amount, open.Nonce, open.Sig
	}

	raw, err := hexutil.Decode(req.Commitment)
	if err != nil || len(raw) != 32 {
		return buildResult(action, df, nil, 0, errors.New("commitment must be 32 bytes"))
	}
	var c auction.Commitment
	copy(c[:], raw)

	nonceRaw, err := hexutil.Decode(req.Nonce)
	if err != nil || len(nonceRaw) != 32 {
		return buildResult(action, df, nil, 0, errors.New("nonce must be 32 bytes"))
	}
	var nonce [32]byte
	copy(nonce[:], nonceRaw)

	bidder := strings.ToLower(req.Bidder)
	addr := common.HexToAddress(bidder)

	// Recompute the commitment from the opening here, at ingest, so a bid that
	// doesn't open to what the chain recorded never enters the set. Clear()
	// checks this again at settlement; a bad opening should fail at the door.
	var addrBytes [20]byte
	copy(addrBytes[:], addr.Bytes())
	if auction.Commit(req.Amount, nonce, addrBytes) != c {
		return buildResult(action, df, nil, 0, auction.ErrOpeningMismatch)
	}

	// The sender field is bound to a wallet signature — the hole the reference
	// orderbook documents in its own threat model ("the TEE takes sender at
	// face value") and leaves open. Without this, anyone who reaches the proxy
	// can bid as anyone.
	if err := verifyBidSig(req.Sig, req.RfqID, c, addr); err != nil {
		return buildResult(action, df, nil, 0, err)
	}

	e.rfqs.mu.Lock()
	defer e.rfqs.mu.Unlock()

	r, ok := e.rfqs.rfqs[req.RfqID]
	if !ok {
		return buildResult(action, df, nil, 0, errRfqNotFound)
	}
	if r.Cleared {
		return buildResult(action, df, nil, 0, auction.ErrAlreadyClosed)
	}
	// Direct rail: one named counterparty, enforced here and again on-chain.
	if r.Invited != "" && r.Invited != bidder {
		return buildResult(action, df, nil, 0, errors.New("not the invited counterparty"))
	}
	for _, seen := range r.Recorded {
		if seen == c {
			return buildResult(action, df, nil, 0, auction.ErrDuplicateBid)
		}
	}

	r.Recorded = append(r.Recorded, c)
	r.Openings = append(r.Openings, auction.Bid{
		Commitment: c, Bidder: bidder, Amount: req.Amount, Nonce: nonce, Addr: addrBytes,
	})

	b, _ := json.Marshal(commitBidResponse{RfqID: r.ID, BidCount: len(r.Recorded)})
	return buildResult(action, df, b, 1, nil)
}

// processClearAuction runs the Vickrey clearing and returns the signable
// outcome. The losing amounts stay in r.Openings and are never marshalled.
func (e *Extension) processClearAuction(action teetypes.Action, df *instruction.DataFixed, msg hexutil.Bytes) teetypes.ActionResult {
	var req clearAuctionRequest
	if err := json.Unmarshal(msg, &req); err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding clear_auction: %w", err))
	}

	e.rfqs.mu.Lock()
	defer e.rfqs.mu.Unlock()

	r, ok := e.rfqs.rfqs[req.RfqID]
	if !ok {
		return buildResult(action, df, nil, 0, errRfqNotFound)
	}
	if r.Cleared {
		return buildResult(action, df, nil, 0, auction.ErrAlreadyClosed)
	}

	// Screened when a chain reader is wired, plain Vickrey when it is not — an
	// enclave with no way to check balances must not silently decide nobody can
	// pay. See solvency.go for why this belongs here and nowhere else.
	out, err := auction.ClearScreened(r.Recorded, r.Openings, r.Reserve, e.solvencyScreenFor(r.ID, r.SettleToken))
	if err != nil {
		return buildResult(action, df, nil, 0, err)
	}
	r.Cleared = true
	r.Outcome = out

	// Forget the amounts. Clearing is the last thing that needs them: the
	// outcome is the second price and the winner's address, and GET_MY_BIDS
	// only ever reads Bidder and Commitment — both of which are already public,
	// the commitment because the contract recorded it.
	//
	// The winner's own bid is the sharpest case. Vickrey means it is never
	// revealed, so an enclave that keeps it holds a secret it can never use and
	// can only leak. This is not tidiness: a TEE's threat model includes its
	// memory being read, and an auction that cleared last week should not still
	// have every losing price sitting in it.
	for i := range r.Openings {
		r.Openings[i].Amount = 0
		r.Openings[i].Nonce = [32]byte{}
	}

	b, _ := json.Marshal(clearAuctionResponse{
		RfqID:         r.ID,
		Winner:        out.Winner,
		ClearingPrice: out.ClearingPrice,
		BidCount:      out.BidCount,
		SetDigest:     hexutil.Encode(out.SetDigest[:]),
	})
	return buildResult(action, df, b, 1, nil)
}

// processGetRfqState is the public read. Size and deadline are public by
// design; the reserve and every bid amount are not.
func (e *Extension) processGetRfqState(action teetypes.Action, df *instruction.DataFixed, msg hexutil.Bytes) teetypes.ActionResult {
	var req clearAuctionRequest // same shape: {rfqId}
	if err := json.Unmarshal(msg, &req); err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding get_rfq_state: %w", err))
	}

	r, err := e.rfqs.get(req.RfqID)
	if err != nil {
		return buildResult(action, df, nil, 0, err)
	}

	e.rfqs.mu.RLock()
	resp := rfqStateResponse{
		RfqID: r.ID, Maker: r.Maker, Pair: r.Pair, Lot: r.Lot,
		Deadline: r.Deadline, BidCount: len(r.Recorded), Cleared: r.Cleared,
	}
	if r.Cleared {
		resp.Winner = r.Outcome.Winner
		resp.ClearingPrice = r.Outcome.ClearingPrice
	}
	e.rfqs.mu.RUnlock()

	b, _ := json.Marshal(resp)
	return buildResult(action, df, b, 1, nil)
}

// processListRfqs returns the public view of every auction, newest first.
// Same disclosure rule as GET_RFQ_STATE: size, deadline, count, outcome —
// never a reserve, never an amount that lost.
func (e *Extension) processListRfqs(action teetypes.Action, df *instruction.DataFixed, _ hexutil.Bytes) teetypes.ActionResult {
	e.rfqs.mu.RLock()
	out := make([]rfqStateResponse, 0, len(e.rfqs.rfqs))
	for _, id := range e.rfqs.idsDescending() {
		r := e.rfqs.rfqs[id]
		item := rfqStateResponse{
			RfqID: r.ID, Maker: r.Maker, Pair: r.Pair, Lot: r.Lot,
			Deadline: r.Deadline, BidCount: len(r.Recorded), Cleared: r.Cleared,
		}
		if r.Cleared {
			item.Winner = r.Outcome.Winner
			item.ClearingPrice = r.Outcome.ClearingPrice
		}
		out = append(out, item)
	}
	e.rfqs.mu.RUnlock()

	b, _ := json.Marshal(out)
	return buildResult(action, df, b, 1, nil)
}

// The chain this desk settles on. Coston2 unless told otherwise — and it is in
// the signed payload, not merely checked, so a signature cannot be moved between
// deployments even by someone who has both.
var bidChainID = func() uint64 {
	if v, err := strconv.ParseUint(os.Getenv("CHAIN_ID"), 10, 64); err == nil && v > 0 {
		return v
	}
	return 114
}()

// bidSigPayload is what the bidder's wallet signs (as a personal_sign over the
// raw 32 bytes):
//
//	keccak256("BUTA_BID" || uint256(chainId) || uint256(rfqId) || commitment)
//
// Binding the rfqId means a signature for one auction cannot be replayed into
// another; binding the commitment means it authorises exactly one sealed bid.
//
// The chain id was missing, and its absence was an asymmetry rather than a hole:
// the enclave's OUTBOUND signature is domain-separated by block.chainid in the
// contract, while the bidder's INBOUND one was not. Not exploitable — replaying
// it elsewhere needs the opening, which is sealed — but "not exploitable today"
// is a weaker property than "cannot be moved", and the second one costs 32 bytes.
func bidSigPayload(rfqID uint64, c auction.Commitment) common.Hash {
	var id [32]byte
	binary.BigEndian.PutUint64(id[24:], rfqID)
	var chain [32]byte
	binary.BigEndian.PutUint64(chain[24:], bidChainID)
	return crypto.Keccak256Hash([]byte("BUTA_BID"), chain[:], id[:], c[:])
}

var errBadBidSig = errors.New("bid signature does not recover to the bidder")

func verifyBidSig(sigHex string, rfqID uint64, c auction.Commitment, addr common.Address) error {
	sig, err := hexutil.Decode(sigHex)
	if err != nil || len(sig) != 65 {
		return errBadBidSig
	}
	// personal_sign wraps the raw payload in the Ethereum message prefix.
	payload := bidSigPayload(rfqID, c)
	ethHash := crypto.Keccak256Hash([]byte("\x19Ethereum Signed Message:\n32"), payload[:])

	v := sig[64]
	if v >= 27 {
		v -= 27
	}
	if v > 1 {
		return errBadBidSig
	}
	sigCopy := make([]byte, 65)
	copy(sigCopy, sig)
	sigCopy[64] = v

	pub, err := crypto.SigToPub(ethHash[:], sigCopy)
	if err != nil {
		return errBadBidSig
	}
	if crypto.PubkeyToAddress(*pub) != addr {
		return errBadBidSig
	}
	return nil
}

// processGetMyBids lists the commitments a bidder placed, across auctions.
// No amounts: the endpoint returns what is already public (the commitment) plus
// the outcome, so a bidder can find their bids without the enclave disclosing
// any number to the wire.
func (e *Extension) processGetMyBids(action teetypes.Action, df *instruction.DataFixed, msg hexutil.Bytes) teetypes.ActionResult {
	var req myBidsRequest
	if err := json.Unmarshal(msg, &req); err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding get_my_bids: %w", err))
	}
	who := strings.ToLower(req.Bidder)

	e.rfqs.mu.RLock()
	out := make([]myBidEntry, 0)
	for _, id := range e.rfqs.idsDescending() {
		r := e.rfqs.rfqs[id]
		for _, b := range r.Openings {
			if b.Bidder != who {
				continue
			}
			out = append(out, myBidEntry{
				RfqID:      r.ID,
				Pair:       r.Pair,
				Commitment: hexutil.Encode(b.Commitment[:]),
				Cleared:    r.Cleared,
				Won:        r.Cleared && r.Outcome.Winner == who,
			})
		}
	}
	e.rfqs.mu.RUnlock()

	b, _ := json.Marshal(out)
	return buildResult(action, df, b, 1, nil)
}
