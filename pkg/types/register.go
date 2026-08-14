package types

import "buta/pkg/decoder"

// RegisterDecoders registers payload decoders for the Buta extension.
//
// It registers nothing, and that is the design.
//
// The fork arrived registering DEPOSIT, WITHDRAW and the CLOB commands under op
// type "ORDERBOOK". Buta answers only the op type "BUTA", so every one of those
// keys had become unreachable - decoders for messages that can no longer
// arrive. The vault they served is gone too: ButaInstructionSender settles
// directly and has no deposit or withdraw function.
//
// What remains are the sealed-auction commands, and those must stay
// unregistered. A decoder is a recipe for turning a payload back into fields;
// handing one out for COMMIT_BID would let anyone holding a registry read a bid
// opening. The enclave decodes them and nothing else does.
//
// If a public, non-secret command is ever added, register it here.
func RegisterDecoders(r *decoder.Registry) {
	_ = r
}
