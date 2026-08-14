package extension

import (
	"testing"

	"buta/internal/config"

	"github.com/ethereum/go-ethereum/common"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
)

// The op-type gate is one line and it decides whether an instruction is ours at
// all. It is also the line that broke the desk once already: the frontend
// defaulted to "ORDERBOOK", which this rejects, and nothing caught it because
// only dead code used the default.
func TestOnlyButaInstructionsAreAccepted(t *testing.T) {
	if !supportedOPType(teeutils.ToHash(config.OPTypeButa)) {
		t.Fatal("BUTA is not accepted - nothing would ever be processed")
	}

	// ORDERBOOK is the one that matters: the fork's op type, which several
	// call sites defaulted to long after the order book was deleted.
	for _, other := range []string{"ORDERBOOK", "VRF", "F_GET", "buta", "BUTA "} {
		if supportedOPType(teeutils.ToHash(other)) {
			t.Errorf("%q was accepted as our op type", other)
		}
	}
	if supportedOPType(common.Hash{}) {
		t.Error("the zero hash was accepted - an unset op type must not route anywhere")
	}
}

// bytes32("BUTA") in Solidity is left-aligned and zero-padded. If Go and
// Solidity ever disagree about that, every on-chain instruction is rejected as
// an unsupported op type, and the message says nothing about padding.
func TestOpTypeMatchesTheSolidityConstant(t *testing.T) {
	got := teeutils.ToHash(config.OPTypeButa)
	// 0x42555441 = "BUTA", then zeros to 32 bytes.
	want := common.HexToHash("0x4255544100000000000000000000000000000000000000000000000000000000")
	if got != want {
		t.Fatalf("OP_TYPE_BUTA = %s, Solidity's bytes32(\"BUTA\") = %s", got.Hex(), want.Hex())
	}
}

// Same for the three commands. These are the strings the contract hashes; a
// rename on either side silently stops routing rather than failing loudly.
func TestOpCommandsMatchTheContract(t *testing.T) {
	for name, want := range map[string]string{
		config.OPCommandPostRfq:      "0x504f53545f52465100000000000000000000000000000000000000000000000000"[:66],
		config.OPCommandCommitBid:    "0x434f4d4d49545f42494400000000000000000000000000000000000000000000",
		config.OPCommandClearAuction: "0x434c4541525f41554354494f4e000000000000000000000000000000000000000"[:66],
	} {
		if got := teeutils.ToHash(name); got != common.HexToHash(want) {
			t.Errorf("%s hashes to %s, contract expects %s", name, got.Hex(), want)
		}
	}
}
