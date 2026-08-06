package extension

// Instructions that actually travelled on-chain arrive as the bytes the
// contract produced with abi.encode. The handlers speak JSON, because that is
// what the desk posts to /action on the direct path.
//
// Nothing converted between the two. The two halves of this product had never
// met: the contract is deployed and the enclave works, and an instruction that
// went through the chain would have been handed to json.Unmarshal and rejected
// as "invalid character". It was invisible because no TEE machine is registered
// for our extension, so no instruction has ever been delivered.
//
// This is the bridge, and it is testable without a machine: encode with the
// same layout ButaInstructionSender uses, and check the handler accepts it.

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

func mustType(t string) abi.Type {
	ty, err := abi.NewType(t, "", nil)
	if err != nil {
		panic("bad abi type " + t + ": " + err.Error())
	}
	return ty
}

// Layouts mirror ButaInstructionSender._sendInstruction call sites exactly. A
// change on either side has to change both, which is what the tests pin.
var (
	// abi.encode(rfqId, msg.sender, lot, deadlineBlock, invited, encryptedReserve)
	postRfqArgs = abi.Arguments{
		{Type: mustType("uint256")}, {Type: mustType("address")}, {Type: mustType("uint256")},
		{Type: mustType("uint64")}, {Type: mustType("address")}, {Type: mustType("bytes")},
	}
	// abi.encode(rfqId, msg.sender, commitment, ciphertext)
	commitBidArgs = abi.Arguments{
		{Type: mustType("uint256")}, {Type: mustType("address")},
		{Type: mustType("bytes32")}, {Type: mustType("bytes")},
	}
	// abi.encode(rfqId)
	clearAuctionArgs = abi.Arguments{{Type: mustType("uint256")}}
)

// u64 narrows a contract uint256 that cannot legitimately exceed 64 bits.
// Truncating silently would turn a nonsense lot into a plausible one.
func u64(v *big.Int, what string) (uint64, error) {
	if !v.IsUint64() {
		return 0, fmt.Errorf("%s %s does not fit in uint64", what, v)
	}
	return v.Uint64(), nil
}

// decodePostRfq turns the contract's payload into the JSON the handler expects.
//
// The reserve arrives as an ECIES envelope: on this path the enclave is the one
// that opens it, because there is no desk in between to hand over a plaintext.
func decodePostRfq(payload []byte, d Decryptor) ([]byte, error) {
	vals, err := postRfqArgs.Unpack(payload)
	if err != nil {
		return nil, fmt.Errorf("decoding post_rfq payload: %w", err)
	}
	rfqID, err := u64(vals[0].(*big.Int), "rfqId")
	if err != nil {
		return nil, err
	}
	lot, err := u64(vals[2].(*big.Int), "lot")
	if err != nil {
		return nil, err
	}

	req := postRfqRequest{
		RfqID:    rfqID,
		Maker:    vals[1].(common.Address).Hex(),
		Lot:      lot,
		Deadline: vals[3].(uint64),
	}
	// address(0) means open to anyone; the handler reads "" as open, and
	// lowercasing the zero address instead would invite exactly one bidder,
	// nobody.
	if invited := vals[4].(common.Address); invited != (common.Address{}) {
		req.Invited = invited.Hex()
	}

	if sealed := vals[5].([]byte); len(sealed) > 0 {
		if d == nil {
			return nil, fmt.Errorf("no decryptor: cannot open the sealed reserve")
		}
		plain, err := d.Decrypt(sealed)
		if err != nil {
			return nil, fmt.Errorf("opening sealed reserve: %w", err)
		}
		var body struct {
			Reserve uint64 `json:"reserve"`
			Pair    string `json:"pair"`
		}
		if err := json.Unmarshal(plain, &body); err != nil {
			return nil, fmt.Errorf("malformed reserve: %w", err)
		}
		req.Reserve, req.Pair = body.Reserve, body.Pair
	}
	// A reserve of zero is legitimate — it means "any bid clears" — so its
	// absence is not an error here. Clear() floors a lone bidder at it either
	// way.

	return json.Marshal(req)
}

func decodeCommitBid(payload []byte) ([]byte, error) {
	vals, err := commitBidArgs.Unpack(payload)
	if err != nil {
		return nil, fmt.Errorf("decoding commit_bid payload: %w", err)
	}
	rfqID, err := u64(vals[0].(*big.Int), "rfqId")
	if err != nil {
		return nil, err
	}
	commitment := vals[2].([32]byte)

	// The opening stays sealed: the handler decrypts it, which keeps the amount
	// inside the one function that is allowed to see it.
	return json.Marshal(commitBidRequest{
		RfqID:      rfqID,
		Bidder:     vals[1].(common.Address).Hex(),
		Commitment: hexutil.Encode(commitment[:]),
		Ciphertext: hexutil.Encode(vals[3].([]byte)),
	})
}

func decodeClearAuction(payload []byte) ([]byte, error) {
	vals, err := clearAuctionArgs.Unpack(payload)
	if err != nil {
		return nil, fmt.Errorf("decoding clear_auction payload: %w", err)
	}
	rfqID, err := u64(vals[0].(*big.Int), "rfqId")
	if err != nil {
		return nil, err
	}
	return json.Marshal(clearAuctionRequest{RfqID: rfqID})
}

// clearingResultData is the exact bytes ButaInstructionSender.relayClearing
// rebuilds before it hashes them:
//
//	abi.encode(uint256 rfqId, address winner, uint256 clearingPrice, bytes32 setDigest)
//
// The node signs the result data as-is, and the contract never sees those bytes
// — it reconstructs them. So this encoding IS the interface between the two, and
// a drift makes every honest clearing unverifiable rather than making a forged
// one pass, which is the safe direction but a silent one.
func clearingResultData(rfqID uint64, winner string, price uint64, digest [32]byte) ([]byte, error) {
	return clearingResultArgs.Pack(
		new(big.Int).SetUint64(rfqID),
		common.HexToAddress(winner),
		new(big.Int).SetUint64(price),
		digest,
	)
}

var clearingResultArgs = abi.Arguments{
	{Type: mustType("uint256")}, // rfqId
	{Type: mustType("address")}, // winner
	{Type: mustType("uint256")}, // clearingPrice
	{Type: mustType("bytes32")}, // setDigest
}

// decodeClearingResultData reads back what clearingResultData produced. Only
// tests need this — the contract does its own decoding — but a round trip is
// the cheapest proof that the encoding is what the contract expects.
func decodeClearingResultData(b []byte) (rfqID uint64, winner string, price uint64, digest [32]byte, err error) {
	vals, err := clearingResultArgs.Unpack(b)
	if err != nil {
		return 0, "", 0, [32]byte{}, err
	}
	return vals[0].(*big.Int).Uint64(),
		strings.ToLower(vals[1].(common.Address).Hex()),
		vals[2].(*big.Int).Uint64(),
		vals[3].([32]byte),
		nil
}
