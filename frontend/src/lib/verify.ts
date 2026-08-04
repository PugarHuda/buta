/**
 * Did the enclave actually sign this, or is it the operator's word?
 *
 * The clearing outcome is the most consequential thing the desk shows: who won
 * and what they pay. On the direct rail nothing checked it. The proxy returned
 * `{ result, signature }` and the desk rendered `result` and dropped the
 * signature on the floor — so an operator could name any winner at any price
 * and the receipt would look exactly as it does now.
 *
 * The contract does not take anyone's word for it. `relayClearing` recomputes
 * the hash and recovers the signer against the registered `teeAddress`, and any
 * clearing whose signature does not recover is rejected on-chain. There is no
 * reason the desk cannot ask the same question before it draws a receipt, and
 * every reason it should: the whole point is that you do not have to trust the
 * party relaying.
 *
 * This mirrors ButaInstructionSender.relayClearing byte for byte. A drift makes
 * honest clearings look unverified rather than making forged ones look signed,
 * which is the safe direction to fail in.
 */
import {
  createPublicClient,
  encodeAbiParameters,
  encodePacked,
  http,
  keccak256,
  parseAbi,
  recoverMessageAddress,
  stringToHex,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { coston2 } from "../config/chain";

// bytes32("TEE_ACTION_RESULT"): ASCII, left-aligned, zero-padded. Written out
// by hand once and it was 66 characters of guesswork; stringToHex does it.
const TEE_ACTION_RESULT: Hex = stringToHex("TEE_ACTION_RESULT", { size: 32 });

const senderAbi = parseAbi(["function teeAddress() view returns (address)"]);

/** Reads the signer the contract itself would check against. Not a constant:
 *  a desk that hardcodes the address it verifies against is checking its own
 *  memory, not the chain's record. */
export async function registeredTeeAddress(sender: Address): Promise<Address | null> {
  try {
    const pc = createPublicClient({ chain: coston2, transport: http() });
    return await pc.readContract({ address: sender, abi: senderAbi, functionName: "teeAddress" });
  } catch {
    return null;
  }
}

export type Signed = {
  /** True only when the signature recovers to the registered TEE address. */
  ok: boolean;
  /** Who signed it, when that can be worked out at all. */
  signer: Address | null;
  /** What a reader should be told. */
  why: string;
};

/**
 * `resultData` is the exact bytes the contract would be handed:
 * abi.encode(rfqId, winner, clearingPrice, setDigest).
 */
export async function verifyClearing(p: {
  rfqId: number;
  winner: Address;
  clearingPrice: bigint;
  setDigest: Hex;
  actionId: Hex;
  submissionTag: string;
  status: number;
  signature?: Hex;
  teeAddress: Address | null;
}): Promise<Signed> {
  if (!p.signature) {
    return { ok: false, signer: null, why: "The relay returned no signature, so this is the operator's word." };
  }
  if (!p.teeAddress) {
    return { ok: false, signer: null, why: "Could not read the registered TEE address from the chain to check it against." };
  }

  const resultData = encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
    [BigInt(p.rfqId), p.winner, p.clearingPrice, p.setDigest],
  );
  const resultHash = keccak256(
    encodePacked(
      ["bytes32", "bytes32", "bytes32", "uint8"],
      [keccak256(resultData), p.actionId, keccak256(toBytes(p.submissionTag)), p.status],
    ),
  );
  const payloadHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
      [TEE_ACTION_RESULT, BigInt(coston2.id), resultHash],
    ),
  );

  try {
    // EIP-191 over the raw 32 bytes, which is what the contract's _ethSigned does.
    const signer = await recoverMessageAddress({ message: { raw: payloadHash }, signature: p.signature });
    const ok = signer.toLowerCase() === p.teeAddress.toLowerCase();
    return {
      ok,
      signer,
      why: ok
        ? "Signed by the enclave registered on-chain — the same check the contract makes before it settles."
        : `Signed by ${signer}, which is not the registered enclave (${p.teeAddress}).`,
    };
  } catch (e) {
    return { ok: false, signer: null, why: `The signature could not be recovered: ${(e as Error).message}` };
  }
}
