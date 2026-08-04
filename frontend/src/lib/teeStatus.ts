/**
 * Is a TEE machine registered and in production for our extension?
 *
 * The masthead conflated two different facts. "EXTENSION OFFLINE" means *this
 * browser cannot reach a proxy*, which on the deployed desk is always true —
 * there is no public one. It does not mean the extension is unregistered, and
 * since 31 July it has not: a machine is registered and PRODUCTION, and the
 * diamond will say so to anyone who asks.
 *
 * Reading it here costs one eth_call against a public RPC, needs no wallet, and
 * separates "I cannot reach the backend" from "there is no backend".
 */
import { createPublicClient, http, parseAbi } from "viem";
import { coston2 } from "../config/chain";

const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const EXTENSION_ID = 65642n;

const ABI = parseAbi([
  "function getRandomTeeIds(uint256,uint256) view returns (address[])",
]);

export type TeeStatus =
  | { state: "production"; machine: `0x${string}` }
  | { state: "none" }
  | { state: "unknown" };

/**
 * `getRandomTeeIds` reverts `TooMany()` when no machine is active, which is the
 * same call `_sendInstruction` makes on every postRfq — so this is not a proxy
 * for the answer, it is the answer.
 */
export async function readTeeStatus(): Promise<TeeStatus> {
  try {
    const pc = createPublicClient({ chain: coston2, transport: http() });
    const ids = await pc.readContract({
      address: DIAMOND,
      abi: ABI,
      functionName: "getRandomTeeIds",
      args: [EXTENSION_ID, 1n],
    });
    return ids.length ? { state: "production", machine: ids[0] } : { state: "none" };
  } catch {
    // A revert means no active machine. A network failure means we do not know,
    // and saying "none" would be a claim rather than a reading — the two are
    // indistinguishable from here, so the honest answer is the weaker one.
    return { state: "unknown" };
  }
}
