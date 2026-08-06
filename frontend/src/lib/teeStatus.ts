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
import { createPublicClient, hexToBytes, http, parseAbi, type Address } from "viem";
import { coston2 } from "../config/chain";

const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const EXTENSION_ID = 65642n;

const ABI = parseAbi([
  "function getRandomTeeIds(uint256,uint256) view returns (address[])",
  "function getPublicKey(address) view returns ((bytes32 x, bytes32 y))",
]);

/**
 * The enclave's public key, read from the diamond.
 *
 * This used to come from the operator's own `GET /info`, which is the one place
 * it must not come from. A bid opening is ECIES-encrypted to that key; an
 * operator who answers with a key of their own reads every bid amount and every
 * reserve, and the whole confidentiality claim is gone. Nothing about the
 * ciphertext would look wrong, and the commitment still binds — so the desk
 * would keep working perfectly while the operator read the book.
 *
 * The diamond has the key the machine registered with, and the operator cannot
 * edit it. That is where it comes from now.
 *
 * If the chain cannot be read, this returns null and the caller refuses to
 * seal: a bid encrypted to a key nobody could verify is worse than no bid.
 */
/**
 * Which contract is the instruction sender for our extension, asked of the
 * diamond rather than written down.
 *
 * It was a constant, and it went stale the moment the contract was redeployed —
 * silently, because a wrong address does not throw, it just makes every
 * transaction revert against a contract that is no longer bound to anything.
 * The desk carried the FIRST of four deployments while three later ones were
 * live. The diamond is the authority on this and answers in one eth_call.
 */
export async function instructionSenderFromChain(): Promise<Address | null> {
  try {
    const pc = createPublicClient({ chain: coston2, transport: http() });
    const a = await pc.readContract({
      address: DIAMOND,
      abi: parseAbi(["function getTeeExtensionInstructionsSender(uint256) view returns (address)"]),
      functionName: "getTeeExtensionInstructionsSender",
      args: [EXTENSION_ID],
    });
    return a === "0x0000000000000000000000000000000000000000" ? null : a;
  } catch {
    return null;
  }
}

export async function teeKeyFromChain(): Promise<Uint8Array | null> {
  try {
    const pc = createPublicClient({ chain: coston2, transport: http() });
    const ids = await pc.readContract({
      address: DIAMOND, abi: ABI, functionName: "getRandomTeeIds", args: [EXTENSION_ID, 1n],
    });
    if (!ids.length) return null;
    const { x, y } = await pc.readContract({
      address: DIAMOND, abi: ABI, functionName: "getPublicKey", args: [ids[0]],
    });
    const bx = hexToBytes(x);
    const by = hexToBytes(y);
    if (bx.length !== 32 || by.length !== 32) return null;
    // 65-byte uncompressed secp256k1 point: 0x04 ‖ x ‖ y.
    const out = new Uint8Array(65);
    out[0] = 0x04;
    out.set(bx, 1);
    out.set(by, 33);
    return out;
  } catch {
    return null;
  }
}

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
