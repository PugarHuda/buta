package orderbook

import "errors"

type Side string

const (
	Buy  Side = "buy"
	Sell Side = "sell"
)

type OrderType string

const (
	Limit  OrderType = "limit"
	Market OrderType = "market"
)

type Order struct {
	ID        string    `json:"id"`
	Owner     string    `json:"owner"`
	Pair      string    `json:"pair"`
	Side      Side      `json:"side"`
	Type      OrderType `json:"type"`
	Price     uint64    `json:"price"`
	Quantity  uint64    `json:"quantity"`
	Remaining uint64    `json:"remaining"`
	Timestamp int64     `json:"timestamp"`
}

type Match struct {
	BuyOrderID  string `json:"buyOrderId"`
	SellOrderID string `json:"sellOrderId"`
	BuyOwner    string `json:"buyOwner"`
	SellOwner   string `json:"sellOwner"`
	Pair        string `json:"pair"`
	Price       uint64 `json:"price"`
	Quantity    uint64 `json:"quantity"`
	Timestamp   int64  `json:"timestamp"`
}

type PriceLevel struct {
	Price      uint64 `json:"price"`
	Quantity   uint64 `json:"quantity"`
	OrderCount int    `json:"orderCount"`
}

var (
	ErrOrderNotFound   = errors.New("order not found")
	ErrNotOwner        = errors.New("not the order owner")
	ErrNoLiquidity     = errors.New("no liquidity available")
	ErrInvalidPrice    = errors.New("price must be greater than zero")
	ErrInvalidQuantity = errors.New("quantity must be greater than zero")
	ErrInvalidSide     = errors.New("invalid order side")
	ErrInvalidType     = errors.New("invalid order type")
	ErrInvalidPair     = errors.New("unknown trading pair")
)
