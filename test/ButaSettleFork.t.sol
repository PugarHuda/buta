// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { ButaInstructionSender } from "../contracts/ButaInstructionSender.sol";
import { MockToken, MockExtensionRegistry, MockMachineRegistry } from "./ButaClearing.t.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function symbol() external view returns (string memory);
}

/// The settlement leg, against the real FXRP.
///
/// Every other test in this repo settles against a mock we wrote, which means
/// they prove the desk's own logic and nothing about the asset it moves.
/// FTestXRP is a FAsset: its transfer path is not ours, it can be paused, and it
/// could carry hooks. This forks Coston2 and runs the clearing against the
/// deployed token, with balances taken from a real holder rather than conjured.
///
///   FORK=1 forge test --match-path test/ButaSettleFork.t.sol
///
/// Skipped without FORK=1, so the suite still runs offline. The public-chain
/// path needs a registered TEE machine — getRandomTeeIds reverts for our
/// extension today — which is exactly why the leg is proven here instead.
contract ButaSettleForkTest is Test {
    // AssetManagerFXRP.fAsset() on Coston2
    address internal constant FXRP = 0x0b6A3645c240605887a5532109323A3E12273dc7;
    // our deployer, which holds FTestXRP minted through the TagRail checkout
    address internal constant HOLDER = 0x100158159dD923E6009a1eD56fB2e8b2347aF42f;

    ButaInstructionSender internal buta;
    MockToken internal lot;

    uint256 internal constant TEE_PK = 0xA11CE;
    address internal tee;
    address internal maker = address(0x1001);
    address internal winner = address(0x2002);

    uint256 internal constant LOT = 1_000e18;
    uint256 internal constant CLEARING = 2_500_000; // 2.5 FTestXRP, 6 decimals

    uint256 internal rfqId;
    uint64 internal deadline;
    uint256 internal chainId;

    function setUp() public {
        if (vm.envOr("FORK", uint256(0)) == 0) return;
        vm.createSelectFork(vm.envOr("COSTON2_RPC", string("https://coston2-api.flare.network/ext/C/rpc")));
        chainId = block.chainid;

        MockExtensionRegistry extReg = new MockExtensionRegistry();
        MockMachineRegistry machReg = new MockMachineRegistry();
        lot = new MockToken();

        address[] memory admins = new address[](1);
        admins[0] = address(this);
        tee = vm.addr(TEE_PK);
        buta = new ButaInstructionSender(extReg, machReg, admins);
        extReg.setSender(address(buta));
        buta.setExtensionId();
        buta.setTeeAddress(tee);

        // Real FXRP, moved from a real holder. No deal(), so this also fails if
        // the token ever stops allowing ordinary transfers.
        require(IERC20(FXRP).balanceOf(HOLDER) >= CLEARING, "holder is out of FTestXRP - top up from the faucet");
        vm.prank(HOLDER);
        IERC20(FXRP).transfer(winner, CLEARING);

        lot.mint(maker, LOT);
        vm.prank(maker);
        lot.approve(address(buta), type(uint256).max);

        deadline = uint64(block.number + 100);
        vm.prank(maker);
        rfqId = buta.postRfq(FXRP, address(lot), LOT, deadline, address(0), hex"c0ffee");

        vm.prank(winner);
        buta.commitBid(rfqId, keccak256("winner"), hex"beef");
        vm.roll(block.number + 101);
    }

    function _sign(address who, uint256 price, bytes32 digest, bytes32 actionId)
        internal view returns (bytes memory)
    {
        bytes memory resultData = abi.encode(rfqId, who, price, digest);
        bytes32 resultHash = keccak256(
            abi.encodePacked(keccak256(resultData), actionId, keccak256(bytes("tag")), uint8(1))
        );
        bytes32 payloadHash = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), chainId, resultHash));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(TEE_PK, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_ClearingMovesRealFXRP() public {
        vm.skip(vm.envOr("FORK", uint256(0)) == 0);

        vm.prank(winner);
        IERC20(FXRP).approve(address(buta), CLEARING);

        uint256 makerBefore = IERC20(FXRP).balanceOf(maker);
        uint256 winnerBefore = IERC20(FXRP).balanceOf(winner);

        bytes32 digest = buta.commitmentDigest(rfqId);
        buta.relayClearing(rfqId, winner, CLEARING, digest, bytes32("f1"), "tag", 1, _sign(winner, CLEARING, digest, bytes32("f1")));

        assertEq(IERC20(FXRP).balanceOf(maker), makerBefore + CLEARING, "maker paid in real FTestXRP");
        assertEq(IERC20(FXRP).balanceOf(winner), winnerBefore - CLEARING, "winner debited exactly the clearing price");
        assertEq(lot.balanceOf(winner), LOT, "and the lot was delivered");
    }

    function test_RealFXRPAlsoRequiresApproval() public {
        vm.skip(vm.envOr("FORK", uint256(0)) == 0);

        // no approve() — the FAsset's own allowance check has to stop this, not ours
        bytes32 digest = buta.commitmentDigest(rfqId);
        vm.expectRevert();
        buta.relayClearing(rfqId, winner, CLEARING, digest, bytes32("f2"), "tag", 1, _sign(winner, CLEARING, digest, bytes32("f2")));

        assertEq(lot.balanceOf(winner), 0, "no delivery without payment");
    }
}
