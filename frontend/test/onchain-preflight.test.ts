/**
 * What has to be true before a maker is asked to sign.
 *
 * The postRfq that ran on Coston2 failed on "ERC20: insufficient allowance",
 * and the only way to find that out was to pay for a reverted transaction.
 * These are the public reads that answer the same questions for free.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight, bidPreflight, relayPreflight, gasForWrite, isClearingOutcome, ZERO } from "../src/lib/onchain.js";

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

// ---- gas ---------------------------------------------------------------
// A reclaim reverted twice at gasUsed 116700 of a 118988 estimate, and the
// settlement that succeeded on Coston2 finished with 2% to spare. FXRP is an
// FAsset: its transfer cost drifts between estimation and execution, and the
// inner call only gets 63/64 of what remains.

test("the gas sent is not the gas estimated — it carries headroom", async () => {
  const pc = { estimateContractGas: async () => 118988n };
  const gas = await gasForWrite(pc as never, {});
  assert.ok(gas! > 118988n, "the estimate was sent unchanged, which is what starved the reclaim");
  // The observed failure used 98% of its estimate, so anything under ~1.02x
  // would still have reverted.
  assert.ok(gas! >= 118988n * 2n, `${gas} leaves too little room for an FAsset transfer`);
});

test("when the estimate itself fails the wallet is left to decide", async () => {
  // A blocked estimate almost always means a revert the pre-flight already
  // explained. Inventing a gas number there would send a transaction that is
  // known to fail, and pay for it.
  const pc = { estimateContractGas: async () => { throw new Error("execution reverted"); } };
  assert.equal(await gasForWrite(pc as never, {}), undefined);
});

// ---- which signed thing is the clearing --------------------------------
// The proxy signs more than one thing per instruction and files each under a
// different submission tag. Only one of them can be settled.

test("the four-word ABI outcome is accepted", () => {
  assert.equal(isClearingOutcome(`0x${"ab".repeat(128)}`), true);
});

test("the consensus envelope is not — it is signed, status 1, and useless", () => {
  // What "end" actually returns: 1887 bytes beginning {"voteSequence":…
  const json = Buffer.from('{"voteSequence":{"voteHash":"0x4c9d"}}').toString("hex");
  assert.equal(isClearingOutcome(`0x${json}`), false, "a vote envelope was taken for a clearing");
  // And the failure it caused: read as a uint256, that leading `{` becomes an
  // rfqId in the 5.5e76 range.
  assert.equal(isClearingOutcome(`0x7b${"00".repeat(127)}`.slice(0, 200)), false);
});

test("and nothing else that is merely the right length in bytes but not hex", () => {
  assert.equal(isClearingOutcome(`0x${"zz".repeat(128)}`), false);
  assert.equal(isClearingOutcome(undefined), false);
  assert.equal(isClearingOutcome(`0x${"ab".repeat(127)}`), false, "127 words is not four words");
});
