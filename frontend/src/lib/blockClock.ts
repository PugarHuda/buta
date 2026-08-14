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

/** Measured over 20,000 Coston2 blocks on 14 August: 2.059s, not the 1.8s the
 *  target suggests and this used to assume. A 14% error is invisible on "about
 *  an hour" and lands four hours out on a two-day auction, which is the length
 *  a block posted to stay open across a judging window actually has. Nothing
 *  settles on the strength of this estimate — the contract compares block
 *  numbers — but people plan around it. */
const SECONDS_PER_BLOCK = 2.06;

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
