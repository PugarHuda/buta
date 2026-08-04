/**
 * What a deadline block actually means, right now.
 *
 * The desk printed "blk 24,125,000" on every row and then asked the reader
 * "Past the deadline?" — a question it was in a position to answer and did not.
 * A block number is not a time to anyone, and the one control that depends on
 * it was offered identically on an auction with two hours left and one that
 * closed yesterday.
 *
 * One eth_blockNumber, no wallet, refreshed on the same cadence as the book.
 */
import { createPublicClient, http } from "viem";
import { coston2 } from "../config/chain";

/** Coston2 targets ~1.8s blocks. Close enough to say "about an hour", which is
 *  all this is for — nothing settles on the strength of this estimate. */
const SECONDS_PER_BLOCK = 1.8;

export function readBlockNumber(): Promise<bigint | null> {
  return createPublicClient({ chain: coston2, transport: http() })
    .getBlockNumber()
    .catch(() => null);
}

export type Countdown = {
  passed: boolean;
  blocks: number;
  /** "in about 1h 40m", "passed 2,100 blocks ago", or "" when the chain is unread. */
  text: string;
};

function human(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function countdown(deadline: number, now: bigint | null): Countdown {
  if (now === null) return { passed: false, blocks: 0, text: "" };
  const diff = deadline - Number(now);
  if (diff <= 0) {
    return { passed: true, blocks: -diff, text: `deadline passed ${(-diff).toLocaleString()} blocks ago` };
  }
  return { passed: false, blocks: diff, text: `about ${human(diff * SECONDS_PER_BLOCK)} left` };
}
