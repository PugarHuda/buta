package extension

import (
	"encoding/json"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// These encode exactly what ButaInstructionSender._sendInstruction encodes, and
// then check the enclave accepts it. Until this file existed, the on-chain
// payload went straight into json.Unmarshal — every real instruction would have
// been rejected, and no test could see it because no TEE machine is registered
// to deliver one.

type fixedDecryptor struct{ plain []byte }

func (f fixedDecryptor) Decrypt([]byte) ([]byte, error) { return f.plain, nil }

func TestDecodePostRfqMatchesTheContractEncoding(t *testing.T) {
	maker := common.HexToAddress("0x100158159dD923E6009a1eD56fB2e8b2347aF42f")
	invited := common.HexToAddress("0xDcDD7547EdA881b675B58c11922aF4A726cCb01B")
	sealed := []byte{0xDE, 0xAD}

	payload, err := postRfqArgs.Pack(big.NewInt(4211), maker, big.NewInt(250_000), uint64(9_000_000), invited, sealed)
	if err != nil {
		t.Fatal(err)
	}

	out, err := decodePostRfq(payload, fixedDecryptor{[]byte(`{"reserve":5000,"pair":"FXRP/USD"}`)})
	if err != nil {
		t.Fatalf("decodePostRfq: %v", err)
	}
	var got postRfqRequest
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got.RfqID != 4211 {
		t.Errorf("rfqId = %d, want 4211", got.RfqID)
	}
	if !strings.EqualFold(got.Maker, maker.Hex()) {
		t.Errorf("maker = %q, want %s", got.Maker, maker.Hex())
	}
	if got.Lot != 250_000 || got.Deadline != 9_000_000 {
		t.Errorf("lot/deadline = %d/%d, want 250000/9000000", got.Lot, got.Deadline)
	}
	if !strings.EqualFold(got.Invited, invited.Hex()) {
		t.Errorf("invited = %q, want %s", got.Invited, invited.Hex())
	}
	if got.Reserve != 5000 || got.Pair != "FXRP/USD" {
		t.Errorf("reserve/pair = %d/%q, want 5000/FXRP/USD — the sealed reserve was not opened", got.Reserve, got.Pair)
	}
}

// address(0) is the contract's "open to anyone". Passing it through as a
// lowercase zero address would invite exactly one bidder: nobody.
func TestOpenAuctionHasNoInvitedCounterparty(t *testing.T) {
	payload, err := postRfqArgs.Pack(big.NewInt(1), common.Address{}, big.NewInt(1), uint64(2), common.Address{}, []byte{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := decodePostRfq(payload, nil)
	if err != nil {
		t.Fatalf("decodePostRfq: %v", err)
	}
	var got postRfqRequest
	_ = json.Unmarshal(out, &got)
	if got.Invited != "" {
		t.Errorf("invited = %q, want empty", got.Invited)
	}
}

// A sealed reserve with no decryptor must fail loudly rather than clear the
// auction at a reserve of zero.
func TestSealedReserveWithoutADecryptorIsRefused(t *testing.T) {
	payload, _ := postRfqArgs.Pack(big.NewInt(1), common.Address{}, big.NewInt(1), uint64(2), common.Address{}, []byte{0x01})
	if _, err := decodePostRfq(payload, nil); err == nil {
		t.Fatal("a sealed reserve was silently treated as zero")
	}
}

func TestDecodeCommitBidKeepsTheOpeningSealed(t *testing.T) {
	bidder := common.HexToAddress("0xDcDD7547EdA881b675B58c11922aF4A726cCb01B")
	var commitment [32]byte
	commitment[0], commitment[31] = 0xAB, 0xCD
	ct := []byte{0x01, 0x02, 0x03}

	payload, err := commitBidArgs.Pack(big.NewInt(7), bidder, commitment, ct)
	if err != nil {
		t.Fatal(err)
	}
	out, err := decodeCommitBid(payload)
	if err != nil {
		t.Fatalf("decodeCommitBid: %v", err)
	}
	var got commitBidRequest
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got.RfqID != 7 || !strings.EqualFold(got.Bidder, bidder.Hex()) {
		t.Errorf("rfqId/bidder = %d/%s", got.RfqID, got.Bidder)
	}
	if got.Commitment != "0xab000000000000000000000000000000000000000000000000000000000000cd" {
		t.Errorf("commitment = %s", got.Commitment)
	}
	if got.Ciphertext != "0x010203" {
		t.Errorf("ciphertext = %s", got.Ciphertext)
	}
	// The amount must NOT be filled here — the handler opens the envelope, so
	// the plaintext exists in exactly one place.
	if got.Amount != 0 || got.Nonce != "" || got.Sig != "" {
		t.Errorf("the decoder filled opening fields it should never see: %+v", got)
	}
}

func TestDecodeClearAuction(t *testing.T) {
	payload, _ := clearAuctionArgs.Pack(big.NewInt(4211))
	out, err := decodeClearAuction(payload)
	if err != nil {
		t.Fatalf("decodeClearAuction: %v", err)
	}
	var got clearAuctionRequest
	_ = json.Unmarshal(out, &got)
	if got.RfqID != 4211 {
		t.Errorf("rfqId = %d, want 4211", got.RfqID)
	}
}

// A uint256 that cannot be a real lot must not be truncated into a plausible
// one — silently keeping the low 64 bits is how an absurd value becomes a
// believable one.
func TestOversizedValuesAreRefusedNotTruncated(t *testing.T) {
	huge := new(big.Int).Lsh(big.NewInt(1), 200)
	payload, _ := postRfqArgs.Pack(big.NewInt(1), common.Address{}, huge, uint64(2), common.Address{}, []byte{})
	if _, err := decodePostRfq(payload, nil); err == nil {
		t.Fatal("an oversized lot was accepted")
	}

	payload2, _ := clearAuctionArgs.Pack(huge)
	if _, err := decodeClearAuction(payload2); err == nil {
		t.Fatal("an oversized rfqId was accepted")
	}
}

func TestGarbagePayloadIsRejected(t *testing.T) {
	if _, err := decodeCommitBid([]byte("not abi encoded at all")); err == nil {
		t.Fatal("garbage decoded successfully")
	}
}

// End to end on the on-chain shape: the contract's bytes go in, and the handler
// stores an auction under the contract's own id.
func TestOnChainPostRfqReachesTheStore(t *testing.T) {
	e := newAuctionExtension()
	payload, _ := postRfqArgs.Pack(
		big.NewInt(4211), common.HexToAddress("0x1001"), big.NewInt(250_000),
		uint64(9_000_000), common.Address{}, []byte{},
	)
	msg, err := decodePostRfq(payload, nil)
	if err != nil {
		t.Fatal(err)
	}
	if id := post(t, e, mustReq(t, msg)); id != 4211 {
		t.Fatalf("id = %d, want 4211", id)
	}
}

func mustReq(t *testing.T, msg []byte) postRfqRequest {
	t.Helper()
	var r postRfqRequest
	if err := json.Unmarshal(msg, &r); err != nil {
		t.Fatal(err)
	}
	return r
}
