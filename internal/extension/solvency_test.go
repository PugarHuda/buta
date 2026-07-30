package extension

import (
	"context"
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// fakeFunds answers from a table instead of a chain.
type fakeFunds struct {
	token    common.Address
	tokenErr error
	broke    map[string]bool
	failFor  map[string]bool // addresses whose read blows up
	asked    []uint64        // prices the screen was asked about
}

func (f *fakeFunds) SettleToken(context.Context, uint64) (common.Address, error) {
	return f.token, f.tokenErr
}

func (f *fakeFunds) CanSettle(_ context.Context, _, owner, _ common.Address, amount *big.Int) (bool, error) {
	f.asked = append(f.asked, amount.Uint64())
	key := owner.Hex()
	if f.failFor[key] {
		return false, errors.New("rpc timeout")
	}
	return !f.broke[key], nil
}

func addr(b byte) common.Address {
	var a common.Address
	a[19] = b
	return a
}

func withFunds(f Funds) *Extension {
	e := newAuctionExtension()
	e.SetFunds(f, addr(0xFF))
	return e
}

func TestScreenIsOffWhenNoReaderIsWired(t *testing.T) {
	e := newAuctionExtension()
	if e.solvencyScreen(1) != nil {
		t.Fatal("an enclave with no chain access must not screen anybody")
	}
}

// An enclave that cannot even learn the token must clear normally rather than
// deciding nobody can pay.
func TestScreenIsOffWhenTheTokenCannotBeRead(t *testing.T) {
	e := withFunds(&fakeFunds{tokenErr: errors.New("no rpc")})
	if e.solvencyScreen(1) != nil {
		t.Fatal("a failed token read must disable the screen, not refuse every bid")
	}
	e2 := withFunds(&fakeFunds{}) // zero token address
	if e2.solvencyScreen(1) != nil {
		t.Fatal("a zero settle token must disable the screen")
	}
}

func TestScreenPassesAndFailsBidders(t *testing.T) {
	f := &fakeFunds{token: addr(0x0b), broke: map[string]bool{addr(0x22).Hex(): true}}
	screen := withFunds(f).solvencyScreen(1)
	if screen == nil {
		t.Fatal("screen should be active")
	}
	if !screen(addr(0x11).Hex(), 5000) {
		t.Error("a funded bidder was rejected")
	}
	if screen(addr(0x22).Hex(), 5000) {
		t.Error("an unfunded bidder was accepted")
	}
	if len(f.asked) != 2 || f.asked[0] != 5000 {
		t.Errorf("screen asked about %v, want the price owed", f.asked)
	}
}

// The property that keeps this from being an attack surface. If a failed read
// disqualified a bidder, anyone who could degrade our RPC could knock out the
// top bid and pick the winner. A timeout proves nothing, so it proves nothing.
func TestAFailedReadAllowsRatherThanDisqualifies(t *testing.T) {
	f := &fakeFunds{token: addr(0x0b), failFor: map[string]bool{addr(0x33).Hex(): true}}
	screen := withFunds(f).solvencyScreen(1)
	if !screen(addr(0x33).Hex(), 5000) {
		t.Fatal("an RPC failure disqualified a bidder — that hands the auction to whoever can break our RPC")
	}
}
