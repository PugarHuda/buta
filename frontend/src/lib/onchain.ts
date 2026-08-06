/**
 * The on-chain rail: posting a block and reclaiming an unsold one.
 *
 * Everything else in the desk speaks to the enclave over the direct channel,
 * which is a demo path the extension only opens with BUTA_ALLOW_DIRECT_AUCTION.
 * The real rail is a transaction: `postRfq` escrows the lot in
 * ButaInstructionSender and the contract forwards the instruction through the
 * diamond, so the auction exists on-chain before the enclave has heard of it.
 * That ordering is the load-bearing part — the commitment set the contract
 * records is what the clearing must match.
 *
 * `reclaimLot` was in the contract from the start and had no way to be called.
 * A maker whose block drew no bid had escrowed a lot with no route back to it
 * except a raw transaction, which is not a product.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

/** Paid to the diamond for forwarding one instruction. The postRfq that ran on
 *  Coston2 (0x6d205171…) paid exactly this. */
export const INSTRUCTION_FEE = 1_000_000_000n; // 1 gwei

export const senderAbi = parseAbi([
  "function postRfq(address settleToken, address lotToken, uint256 lot, uint64 deadlineBlock, address invited, bytes encryptedReserve) payable returns (uint256)",
  "function commitBid(uint256 rfqId, bytes32 commitment, bytes ciphertext) payable",
  "function requestClearing(uint256 rfqId) payable",
  "function relayClearing(uint256 rfqId, address winner, uint256 clearingPrice, bytes32 setDigest, bytes32 actionId, string submissionTag, uint8 status, bytes signature)",
  "function reclaimLot(uint256 rfqId)",
  "function rfqCount() view returns (uint256)",
  "function commitmentDigest(uint256 rfqId) view returns (bytes32)",
  "function hasBid(uint256, address) view returns (bool)",
  "function rfqs(uint256) view returns (address maker, address settleToken, address lotToken, uint256 lot, uint64 deadlineBlock, address invited, bool cleared, address winner, uint256 clearingPrice)",
]);

export const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

export const ZERO: Address = "0x0000000000000000000000000000000000000000";

/**
 * What has to be true before a transaction is worth sending, checked from
 * public reads so the wallet is never asked to sign something that will revert.
 *
 * The desk's own history is the argument for this: postRfq on Coston2 failed on
 * "ERC20: insufficient allowance" and the only way to find out was to pay for a
 * reverted transaction.
 */
export type PostPreflight = {
  ok: boolean;
  balance: bigint;
  allowance: bigint;
  /** Why it cannot be sent, in words a maker can act on. */
  blocker: string | null;
  /** True when the lot token still has to be approved first. */
  needsApproval: boolean;
};

export function preflight(p: {
  lot: bigint;
  balance: bigint;
  allowance: bigint;
  deadlineBlock: number;
  head: bigint | null;
}): PostPreflight {
  const needsApproval = p.allowance < p.lot;
  let blocker: string | null = null;

  if (p.lot <= 0n) blocker = "The lot has to be a positive amount.";
  else if (p.balance < p.lot) {
    blocker = `You hold ${p.balance} of the lot token and the block needs ${p.lot}.`;
  } else if (p.head !== null && BigInt(p.deadlineBlock) <= p.head) {
    // The contract reverts DeadlinePassed. Catching it here costs nothing and
    // saves a failed transaction.
    blocker = "The deadline is already behind the chain — give it more time.";
  }

  return { ok: blocker === null, balance: p.balance, allowance: p.allowance, blocker, needsApproval };
}

/** Calldata for the approval the escrow needs. Exact amount, not unlimited: a
 *  desk that asks for infinite approval to escrow one lot is asking for more
 *  than it needs. */
export function approveCall(spender: Address, lot: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, lot] });
}

/**
 * Whether a bid can go on-chain, from what the contract itself checks.
 *
 * commitBid reverts on four separate conditions and the revert data is the only
 * way to tell them apart after the fact. All four are readable beforehand.
 */
export function bidPreflight(p: {
  exists: boolean;
  cleared: boolean;
  deadlineBlock: number;
  head: bigint | null;
  invited: Address;
  bidder: Address;
  alreadyBid: boolean;
}): { ok: boolean; blocker: string | null } {
  if (!p.exists) return { ok: false, blocker: "That auction is not on the contract." };
  if (p.cleared) return { ok: false, blocker: "It has already cleared." };
  if (p.head !== null && BigInt(p.deadlineBlock) < p.head) {
    return { ok: false, blocker: "Its deadline has passed — bids are closed." };
  }
  if (p.invited !== ZERO && p.invited.toLowerCase() !== p.bidder.toLowerCase()) {
    return { ok: false, blocker: "This block is reserved for one counterparty, and it is not you." };
  }
  if (p.alreadyBid) {
    return { ok: false, blocker: "You already sealed a bid here. One per address, enforced by the contract." };
  }
  return { ok: true, blocker: null };
}

/** The diamond's TeeInstructionsSent event puts the instruction id in topic 2.
 *  Topic 1 is the EXTENSION id, which is the same on every instruction — taking
 *  it meant asking the proxy for a result filed under something that was never
 *  an id, and getting "not found" forever. */
export function instructionIdFrom(logs: readonly { address: string; topics: readonly Hex[] }[]): Hex | null {
  const DIAMOND = "0x1a9c4a0f9d76c0b1d91d22e24e573a9b377618ae";
  return logs.find((l) => l.address.toLowerCase() === DIAMOND)?.topics[2] ?? null;
}

/**
 * Is this the clearing outcome, or something else the proxy also signed?
 *
 * The three submission tags do not carry the same thing. Only "threshold" holds
 * the enclave's ABI-encoded outcome — rfqId, winner, price, digest, four words,
 * 128 bytes, exactly what relayClearing rebuilds. "end" holds the consensus
 * envelope: 1887 bytes of `{"voteSequence":{"voteHash":…}}`, signed and status
 * 1 and completely useless for settling.
 *
 * Taking whichever tag answered first was a race. It happened to land on
 * "threshold" for the two settlements that proved this system works, and on
 * "end" the first time the desk asked from a browser — where it decoded the
 * leading `{` of that JSON as an rfqId of 55695370586825141013624577… and the
 * mismatch guard, correctly, refused to settle anything.
 *
 * So the tag is not the test. The shape is.
 */
export function isClearingOutcome(data: unknown): data is Hex {
  return typeof data === "string" && /^0x[0-9a-fA-F]{256}$/.test(data);
}

/**
 * The signed clearing, once the enclave has produced one.
 *
 * On-chain instructions are filed under "threshold" first and re-emitted under
 * "end"; the direct channel uses "submit". Trying all three is cheaper than
 * knowing which, and the answer is the same object either way.
 *
 * Returns null when nothing signed arrives, which is a real outcome rather than
 * an error: the dev facade signs nothing at all, and relayClearing will not take
 * an unsigned result.
 */
export async function awaitSignedClearing(
  proxyUrl: string,
  instructionId: Hex,
  opts: { tries?: number; everyMs?: number } = {},
): Promise<{ data: Hex; actionId: Hex; submissionTag: string; signature: Hex } | null> {
  const tries = opts.tries ?? 40;
  for (let i = 0; i < tries; i++) {
    for (const tag of ["threshold", "end", "submit"]) {
      try {
        const r = await fetch(`${proxyUrl}/action/result/${instructionId}?submissionTag=${tag}`);
        if (!r.ok) continue;
        const j = await r.json();
        if (j?.result?.status === 1 && j?.signature && isClearingOutcome(j.result.data)) {
          return {
            data: j.result.data as Hex,
            actionId: j.result.id as Hex,
            submissionTag: j.result.submissionTag ?? tag,
            signature: j.signature as Hex,
          };
        }
      } catch {
        /* keep waiting */
      }
    }
    await new Promise((r) => setTimeout(r, opts.everyMs ?? 3000));
  }
  return null;
}

/**
 * Gas for a write, with room for what estimation cannot see.
 *
 * Every transaction this desk sends moves FXRP, and FXRP is an FAsset whose
 * transfer cost is not fixed. The estimate is taken against one block and the
 * transaction executes in a later one; the inner ERC20 call only receives 63/64
 * of what is left, so a few thousand gas of drift is enough to starve it. It
 * returns false rather than reverting, and the contract's own
 * `require(..., "lot refund failed")` fires — which reads like a refund bug and
 * is really a ceiling.
 *
 * This is not hypothetical: a reclaim reverted twice at gasUsed 116700 of a
 * 118988 estimate, and the settlement that DID succeed on Coston2 finished with
 * 2% to spare. Unused gas is refunded, so the headroom costs nothing but the
 * failure costs a stranded lot.
 *
 * Returns undefined when estimation itself fails, which leaves the wallet to do
 * what it always did — a blocked estimate almost always means a revert the
 * pre-flight has already explained in words.
 */
export async function gasForWrite(
  pc: { estimateContractGas: (p: never) => Promise<bigint> },
  params: unknown,
): Promise<bigint | undefined> {
  try {
    return ((await pc.estimateContractGas(params as never)) * 2n);
  } catch {
    return undefined;
  }
}

/**
 * Whether a clearing can be relayed and settled.
 *
 * relayClearing is the only function that moves money, and it reverts on a
 * mismatched set digest — the check that stops an auctioneer clearing over a
 * subset. Comparing the digests here turns that from a failed transaction into
 * a sentence.
 */
export function relayPreflight(p: {
  cleared: boolean;
  onChainDigest: Hex | null;
  outcomeDigest: Hex;
  signature?: Hex;
  winnerAllowance: bigint;
  clearingPrice: bigint;
}): { ok: boolean; blocker: string | null } {
  if (p.cleared) return { ok: false, blocker: "Already settled on-chain." };
  if (!p.signature) {
    return {
      ok: false,
      blocker:
        "This clearing carries no enclave signature, and relayClearing will not settle without one. " +
        "The dev facade signs nothing — this needs the real proxy.",
    };
  }
  if (p.onChainDigest && p.onChainDigest.toLowerCase() !== p.outcomeDigest.toLowerCase()) {
    return {
      ok: false,
      blocker:
        "The clearing was computed over a different set than the contract recorded. " +
        "That is precisely what the digest check exists to refuse.",
    };
  }
  if (p.winnerAllowance < p.clearingPrice) {
    // The winner pays the maker directly, so the contract needs their approval.
    // Without it the whole settlement reverts and the auction stays open.
    return {
      ok: false,
      blocker: `The winner has approved ${p.winnerAllowance} of the settlement token and owes ${p.clearingPrice}.`,
    };
  }
  return { ok: true, blocker: null };
}
