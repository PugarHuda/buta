/**
 * What has to be true before a maker is asked to sign.
 *
 * The postRfq that ran on Coston2 failed on "ERC20: insufficient allowance",
 * and the only way to find that out was to pay for a reverted transaction.
 * These are the public reads that answer the same questions for free.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight, bidPreflight, relayPreflight, ZERO } from "../src/lib/onchain.js";

const base = { lot: 100n, balance: 1000n, allowance: 1000n, deadlineBlock: 500, head: 100n };

test("a fundable, approved, future block is sendable", () => {
  const p = preflight(base);
  assert.equal(p.ok, true);
  assert.equal(p.needsApproval, false);
  assert.equal(p.blocker, null);
});

test("too little of the lot token blocks it, and names both numbers", () => {
  const p = preflight({ ...base, balance: 40n });
  assert.equal(p.ok, false);
  assert.match(p.blocker!, /40/);
  assert.match(p.blocker!, /100/);
});

test("a deadline the chain has already passed blocks it", () => {
  // The contract reverts DeadlinePassed. Catching it here is the difference
  // between a message and a wasted transaction.
  const p = preflight({ ...base, deadlineBlock: 90 });
  assert.equal(p.ok, false);
  assert.match(p.blocker!, /behind the chain/);
});

test("an unread chain head does not invent a deadline problem", () => {
  assert.equal(preflight({ ...base, deadlineBlock: 1, head: null }).ok, true);
});

test("a short allowance is a step, not a refusal", () => {
  const p = preflight({ ...base, allowance: 0n });
  assert.equal(p.ok, true, "approving is something to do, not a reason to stop");
  assert.equal(p.needsApproval, true);
});

test("a zero lot is refused before any of that", () => {
  assert.match(preflight({ ...base, lot: 0n }).blocker!, /positive/);
});

// ── commitBid ────────────────────────────────────────────────────────────────
//
// The contract reverts on four separate conditions and the revert data is the
// only way to tell them apart afterwards. All four are readable first.

const bidBase = {
  exists: true, cleared: false, deadlineBlock: 500, head: 100n,
  invited: ZERO, bidder: "0xAaAa000000000000000000000000000000000001" as const, alreadyBid: false,
};

test("an open auction inside its deadline takes a bid", () => {
  assert.equal(bidPreflight(bidBase).ok, true);
});

test("a cleared auction, a passed deadline and a missing one each say which", () => {
  assert.match(bidPreflight({ ...bidBase, cleared: true }).blocker!, /already cleared/i);
  assert.match(bidPreflight({ ...bidBase, deadlineBlock: 50 }).blocker!, /deadline has passed/i);
  assert.match(bidPreflight({ ...bidBase, exists: false }).blocker!, /not on the contract/i);
});

test("a bilateral block turns away everyone but its counterparty", () => {
  const other = "0xBbBb000000000000000000000000000000000002" as const;
  assert.match(bidPreflight({ ...bidBase, invited: other }).blocker!, /reserved for one counterparty/i);
  assert.equal(bidPreflight({ ...bidBase, invited: bidBase.bidder }).ok, true, "the invited party is exactly who may bid");
});

test("one bid per address, which the contract enforces too", () => {
  assert.match(bidPreflight({ ...bidBase, alreadyBid: true }).blocker!, /already sealed/i);
});

// ── relayClearing ────────────────────────────────────────────────────────────
//
// The only function that moves money.

const relayBase = {
  cleared: false,
  onChainDigest: "0xaa".padEnd(66, "a") as `0x${string}`,
  outcomeDigest: "0xaa".padEnd(66, "a") as `0x${string}`,
  signature: "0xdead" as `0x${string}`,
  winnerAllowance: 1000n,
  clearingPrice: 500n,
};

test("a signed clearing over the recorded set, with the winner good for it, settles", () => {
  assert.equal(relayPreflight(relayBase).ok, true);
});

test("an unsigned clearing is refused, and says the facade is why", () => {
  const p = relayPreflight({ ...relayBase, signature: undefined });
  assert.equal(p.ok, false);
  assert.match(p.blocker!, /no enclave signature/i);
  assert.match(p.blocker!, /dev facade/i);
});

test("a clearing over a different set than the contract recorded is refused", () => {
  // The check that stops an auctioneer dropping an inconvenient bid: this is
  // the whole security argument, so it is the one that must not be skippable.
  const p = relayPreflight({ ...relayBase, outcomeDigest: ("0xbb".padEnd(66, "b")) as `0x${string}` });
  assert.equal(p.ok, false);
  assert.match(p.blocker!, /different set/i);
});

test("a winner who has not approved enough is named with both numbers", () => {
  const p = relayPreflight({ ...relayBase, winnerAllowance: 100n });
  assert.match(p.blocker!, /100/);
  assert.match(p.blocker!, /500/);
});

test("and an auction already settled is not settled twice", () => {
  assert.match(relayPreflight({ ...relayBase, cleared: true }).blocker!, /already settled/i);
});
