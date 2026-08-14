// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { ButaInstructionSender } from "../contracts/ButaInstructionSender.sol";
import { ITeeExtensionRegistry } from "../contracts/interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "../contracts/interfaces/ITeeMachineRegistry.sol";

// The whole security of this desk sits in relayClearing. Everything else can be
// re-run; a bad clearing moves money. These tests exist to make the two
// load-bearing checks fail loudly if anyone loosens them:
//
//   1. the signature must recover to the registered TEE address, and
//   2. setDigest must match the commitments THIS contract recorded.
//
// Check 2 is the one that turns "the auctioneer could award a subset" into a
// transaction that reverts.

/// Enforces allowances, because the real FXRP does. An earlier version of this
/// mock let `transferFrom` move anyone's balance without approval, which made
/// every test pass while hiding the fact that a winner who has not approved the
/// desk cannot be settled against at all.
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(balanceOf[from] >= amt, "insufficient");
        uint256 a = allowance[from][msg.sender];
        require(a >= amt, "insufficient allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amt;
        balanceOf[from] -= amt; balanceOf[to] += amt; return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "insufficient");
        balanceOf[msg.sender] -= amt; balanceOf[to] += amt; return true;
    }
}

contract MockExtensionRegistry is ITeeExtensionRegistry {
    address public sender;
    function setSender(address s) external { sender = s; }
    function nextPublicExtensionId() external pure returns (uint256) { return 0x10001; }
    function getTeeExtensionInstructionsSender(uint256) external view returns (address) { return sender; }
    function sendInstructions(address[] calldata, TeeInstructionParams calldata)
        external payable returns (bytes32) { return bytes32(0); }
}

contract MockMachineRegistry is ITeeMachineRegistry {
    /// Machines are PRODUCTION here unless a test says otherwise, so the status
    /// gate stays invisible to every test that is not about it.
    mapping(address => uint8) private _status;
    mapping(address => bool) private _set;

    function setStatus(address teeId, uint8 s) external { _status[teeId] = s; _set[teeId] = true; }

    function getRandomTeeIds(uint256, uint256) external pure returns (address[] memory ids) {
        ids = new address[](1);
        ids[0] = address(0xBEEF);
    }

    function getTeeMachineStatus(address teeId) external view returns (uint8) {
        return _set[teeId] ? _status[teeId] : 2;
    }
}

contract ButaClearingTest is Test {
    ButaInstructionSender internal buta;
    MockExtensionRegistry internal extReg;
    MockMachineRegistry internal machReg;
    MockToken internal fxrp;   // settlement
    MockToken internal lot;    // delivered

    uint256 internal constant TEE_PK = 0xA11CE;
    address internal tee;

    address internal maker  = address(0x1001);
    address internal alice  = address(0x2001);
    address internal bob    = address(0x2002);
    address internal carol  = address(0x2003);

    uint256 internal constant LOT = 250_000e6;
    uint64  internal deadline;
    uint256 internal rfqId;

    function setUp() public {
        tee = vm.addr(TEE_PK);

        extReg  = new MockExtensionRegistry();
        machReg = new MockMachineRegistry();
        fxrp    = new MockToken();
        lot     = new MockToken();

        address[] memory admins = new address[](1);
        admins[0] = address(this);
        buta = new ButaInstructionSender(extReg, machReg, admins);

        extReg.setSender(address(buta));
        buta.setExtensionId();
        buta.setTeeAddress(tee);

        lot.mint(maker, LOT + 1_000); // spare lots for the extra RFQs some tests open
        fxrp.mint(bob, 1_000_000e6);

        // Both legs of the settlement are pulls, so both sides have to approve
        // the desk first - the maker to escrow the lot, the winner to be
        // charged the clearing price. Nothing about the desk can hide that.
        vm.prank(maker); lot.approve(address(buta), type(uint256).max);
        vm.prank(bob);   fxrp.approve(address(buta), type(uint256).max);

        deadline = uint64(block.number + 100);

        vm.prank(maker);
        rfqId = buta.postRfq(address(fxrp), address(lot), LOT, deadline, address(0), hex"c0ffee");

        _commit(alice, keccak256("alice"));
        _commit(bob,   keccak256("bob"));
        _commit(carol, keccak256("carol"));

        vm.roll(block.number + 101);
    }

    function _commit(address who, bytes32 c) internal {
        vm.prank(who);
        buta.commitBid(rfqId, c, hex"beef");
    }

    /// Signs exactly what the enclave signs: the domain-separated payload over
    /// the action result hash. If this drifts from the contract, every test
    /// below fails, which is the point.
    function _sign(
        uint256 pk,
        uint256 id,
        address winner,
        uint256 price,
        bytes32 setDigest,
        bytes32 actionId,
        string memory tag,
        uint8 status
    ) internal pure returns (bytes memory) {
        bytes memory resultData = abi.encode(id, winner, price, setDigest);
        bytes32 resultHash = keccak256(
            abi.encodePacked(keccak256(resultData), actionId, keccak256(bytes(tag)), status)
        );
        bytes32 payloadHash = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), uint256(31337), resultHash));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethSigned);
        return abi.encodePacked(r, s, v);
    }

    // ── happy path ──────────────────────────────────────────────────────────

    function test_RelayClearingSettlesAtSecondPrice() public {
        bytes32 digest = buta.commitmentDigest(rfqId);
        uint256 clearing = 5218e4; // the runner-up's bid, not the winner's

        bytes memory sig = _sign(TEE_PK, rfqId, bob, clearing, digest, bytes32("a1"), "tag", 1);
        buta.relayClearing(rfqId, bob, clearing, digest, bytes32("a1"), "tag", 1, sig);

        assertEq(lot.balanceOf(bob), LOT, "winner receives the lot");
        assertEq(fxrp.balanceOf(maker), clearing, "maker is paid the clearing price");
    }

    /// A winner who can pay but never approved the desk cannot be settled
    /// against - and the whole clearing reverts rather than half-executing, so
    /// the lot does not leave the escrow either. Delivery versus payment means
    /// neither leg lands alone.
    function test_SettlementRevertsWhenWinnerHasNotApproved() public {
        fxrp.mint(alice, 1_000_000e6); // she has the money, just not the allowance
        bytes32 digest = buta.commitmentDigest(rfqId);
        uint256 clearing = 5218e4;

        bytes memory sig = _sign(TEE_PK, rfqId, alice, clearing, digest, bytes32("a2"), "tag", 1);
        vm.expectRevert(bytes("insufficient allowance"));
        buta.relayClearing(rfqId, alice, clearing, digest, bytes32("a2"), "tag", 1, sig);

        assertEq(lot.balanceOf(address(buta)), LOT, "lot stays escrowed");
        assertEq(lot.balanceOf(alice), 0, "no delivery without payment");
        assertEq(fxrp.balanceOf(maker), 0, "and no payment");
    }

    /// The allowance has to cover the clearing price, not the bid. A winner who
    /// approved exactly what they bid is short whenever the second price is
    /// higher than they expected - the desk cannot paper over that.
    function test_SettlementRevertsOnPartialApproval() public {
        uint256 clearing = 5218e4;
        vm.prank(bob);
        fxrp.approve(address(buta), clearing - 1);

        bytes32 digest = buta.commitmentDigest(rfqId);
        bytes memory sig = _sign(TEE_PK, rfqId, bob, clearing, digest, bytes32("a3"), "tag", 1);
        vm.expectRevert(bytes("insufficient allowance"));
        buta.relayClearing(rfqId, bob, clearing, digest, bytes32("a3"), "tag", 1, sig);
    }

    /// What a maker can actually do when the winner turns out to be broke.
    ///
    /// The clearing reverts whole, so nothing is half-done - but the auction is
    /// also stuck: this signed outcome can never be relayed. The maker is not
    /// trapped, because the revert also rolled back `cleared`, so reclaimLot
    /// still works and the lot comes home. What is lost is the sale: the
    /// runner-up who could have paid gets nothing.
    ///
    /// This is why solvency screening belongs in the enclave, where bid amounts
    /// already live. Documented as a test rather than a comment so the
    /// behaviour is pinned.
    function test_UnfundedWinnerStrandsTheSaleButNotTheLot() public {
        bytes32 digest = buta.commitmentDigest(rfqId);
        uint256 clearing = 5218e4;

        // alice wins on paper and cannot pay
        bytes memory sig = _sign(TEE_PK, rfqId, alice, clearing, digest, bytes32("a4"), "tag", 1);
        vm.expectRevert();
        buta.relayClearing(rfqId, alice, clearing, digest, bytes32("a4"), "tag", 1, sig);

        // the auction is still open as far as the contract is concerned
        (, , , , , , bool cleared, , ) = buta.rfqs(rfqId);
        assertFalse(cleared, "the revert rolled the clearing back");

        // so the maker gets the lot back rather than losing it to a bidder who
        // never paid - but bob, who was good for it, was never awarded anything
        uint256 before = lot.balanceOf(maker);
        buta.reclaimLot(rfqId);
        assertEq(lot.balanceOf(maker), before + LOT, "maker reclaims the lot");
        assertEq(lot.balanceOf(bob), 0, "the runner-up got nothing");
    }

    /// The same action id cannot be reused after a failed settlement - the
    /// revert rolled back `usedActionIds` too, so the enclave's outcome is
    /// replayable if the winner later funds themselves. That is the desirable
    /// half of the same rollback.
    function test_AFailedSettlementCanBeRetriedOnceTheWinnerFunds() public {
        bytes32 digest = buta.commitmentDigest(rfqId);
        uint256 clearing = 5218e4;
        bytes memory sig = _sign(TEE_PK, rfqId, alice, clearing, digest, bytes32("a5"), "tag", 1);

        vm.expectRevert();
        buta.relayClearing(rfqId, alice, clearing, digest, bytes32("a5"), "tag", 1, sig);

        // alice funds and approves, and the very same signed outcome settles
        fxrp.mint(alice, clearing);
        vm.prank(alice);
        fxrp.approve(address(buta), clearing);
        buta.relayClearing(rfqId, alice, clearing, digest, bytes32("a5"), "tag", 1, sig);

        assertEq(lot.balanceOf(alice), LOT, "the lot is delivered on the retry");
        assertEq(fxrp.balanceOf(maker), clearing, "and the maker is paid");
    }

    // ── the attack this contract exists to stop ─────────────────────────────

    function test_RelayClearingRejectsTrimmedSet() public {
        // Digest of a subset: drop carol, so the "winner" clears lower.
        bytes32 trimmed = keccak256("alice") ^ keccak256("bob");
        uint256 clearing = 1;

        bytes memory sig = _sign(TEE_PK, rfqId, bob, clearing, trimmed, bytes32("a2"), "tag", 1);
        vm.expectRevert(ButaInstructionSender.SetDigestMismatch.selector);
        buta.relayClearing(rfqId, bob, clearing, trimmed, bytes32("a2"), "tag", 1, sig);
    }

    // ── signature checks ────────────────────────────────────────────────────

    function test_RelayClearingRejectsForeignSigner() public {
        bytes32 digest = buta.commitmentDigest(rfqId);
        bytes memory sig = _sign(0xBADBAD, rfqId, bob, 5218e4, digest, bytes32("a3"), "tag", 1);
        vm.expectRevert(ButaInstructionSender.BadTeeSignature.selector);
        buta.relayClearing(rfqId, bob, 5218e4, digest, bytes32("a3"), "tag", 1, sig);
    }

    // ── the enclave the desk trusts is allowed to change ─────────────────────

    /// The reason this test exists: `tee-node` mints a new signing key on every
    /// start and never persists it, so the enclave a deployment was pinned to is
    /// gone the first time the container restarts. When the setter could only run
    /// once, that made settlement permanently impossible - a live contract with
    /// three settled auctions behind it and no fourth one available, ever.
    function test_TeeAddressRotatesAndTheOldEnclaveStopsSettling() public {
        uint256 newPk = 0xB0B5EC;
        address newTee = vm.addr(newPk);
        machReg.setStatus(newTee, 2); // the diamond attested it

        buta.setTeeAddress(newTee);
        assertEq(buta.teeAddress(), newTee, "the desk follows the live machine");

        bytes32 digest = buta.commitmentDigest(rfqId);

        // The key that used to be trusted is now just a key.
        bytes memory stale = _sign(TEE_PK, rfqId, bob, 5218e4, digest, bytes32("r1"), "tag", 1);
        vm.expectRevert(ButaInstructionSender.BadTeeSignature.selector);
        buta.relayClearing(rfqId, bob, 5218e4, digest, bytes32("r1"), "tag", 1, stale);

        bytes memory fresh = _sign(newPk, rfqId, bob, 5218e4, digest, bytes32("r2"), "tag", 1);
        buta.relayClearing(rfqId, bob, 5218e4, digest, bytes32("r2"), "tag", 1, fresh);
        assertEq(lot.balanceOf(bob), LOT, "the auction settles under the new enclave");
    }

    /// Rotation is only safe because the argument has to be a machine the diamond
    /// says is PRODUCTION. Without this, an admin key could point the desk at any
    /// address at all and sign its own clearings.
    function test_TeeAddressRejectsAMachineTheDiamondHasNotAttested() public {
        address notAMachine = address(0xDEAD);
        machReg.setStatus(notAMachine, 1); // INITIALIZED, never reached production
        vm.expectRevert(ButaInstructionSender.MachineNotInProduction.selector);
        buta.setTeeAddress(notAMachine);

        machReg.setStatus(notAMachine, 4); // and a paused one is not a live one
        vm.expectRevert(ButaInstructionSender.MachineNotInProduction.selector);
        buta.setTeeAddress(notAMachine);

        assertEq(buta.teeAddress(), tee, "a refused rotation leaves the desk where it was");
    }

    function test_TeeAddressIsAdminOnly() public {
        address newTee = vm.addr(0xB0B5EC);
        machReg.setStatus(newTee, 2);
        vm.prank(alice);
        vm.expectRevert(ButaInstructionSender.NotAdmin.selector);
        buta.setTeeAddress(newTee);
    }

    /// A valid signature over one outcome must not be reusable for a different
    /// winner or price.
    function test_RelayClearingRejectsTamperedOutcome() public {
        bytes32 digest = buta.commitmentDigest(rfqId);
        bytes memory sig = _sign(TEE_PK, rfqId, bob, 5218e4, digest, bytes32("a4"), "tag", 1);

        vm.expectRevert(ButaInstructionSender.BadTeeSignature.selector);
        buta.relayClearing(rfqId, alice, 5218e4, digest, bytes32("a4"), "tag", 1, sig);

        vm.expectRevert(ButaInstructionSender.BadTeeSignature.selector);
        buta.relayClearing(rfqId, bob, 1, digest, bytes32("a4"), "tag", 1, sig);
    }

    function test_RelayClearingRejectsNonSuccessStatus() public {
        bytes32 digest = buta.commitmentDigest(rfqId);
        bytes memory sig = _sign(TEE_PK, rfqId, bob, 5218e4, digest, bytes32("a5"), "tag", 0);
        vm.expectRevert(ButaInstructionSender.BadTeeSignature.selector);
        buta.relayClearing(rfqId, bob, 5218e4, digest, bytes32("a5"), "tag", 0, sig);
    }

    function test_RelayClearingRejectsReplay() public {
        bytes32 digest = buta.commitmentDigest(rfqId);
        uint256 clearing = 5218e4;
        bytes memory sig = _sign(TEE_PK, rfqId, bob, clearing, digest, bytes32("a6"), "tag", 1);

        buta.relayClearing(rfqId, bob, clearing, digest, bytes32("a6"), "tag", 1, sig);
        vm.expectRevert(ButaInstructionSender.AlreadyCleared.selector);
        buta.relayClearing(rfqId, bob, clearing, digest, bytes32("a6"), "tag", 1, sig);
    }

    // ── bidding rules ───────────────────────────────────────────────────────

    function test_CommitBidRejectsDuplicateCommitment() public {
        vm.roll(block.number - 101); // back inside the window
        vm.prank(address(0x9999));
        vm.expectRevert(ButaInstructionSender.DuplicateCommitment.selector);
        buta.commitBid(rfqId, keccak256("alice"), hex"beef");
    }

    function test_CommitBidRejectsSecondBidFromSameAddress() public {
        vm.roll(block.number - 101);
        vm.prank(alice);
        vm.expectRevert(ButaInstructionSender.AlreadyBid.selector);
        buta.commitBid(rfqId, keccak256("alice-again"), hex"beef");
    }

    function test_CommitBidRejectsAfterDeadline() public {
        vm.prank(address(0x9999));
        vm.expectRevert(ButaInstructionSender.DeadlinePassed.selector);
        buta.commitBid(rfqId, keccak256("late"), hex"beef");
    }

    function test_DirectRailRejectsUninvitedBidder() public {
        vm.prank(maker);
        uint256 direct = buta.postRfq(
            address(fxrp), address(lot), 1, uint64(block.number + 50), alice, hex"c0ffee"
        );
        vm.prank(bob);
        vm.expectRevert(ButaInstructionSender.NotInvited.selector);
        buta.commitBid(direct, keccak256("bob-direct"), hex"beef");
    }

    function test_RequestClearingRejectsBeforeDeadline() public {
        vm.prank(maker);
        uint256 open = buta.postRfq(
            address(fxrp), address(lot), 1, uint64(block.number + 50), address(0), hex"c0ffee"
        );
        vm.expectRevert(ButaInstructionSender.DeadlineNotReached.selector);
        buta.requestClearing(open);
    }

    /// Pinned to the exact vector pkg/auction's TestDigestCrossLanguageVector
    /// pins (computed independently with viem). A drift on either side fails.
    function test_CommitmentDigestMatchesCrossLanguageVector() public view {
        bytes32 d = buta.commitmentDigest(rfqId);
        assertEq(
            d,
            bytes32(0xfe920ed06a5a02cd2a78548c40b9b76e355331fc61c0e14bff27319febdb8a03),
            "digest must match the Go/viem vector"
        );
    }

    /// Same commitments, different insertion order, different RFQ - same digest.
    function test_CommitmentDigestIsOrderIndependent() public {
        vm.roll(block.number - 101);
        vm.prank(maker);
        uint256 other = buta.postRfq(
            address(fxrp), address(lot), 1, uint64(block.number + 50), address(0), hex"c0ffee"
        );
        vm.prank(carol); buta.commitBid(other, keccak256("carol"), hex"beef");
        vm.prank(alice); buta.commitBid(other, keccak256("alice"), hex"beef");
        vm.prank(bob);   buta.commitBid(other, keccak256("bob"), hex"beef");
        assertEq(buta.commitmentDigest(other), buta.commitmentDigest(rfqId));
    }

    function test_ReclaimLotRefundsMakerWhenUnsold() public {
        // fresh RFQ, no bids, deadline passed
        vm.roll(block.number - 101);
        vm.prank(maker);
        uint256 empty = buta.postRfq(
            address(fxrp), address(lot), 500, uint64(block.number + 10), address(0), hex"c0ffee"
        );
        uint256 makerBefore = lot.balanceOf(maker);
        // escrowed 500 above; setUp left ~1000 spare
        vm.roll(block.number + 11);

        buta.reclaimLot(empty); // anyone may call
        assertEq(lot.balanceOf(maker), makerBefore + 500, "maker gets the lot back");

        // and it cannot be reclaimed twice, nor cleared afterwards
        vm.expectRevert(ButaInstructionSender.AlreadyCleared.selector);
        buta.reclaimLot(empty);
    }

    function test_ReclaimLotRejectedBeforeDeadline() public {
        vm.roll(block.number - 101);
        vm.prank(maker);
        uint256 live = buta.postRfq(
            address(fxrp), address(lot), 1, uint64(block.number + 50), address(0), hex"c0ffee"
        );
        vm.expectRevert(ButaInstructionSender.DeadlineNotReached.selector);
        buta.reclaimLot(live);
    }
}