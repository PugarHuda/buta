// Package types contains request/response types for the orderbook extension.
package types

import (
	"extension-scaffold/pkg/balance"
	"extension-scaffold/pkg/orderbook"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

// --- Deposit (on-chain instruction) ---

type DepositRequest struct {
	Token  common.Address `json:"token"`
	Amount uint64         `json:"amount"`
}

type DepositResponse struct {
	Token     common.Address `json:"token"`
	Amount    uint64         `json:"amount"`
	Available uint64         `json:"available"`
}

// --- Withdraw (on-chain instruction) ---

type WithdrawRequest struct {
	Token   common.Address `json:"token"`
	Amount  uint64         `json:"amount"`
	Address common.Address `json:"address"`
}

type WithdrawResponse struct {
	Token        common.Address `json:"token"`
	Amount       uint64         `json:"amount"`
	To           common.Address `json:"to"`
	WithdrawalID common.Hash    `json:"withdrawalId"`
	Signature    hexutil.Bytes  `json:"signature"`
	Available    uint64         `json:"available"`
}

// --- Place Order (direct instruction) ---

type PlaceOrderRequest struct {
	Sender   string              `json:"sender"`
	Pair     string              `json:"pair"`
	Side     orderbook.Side      `json:"side"`
	Type     orderbook.OrderType `json:"type"`
	Price    uint64              `json:"price"`
	Quantity uint64              `json:"quantity"`
}

type PlaceOrderResponse struct {
	OrderID   string            `json:"orderId"`
	Status    string            `json:"status"` // "filled", "partial", "resting"
	Matches   []orderbook.Match `json:"matches,omitempty"`
	Remaining uint64            `json:"remaining"`
}

// --- Cancel Order (direct instruction) ---

type CancelOrderRequest struct {
	Sender  string `json:"sender"`
	OrderID string `json:"orderId"`
}

type CancelOrderResponse struct {
	OrderID   string `json:"orderId"`
	Pair      string `json:"pair"`
	Side      string `json:"side"`
	Remaining uint64 `json:"remaining"`
}

// --- Get My State (direct instruction) ---

type GetMyStateRequest struct {
	Sender string `json:"sender"`
}

type GetMyStateResponse struct {
	Balances   map[common.Address]balance.TokenBalance `json:"balances"`
	OpenOrders []orderbook.Order                       `json:"openOrders"`
	Matches    []orderbook.Match                       `json:"matches"`
}

// --- Get Book State (direct instruction) ---
// Public orderbook depth + (optional) recent matches scoped to a single pair.
// Pair: when set, response includes the most recent matches for that pair.
// MatchLimit: cap on returned matches; default DefaultBookMatchLimit, max ring capacity.

type GetBookStateRequest struct {
	Sender     string `json:"sender,omitempty"`
	Pair       string `json:"pair,omitempty"`
	MatchLimit int    `json:"matchLimit,omitempty"`
}

// --- Get Candles (direct instruction) ---

type GetCandlesRequest struct {
	Sender    string `json:"sender,omitempty"`
	Pair      string `json:"pair"`
	Timeframe string `json:"timeframe"`
	Limit     int    `json:"limit,omitempty"`
}

type GetCandlesResponse struct {
	Pair      string             `json:"pair"`
	Timeframe string             `json:"timeframe"`
	Candles   []orderbook.Candle `json:"candles"`
}

// --- Export History (direct instruction) ---

type ExportHistoryRequest struct {
	Sender     string `json:"sender"`
	TargetUser string `json:"targetUser,omitempty"` // admin only
}

type ExportHistoryResponse struct {
	User        string                                  `json:"user"`
	Balances    map[common.Address]balance.TokenBalance  `json:"balances"`
	Orders      []orderbook.Order                       `json:"orders"`
	Matches     []orderbook.Match                       `json:"matches"`
	Deposits    []DepositRecord                         `json:"deposits"`
	Withdrawals []WithdrawalRecord                      `json:"withdrawals"`
}

type DepositRecord struct {
	Token     common.Address `json:"token"`
	Amount    uint64         `json:"amount"`
	Timestamp int64          `json:"timestamp"`
}

type WithdrawalRecord struct {
	Token     common.Address `json:"token"`
	Amount    uint64         `json:"amount"`
	Address   common.Address `json:"address"`
	Timestamp int64          `json:"timestamp"`
}

// --- State (returned by GET_BOOK_STATE) ---

type State struct {
	Pairs      map[string]PairState `json:"pairs"`
	MatchCount int                  `json:"matchCount"`
	Matches    []orderbook.Match    `json:"matches,omitempty"`
}

type PairState struct {
	Bids []orderbook.PriceLevel `json:"bids"`
	Asks []orderbook.PriceLevel `json:"asks"`
}

// --- DO NOT MODIFY below this line. ---

// StateResponse is the envelope returned by GET /state.
type StateResponse struct {
	StateVersion common.Hash `json:"stateVersion"`
	State        State       `json:"state"`
}
