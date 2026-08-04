/**
 * buta.ts — client for the sealed-bid desk.
 *
 * The commitment computed here MUST be byte-identical to Go's
 * auction.Commit: keccak256(uint256(amount) || nonce32 || addr20).
 * The enclave recomputes it from the decrypted opening and refuses the bid
 * on any mismatch, so a drift here doesn't leak funds — it just makes every
 * bid bounce, loudly.
 */

import { encodePacked, keccak256, type Address, type Hex } from "viem";
import { encrypt as eciesEncrypt } from "ecies-geth";
import { postDirect, pollResult, decodeResultData } from "./teeClient";
import { readBook, readMyBids } from "./book";
import { teeKeyFromChain } from "./teeStatus";
import { env } from "../config/env";

const OP_TYPE = "BUTA";

export interface RfqState {
  rfqId: number;
  maker: string;
  pair: string;
  lot: number;
  deadline: number;
  bidCount: number;
  cleared: boolean;
  winner?: string;
  clearingPrice?: number;
  /** The commitments the contract recorded, in order. Public by construction:
   *  every one is on-chain before anyone knows what is in it. */
  commitments?: string[];
}

export interface ClearingOutcome {
  rfqId: number;
  winner: string;
  clearingPrice: number;
  bidCount: number;
  setDigest: string;
}

/** keccak256(amount ‖ nonce ‖ bidder) — mirrors pkg/auction Commit(). */
export function computeCommitment(amount: bigint, nonce: Hex, bidder: Address): Hex {
  return keccak256(
    encodePacked(["uint256", "bytes32", "address"], [amount, nonce, bidder])
  );
}

/** 32 random bytes. The nonce is what stops commitments being a price lookup table. */
export function randomNonce(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ("0x" +
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("")) as Hex;
}

async function call<T>(opCommand: string, payload: unknown): Promise<T> {
  const id = await postDirect(opCommand, payload, OP_TYPE);
  const res = await pollResult(id);
  if (res.result.status !== 1) {
    throw new Error(res.result.log || `${opCommand} failed`);
  }
  return decodeResultData<T>(res.result.data);
}

/** The book, checked before anyone renders it — see book.ts. The operator
 *  relaying this is the party the design says not to trust, and the desk used
 *  to call .toLocaleString() on whatever it sent. */
export async function listRfqs(): Promise<{ rfqs: RfqState[]; dropped: number }> {
  return readBook(await call<unknown>("LIST_RFQS", {}));
}

export function getRfqState(rfqId: number): Promise<RfqState> {
  return call<RfqState>("GET_RFQ_STATE", { rfqId });
}

/**
 * Demo path: these three ride the direct channel, which the extension only
 * accepts with BUTA_ALLOW_DIRECT_AUCTION=1. In production they are on-chain
 * instructions via ButaInstructionSender — postRfq escrows the lot, commitBid
 * records the commitment, and the enclave hears about it from the chain.
 */
export function postRfq(p: {
  maker: string;
  pair: string;
  lot: number;
  reserve: number;
  deadline: number;
  invited?: string;
}): Promise<{ rfqId: number }> {
  return call("POST_RFQ", { ...p, invited: p.invited ?? "" });
}

/** What the bidder's wallet signs:
 *
 *    keccak256("BUTA_BID" ‖ chainId ‖ rfqId ‖ commitment)
 *
 *  Binds the signature to one chain, one auction and one sealed bid. The chain
 *  id was missing, which was an asymmetry rather than a hole: the enclave's
 *  outbound signature is domain-separated by block.chainid in the contract,
 *  while this inbound one was not. Mirrors Go's bidSigPayload — a drift does not
 *  throw, it silently rejects every bid as a forged sender, so the Go side pins
 *  these exact bytes in a test. */
export function bidSigPayload(rfqId: number, commitment: Hex, chainId = 114): Hex {
  return keccak256(
    encodePacked(
      ["string", "uint256", "uint256", "bytes32"],
      ["BUTA_BID", BigInt(chainId), BigInt(rfqId), commitment],
    ),
  );
}

/**
 * The key a bid is encrypted to, read from the diamond rather than asked of the
 * operator — see teeStatus.ts. Asking the operator for the key that hides bids
 * FROM the operator was the hole; ecies-geth wants the 65-byte uncompressed
 * form, which is what this returns.
 */
async function teePublicKey(): Promise<Buffer> {
  // The escape hatch first, and only when it is deliberately switched on.
  //
  // cmd/dev generates its own key and registers nothing, so it is NOT the
  // machine the chain knows about — encrypting to the registered key against a
  // local enclave produces "ecies: invalid message" and nothing else. That is a
  // real local-development need, and it is also exactly the state an operator
  // would like you to be in, which is why it is off by default and why the desk
  // says out loud when it is on.
  if (env.allowUnverifiedTeeKey) {
    const info = await (await fetch(`${env.teeProxyUrl}/info`)).json();
    const pk = info?.machineData?.publicKey ?? info?.teeInfo?.publicKey;
    if (!pk?.x || !pk?.y) throw new Error("the relay returned no public key");
    const b = (h: string) => Buffer.from(h.slice(2).padStart(64, "0"), "hex");
    return Buffer.concat([Buffer.from([0x04]), b(pk.x), b(pk.y)]);
  }

  const onChain = await teeKeyFromChain();
  if (!onChain) {
    throw new Error(
      "No enclave key on-chain to encrypt this bid to, and an unverified one is the whole attack: " +
        "an operator serving its own key reads every bid and every reserve. " +
        "Set VITE_ALLOW_UNVERIFIED_TEE_KEY=1 only when you are running the enclave yourself.",
    );
  }
  return Buffer.from(onChain);
}

export async function sealBid(p: {
  rfqId: number;
  bidder: Address;
  amount: bigint;
  /** The chain the wallet is actually on. Hardcoding 114 meant a wallet on any
   *  other network signed a payload the enclave could not match, and the bid
   *  came back rejected as a forged sender with nothing pointing at the cause. */
  chainId: number;
  /** personal_sign over raw 32 bytes — wagmi: signMessageAsync({ message: { raw } }) */
  sign: (raw: Hex) => Promise<Hex>;
}): Promise<{ rfqId: number; bidCount: number; commitment: Hex; nonce: Hex }> {
  const nonce = randomNonce();
  const commitment = computeCommitment(p.amount, nonce, p.bidder);
  const sig = await p.sign(bidSigPayload(p.rfqId, commitment, p.chainId));

  // The opening — amount, nonce, signature — is ECIES-encrypted to the TEE key
  // and sent as ciphertext. The operator relaying the request never sees the
  // amount; only the enclave that holds the private key can open it. The
  // commitment (which reveals nothing) is what lands on-chain.
  const opening = JSON.stringify({ amount: Number(p.amount), nonce, sig });
  const teeKey = await teePublicKey();
  const ct = await eciesEncrypt(teeKey, Buffer.from(opening));
  const ciphertext = ("0x" + ct.toString("hex")) as Hex;

  const res = await call<{ rfqId: number; bidCount: number }>("COMMIT_BID", {
    rfqId: p.rfqId,
    bidder: p.bidder,
    commitment,
    ciphertext,
  });
  return { ...res, commitment, nonce };
}

export function clearAuction(rfqId: number): Promise<ClearingOutcome> {
  return call<ClearingOutcome>("CLEAR_AUCTION", { rfqId });
}

export interface MyBid {
  rfqId: number;
  pair: string;
  commitment: Hex;
  cleared: boolean;
  won: boolean;
}

/** Checked before Portfolio renders it — see book.ts. */
export async function getMyBids(bidder: Address): Promise<MyBid[]> {
  return readMyBids(await call<unknown>("GET_MY_BIDS", { bidder }));
}

// ── selective disclosure ─────────────────────────────────────────────────────
//
// A bidder can prove the exact amount they bid to a chosen party — an auditor,
// a counterparty — without it ever becoming public, and without being able to
// lie: any other amount produces a different commitment. It is sharpest for the
// winner, whose true bid stays hidden on-chain (Vickrey pays the second price)
// yet remains bindingly disclosable.

export interface Disclosure {
  rfqId: number;
  bidder: Address;
  amount: string; // stringified so it survives copy/paste intact
  nonce: Hex;
}

/** Package a disclosure the bidder hands to a verifier. Reveals nothing the
 *  verifier can't already check against the on-chain commitment. */
export function makeDisclosure(d: Disclosure): string {
  return JSON.stringify(d);
}

/** Recompute the commitment from a disclosure and check it against the one the
 *  desk holds for that bid. True means the discloser bid exactly `amount` —
 *  proven, not asserted. */
export async function verifyDisclosure(raw: string): Promise<{
  ok: boolean;
  amount: string;
  rfqId: number;
  bidder: Address;
  recomputed: Hex;
}> {
  const d = JSON.parse(raw) as Disclosure;
  const recomputed = computeCommitment(BigInt(d.amount), d.nonce, d.bidder);
  const mine = await getMyBids(d.bidder);
  // Match on the COMMITMENT, not on the auction id.
  //
  // This looked up the first bid the discloser had on that auction and compared
  // against it — which is only the right bid if they have exactly one, and the
  // enclave was letting the same address seal several. So an honest disclosure
  // was compared against somebody else's number and came back NOT VERIFIED.
  // The enclave now refuses a second bid, but matching on the commitment is the
  // correct question anyway: "is the number I recomputed in the recorded set?"
  const onDesk = mine.find(
    (b) => b.rfqId === d.rfqId && b.commitment.toLowerCase() === recomputed.toLowerCase(),
  );
  return {
    ok: !!onDesk,
    amount: d.amount,
    rfqId: d.rfqId,
    bidder: d.bidder,
    recomputed,
  };
}
