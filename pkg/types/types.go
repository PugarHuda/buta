// Package types contains the public request/response types for the Buta
// extension.
//
// Everything an auction keeps secret is deliberately absent. The sealed bid
// openings, the maker's reserve and the losing amounts live in the enclave and
// have no type here, because a type here is a decoding recipe anyone holding
// the registry can run.
package types

import "github.com/ethereum/go-ethereum/common"

// State is the public summary of the desk: counts only. An open auction's
// contents are exactly what must not be readable, so nothing here exposes a
// bid, an amount, or a reserve.
type State struct {
	OpenRfqs    int `json:"openRfqs"`
	ClearedRfqs int `json:"clearedRfqs"`
}

// --- DO NOT MODIFY below this line. ---

// StateResponse is the envelope returned by GET /state.
type StateResponse struct {
	StateVersion common.Hash `json:"stateVersion"`
	State        State       `json:"state"`
}
