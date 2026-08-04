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
  "function reclaimLot(uint256 rfqId)",
  "function rfqCount() view returns (uint256)",
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
