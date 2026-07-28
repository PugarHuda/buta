package types

import (
	"testing"

	"buta/pkg/decoder"
)

// TestRegisterDecoders_NoAuctionPayloads is the one that matters: a registered
// decoder for a sealed-auction command would hand anyone holding a registry a
// way to read a bid opening.
func TestRegisterDecoders_NoAuctionPayloads(t *testing.T) {
	r := decoder.NewRegistry()
	RegisterDecoders(r)

	for _, cmd := range []string{"POST_RFQ", "COMMIT_BID", "CLEAR_AUCTION", "GET_MY_BIDS"} {
		for _, kind := range []decoder.DataKind{decoder.KindMessage, decoder.KindResult} {
			if _, err := r.Lookup("BUTA", cmd, kind); err == nil {
				t.Errorf("auction command %s must not have a registered decoder (%v)", cmd, kind)
			}
		}
	}
}

// TestRegisterDecoders_NoOrderbookKeys guards the migration: nothing may remain
// registered under the op type the fork was born with, since dispatch no longer
// accepts it.
func TestRegisterDecoders_NoOrderbookKeys(t *testing.T) {
	r := decoder.NewRegistry()
	RegisterDecoders(r)

	for _, cmd := range []string{"DEPOSIT", "WITHDRAW", "PLACE_ORDER", "GET_BOOK_STATE"} {
		if _, err := r.Lookup("ORDERBOOK", cmd, decoder.KindMessage); err == nil {
			t.Errorf("ORDERBOOK/%s is still registered", cmd)
		}
	}
}
