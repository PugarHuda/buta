package orderbook

import (
	"container/list"

	rbt "github.com/emirpasic/gods/v2/trees/redblacktree"
)

// orderLocation tracks where an order lives in the price-level tree.
type orderLocation struct {
	price   uint64
	element *list.Element
}

// OrderSide holds one side of the order book (bids or asks).
// priceLevels maps price → *list.List of *Order, ordered by the provided comparator.
// orders maps orderID → orderLocation for O(1) lookup and removal.
type OrderSide struct {
	priceLevels *rbt.Tree[uint64, *list.List]
	orders      map[string]*orderLocation
	volume      uint64
	count       int
}

// newOrderSide creates an OrderSide.
// descending=true for bids (highest price first), false for asks (lowest price first).
func newOrderSide(descending bool) *OrderSide {
	var cmp func(a, b uint64) int
	if descending {
		cmp = func(a, b uint64) int {
			switch {
			case a > b:
				return -1 // higher price is "less" so it sorts first
			case a < b:
				return 1
			default:
				return 0
			}
		}
	} else {
		cmp = func(a, b uint64) int {
			switch {
			case a < b:
				return -1 // lower price is "less" so it sorts first
			case a > b:
				return 1
			default:
				return 0
			}
		}
	}

	return &OrderSide{
		priceLevels: rbt.NewWith[uint64, *list.List](cmp),
		orders:      make(map[string]*orderLocation),
	}
}

// Add places order at the back of its price-level queue.
func (s *OrderSide) Add(order *Order) {
	queue, found := s.priceLevels.Get(order.Price)
	if !found {
		queue = list.New()
		s.priceLevels.Put(order.Price, queue)
	}
	elem := queue.PushBack(order)
	s.orders[order.ID] = &orderLocation{price: order.Price, element: elem}
	s.volume += order.Remaining
	s.count++
}

// Remove removes order by ID, returns it, or returns nil if not found.
func (s *OrderSide) Remove(orderID string) *Order {
	loc, ok := s.orders[orderID]
	if !ok {
		return nil
	}

	queue, found := s.priceLevels.Get(loc.price)
	if !found {
		return nil
	}

	order := queue.Remove(loc.element).(*Order)
	delete(s.orders, orderID)
	s.volume -= order.Remaining
	s.count--

	// Clean up empty price levels.
	if queue.Len() == 0 {
		s.priceLevels.Remove(loc.price)
	}

	return order
}

// BestPrice returns the price, queue, and ok for the best price level (root of tree).
func (s *OrderSide) BestPrice() (uint64, *list.List, bool) {
	if s.priceLevels.Empty() {
		return 0, nil, false
	}
	node := s.priceLevels.Left()
	return node.Key, node.Value, true
}

// Has reports whether an order with the given ID exists on this side.
func (s *OrderSide) Has(orderID string) bool {
	_, ok := s.orders[orderID]
	return ok
}

// Depth returns aggregated PriceLevels in tree order (best first).
func (s *OrderSide) Depth() []PriceLevel {
	levels := make([]PriceLevel, 0, s.priceLevels.Size())
	it := s.priceLevels.Iterator()
	for it.Next() {
		queue := it.Value()
		pl := PriceLevel{
			Price:      it.Key(),
			OrderCount: queue.Len(),
		}
		for e := queue.Front(); e != nil; e = e.Next() {
			pl.Quantity += e.Value.(*Order).Remaining
		}
		levels = append(levels, pl)
	}
	return levels
}

// Len returns the total number of orders on this side.
func (s *OrderSide) Len() int {
	return s.count
}

// LevelCount returns the number of distinct price levels on this side.
func (s *OrderSide) LevelCount() int {
	return s.priceLevels.Size()
}

// EvictWorstLevel removes the entire worst-priced level (lowest bid / highest ask)
// and returns the orders that were on it. Returns nil if the side is empty.
func (s *OrderSide) EvictWorstLevel() []*Order {
	if s.priceLevels.Empty() {
		return nil
	}
	node := s.priceLevels.Right()
	queue := node.Value
	price := node.Key

	evicted := make([]*Order, 0, queue.Len())
	for e := queue.Front(); e != nil; e = e.Next() {
		o := e.Value.(*Order)
		evicted = append(evicted, o)
		delete(s.orders, o.ID)
		s.volume -= o.Remaining
		s.count--
	}
	s.priceLevels.Remove(price)
	return evicted
}

// GetOrder returns a pointer to the resting order with the given ID, or nil.
func (s *OrderSide) GetOrder(orderID string) *Order {
	loc, ok := s.orders[orderID]
	if !ok {
		return nil
	}
	queue, found := s.priceLevels.Get(loc.price)
	if !found {
		return nil
	}
	_ = queue
	return loc.element.Value.(*Order)
}
