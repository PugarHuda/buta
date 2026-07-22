package extension

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"extension-scaffold/pkg/auction"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
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
	Invited  string               // direct rail: the only address allowed to bid ("" = open)

	Cleared bool
	Outcome auction.Outcome
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
	Maker    string `json:"maker"`
	Pair     string `json:"pair"`
	Lot      uint64 `json:"lot"`
	Reserve  uint64 `json:"reserve"` // decrypted before it reaches here
	Deadline uint64 `json:"deadline"`
	Invited  string `json:"invited"`
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
	e.rfqs.next++
	id := e.rfqs.next
	e.rfqs.rfqs[id] = &Rfq{
		ID:       id,
		Maker:    strings.ToLower(req.Maker),
		Pair:     req.Pair,
		Lot:      req.Lot,
		Reserve:  req.Reserve,
		Deadline: req.Deadline,
		Invited:  strings.ToLower(req.Invited),
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

	out, err := auction.Clear(r.Recorded, r.Openings, r.Reserve)
	if err != nil {
		return buildResult(action, df, nil, 0, err)
	}
	r.Cleared = true
	r.Outcome = out

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
