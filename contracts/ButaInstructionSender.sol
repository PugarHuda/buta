// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ITeeExtensionRegistry } from "./interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title ButaInstructionSender
/// @notice Sealed-bid OTC desk. The chain records which bids exist; the enclave
///         decides what they mean. Neither side can do the other's job.
///
/// The load-bearing idea is `_commitments`. Every sealed bid appends a 32-byte
/// commitment here, on-chain, before anyone knows what is inside it. At
/// settlement the enclave signs over a digest of THAT set. A caller who hands
/// the enclave a subset — the classic way to suppress the Vickrey uplift, since
/// the winner then clears at its own ask — produces a digest this contract will
/// not accept. Trimming stops being a policy promise and becomes an arithmetic
/// impossibility.
///
/// DO NOT MODIFY: constructor, setExtensionId(), _getExtensionId()
contract ButaInstructionSender {
    /// @notice Public extension ids are assigned from here upward; everything
    ///         below is reserved for system extensions.
    uint256 public constant FIRST_PUBLIC_EXTENSION_ID = 0x10000;

    // Must match internal/config/config.go byte for byte. A mismatch surfaces
    // inside the enclave as "unsupported op type".
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_BUTA = bytes32("BUTA");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_POST_RFQ = bytes32("POST_RFQ");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_COMMIT_BID = bytes32("COMMIT_BID");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_CLEAR_AUCTION = bytes32("CLEAR_AUCTION");

    /// @notice Domain separator for TEE result signatures. Without it a
    ///         signature over one action could be replayed as another.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant TEE_ACTION_RESULT = bytes32("TEE_ACTION_RESULT");

    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    uint256 private _extensionId;

    /// @notice TEE node address: the only authorised signer of clearings.
    address public teeAddress;
    bool public teeAddressSet;

    address[] public admins;

    struct Rfq {
        address maker;
        address settleToken;   // FXRP
        address lotToken;      // delivered to the winner
        uint256 lot;
        uint64  deadlineBlock; // a block, never a wall clock
        address invited;       // direct rail; address(0) = open to anyone
        bool    cleared;
        address winner;
        uint256 clearingPrice;
    }

    uint256 public rfqCount;
    mapping(uint256 => Rfq) public rfqs;

    /// @notice The clearing set, in acceptance order. This is the whole point.
    mapping(uint256 => bytes32[]) private _commitments;
    mapping(uint256 => mapping(bytes32 => bool)) public committed;
    mapping(uint256 => mapping(address => bool)) public hasBid;

    mapping(bytes32 => bool) public usedActionIds;

    event RfqPosted(uint256 indexed rfqId, address indexed maker, uint256 lot, uint64 deadlineBlock);
    event BidCommitted(uint256 indexed rfqId, address indexed bidder, bytes32 commitment, uint256 index);
    event AuctionCleared(uint256 indexed rfqId, address indexed winner, uint256 clearingPrice, bytes32 setDigest);

    error NotAdmin();
    error TeeAlreadySet();
    error ZeroAddress();
    error DeadlinePassed();
    error DeadlineNotReached();
    error AlreadyCleared();
    error NotInvited();
    error DuplicateCommitment();
    error AlreadyBid();
    error BadTeeSignature();
    error ActionReplayed();
    error SetDigestMismatch();

    modifier onlyAdmin() {
        bool ok;
        for (uint256 i = 0; i < admins.length; i++) {
            if (admins[i] == msg.sender) { ok = true; break; }
        }
        if (!ok) revert NotAdmin();
        _;
    }

    constructor(
        ITeeExtensionRegistry _teeExtensionRegistry,
        ITeeMachineRegistry _teeMachineRegistry,
        address[] memory _admins
    ) {
        require(address(_teeExtensionRegistry) != address(0), "TeeExtensionRegistry cannot be zero address");
        require(address(_teeMachineRegistry) != address(0), "TeeMachineRegistry cannot be zero address");
        require(address(_teeExtensionRegistry).code.length > 0, "TeeExtensionRegistry has no code");
        require(address(_teeMachineRegistry).code.length > 0, "TeeMachineRegistry has no code");
        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
        admins = _admins;
    }

    // --- Setup -------------------------------------------------------------

    /// DO NOT MODIFY this function.
    function setExtensionId() external {
        require(_extensionId == 0, "Extension ID already set.");
        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert("Extension ID not found.");
    }

    function setTeeAddress(address _teeAddress) external onlyAdmin {
        if (teeAddressSet) revert TeeAlreadySet();
        if (_teeAddress == address(0)) revert ZeroAddress();
        teeAddress = _teeAddress;
        teeAddressSet = true;
    }

    // --- Maker -------------------------------------------------------------

    /// @notice Open a sealed auction and escrow the lot the winner will receive.
    /// @param encryptedReserve ECIES ciphertext of the maker's hidden floor,
    ///        readable only inside the enclave.
    /// @param invited address(0) for an open auction, or the single
    ///        counterparty allowed to bid on the direct rail.
    function postRfq(
        address settleToken,
        address lotToken,
        uint256 lot,
        uint64  deadlineBlock,
        address invited,
        bytes calldata encryptedReserve
    ) external payable returns (uint256 rfqId) {
        if (lot == 0) revert ZeroAddress();
        if (deadlineBlock <= block.number) revert DeadlinePassed();

        require(IERC20(lotToken).transferFrom(msg.sender, address(this), lot), "lot transferFrom failed");

        rfqId = ++rfqCount;
        rfqs[rfqId] = Rfq({
            maker: msg.sender,
            settleToken: settleToken,
            lotToken: lotToken,
            lot: lot,
            deadlineBlock: deadlineBlock,
            invited: invited,
            cleared: false,
            winner: address(0),
            clearingPrice: 0
        });

        _sendInstruction(
            OP_COMMAND_POST_RFQ,
            abi.encode(rfqId, msg.sender, lot, deadlineBlock, invited, encryptedReserve)
        );
        emit RfqPosted(rfqId, msg.sender, lot, deadlineBlock);
    }

    // --- Bidder ------------------------------------------------------------

    /// @notice Seal a bid. The commitment lands on-chain; the amount does not.
    /// @param commitment 32 bytes binding the bid. Recorded here so the
    ///        clearing set is fixed before anyone can read it.
    /// @param ciphertext ECIES payload the enclave decrypts.
    function commitBid(
        uint256 rfqId,
        bytes32 commitment,
        bytes calldata ciphertext
    ) external payable {
        Rfq storage r = rfqs[rfqId];
        if (r.maker == address(0)) revert ZeroAddress();
        if (r.cleared) revert AlreadyCleared();
        if (block.number > r.deadlineBlock) revert DeadlinePassed();
        if (r.invited != address(0) && r.invited != msg.sender) revert NotInvited();
        if (committed[rfqId][commitment]) revert DuplicateCommitment();
        if (hasBid[rfqId][msg.sender]) revert AlreadyBid();

        committed[rfqId][commitment] = true;
        hasBid[rfqId][msg.sender] = true;
        _commitments[rfqId].push(commitment);

        _sendInstruction(
            OP_COMMAND_COMMIT_BID,
            abi.encode(rfqId, msg.sender, commitment, ciphertext)
        );
        emit BidCommitted(rfqId, msg.sender, commitment, _commitments[rfqId].length - 1);
    }

    // --- Clearing ----------------------------------------------------------

    /// @notice Ask the enclave to clear. Anyone may call after the deadline;
    ///         liveness should not depend on the maker showing up.
    function requestClearing(uint256 rfqId) external payable {
        Rfq storage r = rfqs[rfqId];
        if (r.maker == address(0)) revert ZeroAddress();
        if (r.cleared) revert AlreadyCleared();
        if (block.number <= r.deadlineBlock) revert DeadlineNotReached();

        _sendInstruction(OP_COMMAND_CLEAR_AUCTION, abi.encode(rfqId));
    }

    /// @notice Relay the enclave's signed outcome and settle.
    ///
    /// Two checks carry the security. The signature must recover to the
    /// registered TEE address, and `setDigest` must equal the digest of the
    /// commitments THIS contract recorded. A clearing computed over any other
    /// set fails the second check even with a perfectly valid signature.
    function relayClearing(
        uint256 rfqId,
        address winner,
        uint256 clearingPrice,
        bytes32 setDigest,
        bytes32 actionId,
        string calldata submissionTag,
        uint8 status,
        bytes calldata signature
    ) external {
        Rfq storage r = rfqs[rfqId];
        if (r.maker == address(0)) revert ZeroAddress();
        if (r.cleared) revert AlreadyCleared();
        if (usedActionIds[actionId]) revert ActionReplayed();
        if (status != 1) revert BadTeeSignature();
        if (setDigest != commitmentDigest(rfqId)) revert SetDigestMismatch();

        bytes memory resultData = abi.encode(rfqId, winner, clearingPrice, setDigest);
        bytes32 resultHash = keccak256(
            abi.encodePacked(keccak256(resultData), actionId, keccak256(bytes(submissionTag)), status)
        );
        bytes32 payloadHash = keccak256(abi.encode(TEE_ACTION_RESULT, block.chainid, resultHash));
        if (_recover(_ethSigned(payloadHash), signature) != teeAddress) revert BadTeeSignature();

        usedActionIds[actionId] = true;
        r.cleared = true;
        r.winner = winner;
        r.clearingPrice = clearingPrice;

        // Delivery versus payment. The winner pays the SECOND price, not their
        // own bid, which is the reason nobody had to shade.
        require(
            IERC20(r.settleToken).transferFrom(winner, r.maker, clearingPrice),
            "settlement transferFrom failed"
        );
        require(IERC20(r.lotToken).transfer(winner, r.lot), "lot transfer failed");

        emit AuctionCleared(rfqId, winner, clearingPrice, setDigest);
    }

    // --- Views -------------------------------------------------------------

    function commitmentsOf(uint256 rfqId) external view returns (bytes32[] memory) {
        return _commitments[rfqId];
    }

    function bidCount(uint256 rfqId) external view returns (uint256) {
        return _commitments[rfqId].length;
    }

    /// @notice Order-independent fold of the recorded set.
    /// @dev ponytail: XOR fold, matching pkg/auction.digest. Cheap and enough to
    ///      bind the set for a demo, but NOT collision resistant — two different
    ///      sets can fold to the same value. Replace both sides with keccak over
    ///      the sorted commitments before this touches real money.
    function commitmentDigest(uint256 rfqId) public view returns (bytes32 out) {
        bytes32[] storage cs = _commitments[rfqId];
        for (uint256 i = 0; i < cs.length; i++) {
            out ^= cs[i];
        }
    }

    // --- Internals ---------------------------------------------------------

    function _getExtensionId() internal view returns (uint256) {
        require(_extensionId != 0, "Extension ID not set.");
        return _extensionId;
    }

    function _sendInstruction(bytes32 opCommand, bytes memory message) internal {
        uint256 extensionId = _getExtensionId();
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(extensionId, 1);
        TEE_EXTENSION_REGISTRY.sendInstructions{ value: msg.value }(
            teeIds,
            ITeeExtensionRegistry.TeeInstructionParams({
                opType: OP_TYPE_BUTA,
                opCommand: opCommand,
                message: message,
                cosigners: new address[](0),
                cosignersThreshold: 0,
                claimBackAddress: msg.sender
            })
        );
    }

    function _ethSigned(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    function _recover(bytes32 digest_, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest_, v, r, s);
    }
}
