// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Script, console } from "forge-std/Script.sol";
import { ButaInstructionSender } from "../contracts/ButaInstructionSender.sol";
import { ITeeExtensionRegistry } from "../contracts/interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "../contracts/interfaces/ITeeMachineRegistry.sol";

/// @notice Deploys ButaInstructionSender to Coston2.
///
/// The FlareTeeManager diamond implements BOTH the extension registry and the
/// machine registry, so a single address plays both roles. Use the CURRENT
/// diamond — the old 0x0042… one predates the ExtensionGovernance facet and
/// will fail registration (see docs/DEPLOY.md).
///
/// Run:
///   source .env.deployer
///   forge script script/Deploy.s.sol \
///     --rpc-url $CHAIN_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast
contract Deploy is Script {
    // Current Coston2 FlareTeeManager diamond (2026-07, post-v0.0.22).
    // Override with TEE_MANAGER env if Flare cuts another one.
    address constant DEFAULT_TEE_MANAGER = 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE;

    function run() external {
        address teeManager = vm.envOr("TEE_MANAGER", DEFAULT_TEE_MANAGER);
        address deployer = msg.sender;

        require(teeManager.code.length > 0, "TEE manager has no code on this chain");

        address[] memory admins = new address[](1);
        admins[0] = deployer;

        vm.startBroadcast();
        ButaInstructionSender buta = new ButaInstructionSender(
            ITeeExtensionRegistry(teeManager),
            ITeeMachineRegistry(teeManager),
            admins
        );
        vm.stopBroadcast();

        console.log("ButaInstructionSender:", address(buta));
        console.log("  tee manager:", teeManager);
        console.log("  admin/deployer:", deployer);
        console.log("Next: register the extension, then setExtensionId(), then setTeeAddress().");
    }
}
