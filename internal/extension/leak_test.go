package extension

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"buta/internal/config"

	teetypes "github.com/flare-foundation/tee-node/pkg/types"
)

// The product's whole claim in one test: nothing a caller can ask for ever
// contains a bid amount or the maker's reserve.
//
// Individual handlers were checked one at a time, which meant the invariant was
// only as good as someone remembering to check the next handler. This drives
// EVERY command through the router against a populated auction and searches all
// of the bytes that come back. A new read path is covered the day it is added
// to the list; a handler that starts returning *Rfq fails here rather than in
// production.
//
// The numbers are deliberately odd. Round ones collide with lot sizes,
// deadlines and block numbers, and a check that cannot tell a leak from a
// coincidence is a check that will be silenced the first time it cries wolf.
//
// And the search happens on the DECODED result. ActionResult.Data is
// hexutil.Bytes, so it comes back as "0x7b2272..." — searching the raw response
// for a decimal number finds nothing whatever the enclave put in there. The
// first version of this test did exactly that and would have passed against a
// handler returning every bid in the book.
const (
	secretReserve = 118_273_645 // below every bid, or nothing clears and the sweep proves nothing
	aliceBid      = 771_133_557
	bobBid        = 662_244_886
	carolBid      = 553_355_779
)

func TestNoCommandEverReturnsABidAmount(t *testing.T) {
	config.AllowDirectAuctionOps = true
	t.Cleanup(func() { config.AllowDirectAuctionOps = false })

	e := newAuctionExtension()
	alice, bob, carol := newBidder(t, 1), newBidder(t, 2), newBidder(t, 3)

	id := post(t, e, postRfqRequest{
		Maker: "0xMAKER", Pair: "FXRP/USDT0", Lot: 480_000,
		Reserve: secretReserve, Deadline: 24_109_880,
	})
	commit(t, e, id, alice, 11, aliceBid)
	commit(t, e, id, bob, 12, bobBid)
	commit(t, e, id, carol, 13, carolBid)

	secrets := map[string]int{
		"the reserve": secretReserve,
		"alice's bid": aliceBid,
		"bob's bid":   bobBid,
		"carol's bid": carolBid,
	}

	// Every command, in both states: sealed, then cleared. Clearing is when the
	// enclave has just held all four numbers at once, so it is the moment a leak
	// is most likely.
	// Everything a caller can see: the decoded result data plus the log line,
	// which is the other place a number reaches the outside.
	visible := func(t *testing.T, body []byte) string {
		t.Helper()
		var ar teetypes.ActionResult
		if err := json.Unmarshal(body, &ar); err != nil {
			return string(body)
		}
		return string(ar.Data) + " " + ar.Log
	}

	sweep := func(stage string, secrets map[string]int) {
		t.Helper()
		for _, c := range []struct {
			command string
			payload any
		}{
			{config.OPCommandListRfqs, map[string]any{}},
			{config.OPCommandGetRfqState, map[string]any{"rfqId": id}},
			{config.OPCommandGetMyBids, map[string]any{"bidder": alice.hex()}},
			{config.OPCommandGetMyBids, map[string]any{"bidder": bob.hex()}},
			{config.OPCommandGetMyBids, map[string]any{"bidder": carol.hex()}},
			// The maker asking about their own auction must not get the reserve
			// back either — they know it, but the response is not private to
			// them, and a field that is populated for one caller is populated
			// for all of them.
			{config.OPCommandGetMyBids, map[string]any{"bidder": "0xMAKER"}},
		} {
			code, body := e.processAction(directAction(c.command, c.payload))
			if code != 200 {
				t.Fatalf("%s/%s returned %d: %s", stage, c.command, code, body)
			}
			seen := visible(t, body)
			for name, n := range secrets {
				if strings.Contains(seen, strconv.Itoa(n)) {
					t.Errorf("%s: %s leaked %s (%d)\n  %s", stage, c.command, name, n, body)
				}
			}
		}
	}

	sweep("sealed", secrets)

	clearBody, _ := json.Marshal(clearAuctionRequest{RfqID: id})
	code, body := e.processAction(directAction(config.OPCommandClearAuction, json.RawMessage(clearBody)))
	if code != 200 {
		t.Fatalf("clear returned %d: %s", code, body)
	}
	// The clearing response itself. It carries the second price, which is
	// public — but the winner's own bid never is, and neither is the reserve.
	cleared := visible(t, body)
	for _, name := range []string{"the reserve", "alice's bid"} {
		if strings.Contains(cleared, strconv.Itoa(secrets[name])) {
			t.Errorf("the clearing response leaked %s\n  %s", name, cleared)
		}
	}
	// And the premise: the second price IS in there, so a handler that returned
	// an empty body could not pass this test by saying nothing at all.
	if !strings.Contains(cleared, strconv.Itoa(bobBid)) {
		t.Fatalf("the clearing price is not the runner-up's bid — this test proves nothing: %s", cleared)
	}

	// After clearing, bob's number is public — it IS the clearing price, which is
	// what a second-price auction pays. That is the mechanism working, not a
	// leak, and the distinction is the whole point: the runner-up's bid becomes
	// a price, and every other bid stays sealed forever, the winner's included.
	delete(secrets, "bob's bid")
	sweep("cleared", secrets)
}
