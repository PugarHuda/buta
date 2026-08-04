/**
 * What has to be true before a maker is asked to sign.
 *
 * The postRfq that ran on Coston2 failed on "ERC20: insufficient allowance",
 * and the only way to find that out was to pay for a reverted transaction.
 * These are the public reads that answer the same questions for free.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../src/lib/onchain.js";

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
