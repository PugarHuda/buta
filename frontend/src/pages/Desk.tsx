/**
 * Desk.tsx - the sealed-bid desk.
 *
 * One screen, three moves: post a block, seal a bid, clear at the second
 * price. The layout owes everything to the landing page's Swiss Industrial
 * Print language: paper, carbon ink, one aviation red, hairline grids, no
 * radii, uppercase reserved for labels and unit ids.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useSignMessage, useWriteContract } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { createPublicClient, decodeAbiParameters, http, type Address } from "viem";
import { Folio } from "./Folio";
import { TOKENS } from "../config/tokens";
import { coston2 } from "../config/chain";
import { demoBook } from "../lib/demoData";
import { env } from "../config/env";
import { readTeeStatus, instructionSenderFromChain, type TeeStatus } from "../lib/teeStatus";
import { readBlockNumber, countdown } from "../lib/blockClock";
import { remember } from "../lib/seals";
import { allClearings, forgetClearing, rememberClearing, type StoredClearing } from "../lib/clearings";
import {
  senderAbi, erc20Abi, preflight, bidPreflight, relayPreflight,
  instructionIdFrom, awaitSignedClearing, gasForWrite, INSTRUCTION_FEE, ZERO,
} from "../lib/onchain";

import {
  clearAuction,
  listRfqs,
  postRfq,
  sealBid,
  sealBidEnvelope,
  sealReserve,
  getMyBids,
  type ClearingOutcome,
  type RfqState,
} from "../lib/buta";

// 3s was chosen when the book came from a facade on localhost. Through the
// deployed path - browser to Vercel to a reserved tunnel to a container - the
// median round trip is 4.3 seconds, so a 3s timer could never keep up with
// itself. Six seconds still reads as live and halves what the enclave carries
// per open tab.
const POLL_MS = 6000;

// ── shared atoms ─────────────────────────────────────────────────────────────

/** Every panel says what it is, twice: a small line naming the surface, then
 *  the heading. A screen that opens with a table and no title makes the reader
 *  work out where they are from the contents. */
function Head({ eyebrow, children }: { eyebrow: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="px-4 pt-5 pb-3">
      <div className="text-[11px] font-medium tracking-[0.12em] uppercase text-fg-mute">{eyebrow}</div>
      <h1 className="mt-1.5 text-[26px] leading-tight" style={{ fontFamily: "var(--f-macro)" }}>
        {children}
      </h1>
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-[0.1em] uppercase text-fg-mute">{children}</span>
  );
}

function Red({ children }: { children: React.ReactNode }) {
  return <span className="text-accent">{children}</span>;
}

/** An input a reader can see is an input: white ground against the paper, a
 *  border dark enough to read as an edge, and a focus state that is not a
 *  one-pixel colour change. */
function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <Lbl>{props.label}</Lbl>
      <input
        className="bg-white border border-line-2 px-3 py-2.5 font-mono text-[13px] text-fg outline-none
                   placeholder:text-fg-mute/60 focus:border-accent focus:ring-2 focus:ring-accent/20 transition-colors"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        spellCheck={false}
      />
      {props.hint && <span className="text-[11.5px] leading-snug text-fg-mute">{props.hint}</span>}
    </label>
  );
}

/**
 * Buttons that look like buttons.
 *
 * These used to be 11px uppercase mono with a hairline border and no fill on
 * the secondary - the same weight as the labels beside them, so the desk gave
 * a reader no way to tell what was a control and what was a caption. One
 * filled red primary per panel, a real outlined secondary, both with a hover
 * and a pressed state so a click is felt as well as taken.
 */
function Btn(props: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  quiet?: boolean;
}) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.busy}
      className={
        "inline-flex items-center gap-2 px-4 py-2.5 text-[12.5px] font-semibold tracking-[0.02em] border " +
        "transition-all active:translate-y-px disabled:opacity-50 disabled:active:translate-y-0 " +
        (props.quiet
          ? "bg-white text-fg border-line-2 hover:border-fg hover:bg-bg-1"
          : "bg-accent text-white border-accent shadow-[0_1px_0_var(--accent-deep)] hover:bg-[var(--accent-deep)] hover:border-[var(--accent-deep)]")
      }
    >
      {props.busy && (
        <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
      )}
      {props.busy ? "Working…" : props.children}
    </button>
  );
}

/**
 * Settling is the step that makes the rest pay off, and it used to live only in
 * the branch for an auction that had NOT cleared.
 *
 * Which meant the act of succeeding removed it: the enclave clears, the next
 * poll brings the row back with cleared = true, the whole clearing section
 * unmounts, and the signed outcome sits in state with no way to spend it. The
 * desk could reach a settlement it could never perform, and no script could
 * find that, because a script never renders anything.
 *
 * Cleared and settled are two different facts about two different systems - the
 * enclave opened the bids, the contract moved the money - so this renders on
 * both sides of that split and stops when the CONTRACT says it is done.
 */
/**
 * Ask the enclave to open the bids and sign the outcome.
 *
 * This lived only in the branch for an auction the ENCLAVE had not cleared,
 * which conflated two facts about two systems. The enclave's `cleared` means an
 * outcome exists; the contract's means the money moved. Between those two there
 * is a real state - signed but not settled - and in it the desk offered
 * nothing at all: the outcome lives in React state, a reload loses it, and the
 * only control that could fetch it again was hidden precisely because the
 * clearing had worked. The lot stays escrowed with no route out through the UI.
 *
 * Asking again does NOT reproduce it. The enclave answers
 * `error: auction: already cleared` and returns nothing - the outcome is
 * produced exactly once. That is why the signature is written to storage the
 * moment it arrives (lib/clearings.ts), and why this control says so rather
 * than offering a button that cannot work.
 */
function RequestClearingBlock(props: { busy: boolean; onRequest: () => void; signedAlready: boolean }) {
  return (
    <div className="mt-3">
      <Btn quiet busy={props.busy} onClick={props.onRequest}>
        {props.signedAlready ? "Ask again for the signed outcome" : "Request clearing on-chain"}
      </Btn>
      <p className="mt-2 text-[11.5px] text-fg-mute leading-relaxed max-w-[34ch]">
        {props.signedAlready ? (
          <>
            Opened once and kept. A repeat is answered from the enclave's memory in seconds - press
            this when the first dispatch came back with nothing.
          </>
        ) : (
          <>
            A transaction. The enclave opens the bids and signs the outcome, and only a signed one can
            be settled.
          </>
        )}
      </p>
    </div>
  );
}

function SettleBlock(props: {
  outcome: { signature?: string; rfqId: number };
  busy: boolean;
  onSettle: () => void;
}) {
  return (
    <div className="mt-4 pt-4 border-t border-line">
      <Lbl>Settle it</Lbl>
      <p className="mt-1 mb-2 text-[11.5px] text-fg-mute leading-relaxed max-w-[26ch]">
        {props.outcome.signature
          ? "Signed by the enclave. relayClearing pays the maker and moves the lot in one transaction."
          : "This rail returned no signature, and relayClearing will not settle without one."}
      </p>
      <Btn quiet busy={props.busy} onClick={props.onSettle}>
        Settle on-chain
      </Btn>
    </div>
  );
}

// ── the desk ─────────────────────────────────────────────────────────────────

export function Desk() {
  const { address, chainId: walletChain } = useAccount();
  const chainId = walletChain ?? coston2.id;
  const { signMessageAsync } = useSignMessage();
  const [rfqs, setRfqs] = useState<RfqState[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  // "auto" means the panel follows the book: whatever the selected auction can
  // have done to it is what is on screen. The other two are the moves that are
  // not about one auction. This was a three-tab strip, which asked the reader to
  // pick a tab before the desk would tell them anything.
  const [panel, setPanel] = useState<"auto" | "post" | "folio" | "activity" | "audit">("auto");
  const [filter, setFilter] = useState<"all" | "open" | "mine">("all");
  // Everything the desk has told you this session, newest first.
  //
  // This was one line at the foot of the page that each action overwrote. Post
  // a block, seal a bid, clear an auction and the only evidence any of it
  // happened was whatever the last one said - including the receipts, which are
  // the part worth keeping.
  const [activity, setActivity] = useState<{ at: string; text: string }[]>([]);
  const say = useCallback((text: string) => {
    if (!text) return;
    const at = new Date().toTimeString().slice(0, 8);
    setActivity((a) => [{ at, text }, ...a].slice(0, 50));
  }, []);
  const latest = activity[0]?.text ?? "";
  // Rows the book arrived with that could not be shown. Saying so is the point:
  // a desk that silently renders a shorter book than the enclave reported is
  // hiding a disagreement between the two.
  const [dropped, setDropped] = useState(0);
  const [offline, setOffline] = useState(false);
  const [demo, setDemo] = useState(false);
  /** A book request has completed at least once, either way. Until then the
   *  desk has no basis for saying the book is empty. */
  const [loadedOnce, setLoadedOnce] = useState(false);
  // Read from the diamond, not from whether we can reach a proxy: those are two
  // different facts and the masthead used to conflate them.
  const [tee, setTee] = useState<TeeStatus>({ state: "unknown" });
  useEffect(() => { readTeeStatus().then(setTee); }, []);

  // The contract the diamond says is bound to our extension. A constant here
  // was the first of four deployments while three later ones were live.
  const [sender, setSender] = useState<Address>(SENDER_FALLBACK as Address);
  useEffect(() => { instructionSenderFromChain().then((a) => a && setSender(a)); }, []);

  // The chain's own clock. Deadlines are block numbers, which mean nothing to a
  // reader, and "Past the deadline?" was a question the desk could answer.
  const [block, setBlock] = useState<bigint | null>(null);
  // A ref as well as state: the demo book is placed around the head, and reading
  // it through the ref keeps `refresh` out of the block's dependency list - as a
  // dependency it would tear down and restart the poll every fifteen seconds.
  const headRef = useRef<bigint | null>(null);
  /** A book request is in flight; the poll timer skips rather than stacking. */
  const inFlight = useRef(false);
  useEffect(() => {
    let live = true;
    const tick = () =>
      readBlockNumber().then((n) => {
        if (!live) return;
        headRef.current = n;
        setBlock(n);
      });
    tick();
    const t = setInterval(tick, 15_000);
    return () => { live = false; clearInterval(t); };
  }, []);

  // Whether an enclave is reachable is a question about the deployment, not
  // about the bundle, so it is answered by asking rather than by a constant.
  //
  // It used to be `DEV || VITE_TEE_PROXY_URL`, which was wrong in both
  // directions. A full URL in the bundle cannot work at all - the extension
  // proxy sends no Access-Control-Allow-Origin header, so the browser blocks
  // every fetch before it leaves the page - and an empty one ruled out the only
  // arrangement that DOES work: a same-origin rewrite in front of the desk
  // (scripts/point-desk-at-machine.mjs), where /info is served from the machine
  // and there is no preflight to fail.
  //
  // One HEAD-shaped probe on load. If it answers, poll; if not, the demo book,
  // which is what a deployment with no machine behind it should show.
  const [canReachExtension, setCanReachExtension] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${env.teeProxyUrl}/info`)
      .then((r) => r.ok)
      .catch(() => false)
      .then((ok) => alive && setCanReachExtension(ok));
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    // Still asking. Falling through would flash the demo book and its banner at
    // every deployment that does have a machine.
    if (canReachExtension === null) return;
    if (!canReachExtension) {
      setRfqs(demoBook(headRef.current));
      setOffline(true);
      setDemo(true);
      setLoadedOnce(true);
      return;
    }
    // One book request at a time.
    //
    // A refresh is a POST to the enclave and then a poll for its result, and
    // measured through the live tunnel that round trip has a median of 4.3
    // seconds - longer than the interval that fires it. Without this guard the
    // timer started a second request before the first came back, then a third,
    // and the queue grew for as long as the enclave stayed slow. The thing that
    // makes it slow is people opening the desk, so the failure feeds itself and
    // arrives exactly when an audience does.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const { rfqs: list, dropped: bad } = await listRfqs();
      setRfqs(list);
      setDropped(bad);
      setOffline(false);
      setDemo(false);
    } catch {
      // No extension reachable - show the demo book so the desk is never empty.
      setRfqs(demoBook(headRef.current));
      setOffline(true);
      setDemo(true);
    } finally {
      inFlight.current = false;
      setLoadedOnce(true);
    }
  }, [canReachExtension]);

  useEffect(() => {
    refresh();
    if (!canReachExtension) return; // nothing to poll for
    // A backgrounded tab is a tab nobody is reading. Browsers throttle timers
    // there but do not stop them, and a judge who leaves this open in another
    // window should not keep a laptop's enclave busy for hours.
    const tick = () => { if (!document.hidden) refresh(); };
    const t = setInterval(tick, POLL_MS);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh, canReachExtension]);

  // Only a SEALED auction can be bid on. The book is newest-first and the newest
  // is usually already cleared, so landing on nothing selected - or worse, on a
  // closed auction - was the first thing anyone saw. Open on the first one that
  // can actually be acted on.
  const firstOpen = useMemo(() => rfqs.find((r) => !r.cleared) ?? null, [rfqs]);
  useEffect(() => {
    if (selected === null && firstOpen) setSelected(firstOpen.rfqId);
  }, [selected, firstOpen]);

  // Which auctions you already have a sealed bid on. The enclave refuses a
  // second bid from the same address, so without this the only way to find out
  // was to type an amount, press Seal, and be told no.
  const [myRfqs, setMyRfqs] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!address || !canReachExtension) return setMyRfqs(new Set());
    let live = true;
    getMyBids(address)
      .then((bids) => { if (live) setMyRfqs(new Set(bids.map((b) => b.rfqId))); })
      .catch(() => {});
    return () => { live = false; };
  }, [address, canReachExtension, rfqs.length]);

  // Reclaiming is a real transaction, so it says what it is doing and what
  // happened - including the hash, which is the only part a maker can check
  // against the chain themselves.
  /**
   * A demo row's number is not a number on the contract.
   *
   * Every row-scoped on-chain button took `r.rfqId` straight to a transaction,
   * and when the enclave is unreachable those ids come from demoBook(). The run
   * that found this had the desk showing demo row 5 - the proxy had rejected
   * /direct for a missing API key - pressed "Request clearing on-chain", and
   * sent a real, paid instruction about contract RFQ 5, which belonged to
   * somebody else's auction entirely. Nothing looked wrong: the demo banner was
   * up, the button worked, the transaction succeeded.
   *
   * Posting is not covered here on purpose. A post invents its own auction and
   * does not reference a row, so it is legitimate even with no enclave to watch
   * the result.
   */
  const rowIsReal = useCallback(() => {
    if (!demo && !offline) return true;
    say("This is the demo book. These rows are not on the contract, so there is nothing on-chain to act on.");
    return false;
  }, [demo, offline, say]);

  const { writeContractAsync } = useWriteContract();

  /**
   * Every write goes through here so none of them can be starved of gas.
   *
   * The wallet estimates against the current block and the transaction lands in
   * a later one. For an FAsset that difference is enough - see gasForWrite. Six
   * call sites, one ceiling to get wrong, so there is one place that sets it.
   */
  const send = useCallback(
    // Reached through a variable, wagmi's parameter union narrows `value` to
    // undefined for the payable functions, so the cast lives here instead of at
    // six call sites.
    async (params: Omit<Parameters<typeof writeContractAsync>[0], "value"> & { value?: bigint }) => {
      const pc = createPublicClient({ chain: coston2, transport: http() });
      const gas = await gasForWrite(pc, { ...params, account: address });
      return writeContractAsync({ ...params, ...(gas ? { gas } : {}) } as Parameters<
        typeof writeContractAsync
      >[0]);
    },
    [writeContractAsync, address],
  );

  const [reclaiming, setReclaiming] = useState<number | null>(null);
  const reclaim = useCallback(
    async (rfqId: number) => {
      if (!rowIsReal()) return;
      setReclaiming(rfqId);
      try {
        const hash = await send({
          address: sender,
          abi: senderAbi,
          functionName: "reclaimLot",
          args: [BigInt(rfqId)],
        });
        say(`Reclaim sent for RFQ ${rfqId}: ${hash}. The lot returns to you and the auction closes with no winner.`);
      } catch (e) {
        // Wallet rejections and reverts arrive the same way; the contract's own
        // message is more use than a generic failure.
        const m = (e as { shortMessage?: string; message?: string });
        say(`Reclaim failed: ${m.shortMessage ?? m.message ?? String(e)}`);
      } finally {
        setReclaiming(null);
        refresh();
      }
    },
    // `send` belongs here. It closes over `address`, and without it reclaim
    // kept the first render's copy, where address was undefined - so
    // gasForWrite estimated with no `from`, the estimate for reclaimLot's inner
    // transfer reverted, and the doubled ceiling was skipped. On the one call
    // whose comment records it reverting twice at a gasUsed below its estimate.
    [sender, send, writeContractAsync, say, refresh, rowIsReal],
  );

  // Post a block as a transaction: escrow the lot, forward the instruction.
  //
  // Everything checkable is checked from public reads first. The desk's own
  // history is the argument - the postRfq that ran on Coston2 failed on "ERC20:
  // insufficient allowance", and the only way to find that out was to pay for a
  // reverted transaction.
  const postOnChain = useCallback(
    async (lot: number, deadlineBlock: number, invited: string, reserve: bigint, pair: string) => {
      if (!address) return say("Connect a wallet first - posting on-chain is a transaction.");
      const lotUnits = BigInt(Math.max(0, Math.floor(lot)));
      const spender = sender;
      const token = TOKENS.FXRP.address;
      try {
        const pc = createPublicClient({ chain: coston2, transport: http() });
        const [balance, allowance] = await Promise.all([
          pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
          pc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [address, spender] }),
        ]);
        const pre = preflight({ lot: lotUnits, balance, allowance, deadlineBlock, head: headRef.current });
        if (!pre.ok) return say(`Cannot post on-chain: ${pre.blocker}`);

        // The settlement token has to exist. The address configured here had no
        // code on Coston2 for the whole of this desk's history, so every block
        // it posted escrowed a lot against a promise nobody could keep:
        // relayClearing calls transferFrom on nothing, and the pre-flight read
        // it back as "the winner has approved 0". One getCode says it plainly,
        // before the lot is escrowed rather than after.
        const quoteCode = await pc.getCode({ address: TOKENS.USDT0.address }).catch(() => undefined);
        if (!quoteCode || quoteCode === "0x") {
          return say(
            `No contract at the settlement token ${TOKENS.USDT0.address}. A block posted against it ` +
              "could never be settled, so it is not worth escrowing a lot for.",
          );
        }

        if (pre.needsApproval) {
          say(`Approving ${lotUnits} ${TOKENS.FXRP.symbol} to the escrow - one transaction, then the block.`);
          const a = await send({
            address: token, abi: erc20Abi, functionName: "approve", args: [spender, lotUnits],
          });
          await pc.waitForTransactionReceipt({ hash: a });
          say(`Approved: ${a}`);
        }

        // The floor, sealed to the enclave and carried by the transaction.
        //
        // This was `0x`, which cost more than the reserve: the PAIR travels in
        // the same envelope, so an on-chain block was recorded with no floor and
        // no pair name at all. A zero floor is the giveaway the post form
        // already refuses on the other rail.
        const encryptedReserve = await sealReserve(reserve, pair);
        const hash = await send({
          address: spender,
          abi: senderAbi,
          functionName: "postRfq",
          args: [TOKENS.USDT0.address, token, lotUnits, BigInt(deadlineBlock), (invited || ZERO) as Address, encryptedReserve],
          value: INSTRUCTION_FEE,
        });
        say(`Posted on-chain: ${hash}. The lot is escrowed and the instruction is on its way to the enclave.`);
        await pc.waitForTransactionReceipt({ hash });
        const count = await pc.readContract({ address: spender, abi: senderAbi, functionName: "rfqCount" });
        say(`Confirmed. rfqCount is now ${count} - the auction exists on-chain before the enclave has heard of it.`);
        setPanel("auto");
      } catch (e) {
        const m = e as { shortMessage?: string; message?: string };
        say(`On-chain post failed: ${m.shortMessage ?? m.message ?? String(e)}`);
      } finally {
        refresh();
      }
    },
    [address, sender, writeContractAsync, say, refresh],
  );

  // Seal a bid as a transaction.
  //
  // The direct rail records the commitment in enclave memory; only this puts it
  // in the set the contract keeps, and that set is what relayClearing checks the
  // clearing against. A commitment that never reached the chain cannot be part
  // of a settlement, so the demo rail can demonstrate the mechanism but never
  // complete it.
  const [sealingChain, setSealingChain] = useState<number | null>(null);
  const bidOnChain = useCallback(
    async (rfqId: number, amount: bigint) => {
      if (!address) return say("Connect a wallet - sealing on-chain is a transaction.");
      if (!rowIsReal()) return;
      setSealingChain(rfqId);
      try {
        const pc = createPublicClient({ chain: coston2, transport: http() });
        
        const [row, already] = await Promise.all([
          pc.readContract({ address: sender, abi: senderAbi, functionName: "rfqs", args: [BigInt(rfqId)] }),
          pc.readContract({ address: sender, abi: senderAbi, functionName: "hasBid", args: [BigInt(rfqId), address] }),
        ]);
        const pre = bidPreflight({
          exists: row[0] !== ZERO,
          cleared: row[6],
          deadlineBlock: Number(row[4]),
          head: headRef.current,
          invited: row[5],
          bidder: address,
          alreadyBid: already,
        });
        if (!pre.ok) return say(`Cannot seal on-chain: ${pre.blocker}`);

        // Winning means paying, so the approval belongs here - at the moment
        // the promise is made - and not at settlement, where it is somebody
        // else's transaction that reverts.
        //
        // Without it the auction reaches a signed clearing and stops: the
        // contract moves the price from the winner to the maker in the same
        // call that moves the lot, and it cannot, so nothing moves at all and
        // the lot stays escrowed. Approving the bid amount is enough - the
        // second price is never above it.
        const owed = await pc.readContract({
          address: row[1], abi: erc20Abi, functionName: "allowance", args: [address, sender],
        }).catch(() => null);
        if (owed === null) {
          return say(
            "The settlement token on this auction does not answer - it may not be a contract at all. " +
              "Nothing sealed here could ever be settled, so this stops now.",
          );
        }
        if (owed < amount) {
          say(`Approving ${amount} of the settlement token first - winning this means paying it.`);
          const a = await send({
            address: row[1], abi: erc20Abi, functionName: "approve", args: [sender, amount],
          });
          await pc.waitForTransactionReceipt({ hash: a });
          say(`Approved: ${a}`);
        }

        // Same commitment and the same sealed opening as the direct rail - only
        // the transport differs, which is the point.
        const sealed = await sealBidEnvelope({
          rfqId, bidder: address, amount, chainId,
          sign: (raw) => signMessageAsync({ message: { raw } }),
        });
        const hash = await send({
          address: sender, abi: senderAbi, functionName: "commitBid",
          args: [BigInt(rfqId), sealed.commitment, sealed.ciphertext],
          value: INSTRUCTION_FEE,
        });
        remember({ rfqId, bidder: address, amount: amount.toString(), nonce: sealed.nonce, commitment: sealed.commitment });
        say(`Sealed on-chain: ${hash}. The commitment is in the set the clearing has to match.`);
        await pc.waitForTransactionReceipt({ hash });
        say(`Confirmed. Nobody can read the amount, and nobody can drop the bid from the set either.`);
      } catch (e) {
        const m = e as { shortMessage?: string; message?: string };
        say(`On-chain bid failed: ${m.shortMessage ?? m.message ?? String(e)}`);
      } finally {
        setSealingChain(null);
        refresh();
      }
    },
    [address, chainId, sender, signMessageAsync, writeContractAsync, say, refresh, rowIsReal],
  );

  // Settle it. The only function that moves money, and the only one that makes
  // the whole design pay off: the contract will not settle a clearing whose
  // signature does not recover to the registered enclave, or whose set digest
  // is not the digest of the commitments IT recorded. An auctioneer who drops
  // an inconvenient bid produces a clearing that reverts.
  const [settling, setSettling] = useState<number | null>(null);
  // The last clearing this session produced, kept because settling needs the
  // signature and the action id - not just the winner and the price.
  const [lastOutcome, setLastOutcome] = useState<
    (ClearingOutcome & { actionId?: string; submissionTag?: string; signature?: string }) | null
  >(null);
  // Clearings this browser has been given and not yet settled. Loaded on mount
  // so a reload does not lose a signature the enclave will never issue again.
  const [kept, setKept] = useState<StoredClearing[]>([]);
  useEffect(() => setKept(allClearings()), []);
  const settle = useCallback(
    async (out: ClearingOutcome & { actionId?: string; submissionTag?: string; signature?: string }) => {
      if (!address) return say("Connect a wallet - settling is a transaction.");
      if (!rowIsReal()) return;
      setSettling(out.rfqId);
      try {
        const pc = createPublicClient({ chain: coston2, transport: http() });
        
        const [row, onChainDigest] = await Promise.all([
          pc.readContract({ address: sender, abi: senderAbi, functionName: "rfqs", args: [BigInt(out.rfqId)] }),
          pc.readContract({ address: sender, abi: senderAbi, functionName: "commitmentDigest", args: [BigInt(out.rfqId)] }).catch(() => null),
        ]);
        const allowance = await pc.readContract({
          address: row[1], abi: erc20Abi, functionName: "allowance", args: [out.winner as Address, sender],
        }).catch(() => 0n);

        const pre = relayPreflight({
          cleared: row[6],
          onChainDigest,
          outcomeDigest: out.setDigest as `0x${string}`,
          signature: out.signature as `0x${string}` | undefined,
          winnerAllowance: allowance,
          clearingPrice: BigInt(out.clearingPrice),
        });
        if (!pre.ok) return say(`Cannot settle: ${pre.blocker}`);

        const hash = await send({
          address: sender, abi: senderAbi, functionName: "relayClearing",
          args: [
            BigInt(out.rfqId), out.winner as Address, BigInt(out.clearingPrice),
            out.setDigest as `0x${string}`, (out.actionId ?? ZERO) as `0x${string}`,
            out.submissionTag ?? "submit", 1, out.signature as `0x${string}`,
          ],
        });
        say(`Settling: ${hash}. The winner pays the second price and the lot moves in the same transaction.`);
        await pc.waitForTransactionReceipt({ hash });
        forgetClearing(out.rfqId);
        setKept(allClearings());
        // And drop it from state, or forgetting it changes nothing.
        //
        // The panel picks `lastOutcome` before it looks in storage, so clearing
        // the stored copy left the stale one in front of it: the session that
        // actually settled the auction kept being offered "Settle on-chain" for
        // it, and pressing that got "Already settled on-chain." A fresh reload
        // showed it correctly, which is why this survived - the only session
        // that could see the bug was the one that had just done the work.
        setLastOutcome((cur) => (cur?.rfqId === out.rfqId ? null : cur));
        say(`Settled on-chain. Delivery versus payment, and the losing amounts were never revealed to anyone.`);
      } catch (e) {
        const m = e as { shortMessage?: string; message?: string };
        say(`Settlement failed: ${m.shortMessage ?? m.message ?? String(e)}`);
      } finally {
        setSettling(null);
        refresh();
      }
    },
    [address, sender, writeContractAsync, say, refresh, rowIsReal],
  );

  // Ask for the clearing ON-CHAIN, then wait for the enclave to sign it.
  //
  // The Clear button went down the direct channel, which a production stack
  // refuses (BUTA_ALLOW_DIRECT_AUCTION is a demo switch and is off there) and
  // whose facade signs nothing anyway. So the desk could reach a clearing it
  // could never settle: relayClearing will not take an unsigned outcome. This
  // is the path the script proved, in the product.
  const [requesting, setRequesting] = useState<number | null>(null);
  const requestClearingOnChain = useCallback(
    async (rfqId: number) => {
      if (!address) return say("Connect a wallet - requesting a clearing is a transaction.");
      if (!rowIsReal()) return;
      setRequesting(rfqId);
      try {
        const pc = createPublicClient({ chain: coston2, transport: http() });
        // Asking again is the documented recovery when the first dispatch comes
        // back empty, and the enclave answers a repeat from its own memory. The
        // CONTRACT is the one that stops: requestClearing reverts AlreadyCleared
        // once relayClearing has settled the row. That is a paid transaction
        // that can only fail, so it is refused here rather than sent - and the
        // guard lives in the one function every caller routes through.
        const onChain = await pc.readContract({
          address: sender, abi: senderAbi, functionName: "rfqs", args: [BigInt(rfqId)],
        });
        if (onChain[6]) {
          return say(
            `RFQ ${rfqId} is already settled on-chain - requestClearing would revert AlreadyCleared. ` +
              "The outcome moved the money; there is nothing left to ask the enclave for.",
          );
        }
        const hash = await send({
          address: sender, abi: senderAbi, functionName: "requestClearing",
          args: [BigInt(rfqId)], value: INSTRUCTION_FEE,
        });
        say(`Clearing requested on-chain: ${hash}. The enclave opens the bids and signs the outcome.`);
        const rcpt = await pc.waitForTransactionReceipt({ hash });
        const id = instructionIdFrom(rcpt.logs);
        if (!id) return say("The diamond logged no instruction id, so there is nothing to wait on.");

        const signed = await awaitSignedClearing(env.teeProxyUrl, id);
        if (!signed) {
          // Press it again - that is not a shrug, it is the fix.
          //
          // The FIRST delivery is the unreliable one: the instruction travels
          // through the data providers, and when Coston2 is between signing
          // policies that round can produce nothing for the id we asked about.
          // A second request is answered from the enclave's memory in seconds,
          // because the auction is already cleared and a repeat returns the
          // stored outcome rather than an error. Saying so beats leaving
          // somebody staring at a dead panel deciding the product is broken.
          return say(
            "No signed outcome came back for that request. The clearing itself may well have happened - " +
              "press Request clearing again. A repeat is answered from the enclave's memory, usually in seconds, " +
              "because it returns the outcome it already computed. (On the dev facade there is no signature at all, " +
              "and no number of retries will produce one.)",
          );
        }
        const [oRfq, winner, price, digest] = decodeAbiParameters(
          [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
          signed.data,
        );
        // The id the CONTRACT knows, not the one the enclave echoed back.
        // relayClearing is a contract call: it reads rfqs[id] and compares the
        // digest of the commitments IT recorded, so settling under the enclave's
        // own numbering reads the wrong row. They should agree - and when they
        // do not, that is worth a sentence rather than silently picking one.
        if (Number(oRfq) !== rfqId) {
          return say(
            `The enclave signed an outcome for RFQ ${oRfq}, and this desk asked about RFQ ${rfqId}. ` +
              "Not settling that - the two are not the same auction.",
          );
        }
        setLastOutcome({
          rfqId, winner, clearingPrice: Number(price), bidCount: 0, setDigest: digest,
          actionId: signed.actionId, submissionTag: signed.submissionTag, signature: signed.signature,
        });
        // Written down before anything else can go wrong. The enclave computes
        // this exactly once and then keeps it: a repeat request returns the
        // stored outcome rather than recomputing, which is what makes asking
        // again the fix rather than a shrug. Storing it here is still what
        // stops a reload between this line and the settlement from stranding
        // the lot, since the signature only ever lives in the browser that
        // asked for it.
        rememberClearing({
          rfqId, instructionId: id, data: signed.data, actionId: signed.actionId,
          submissionTag: signed.submissionTag, signature: signed.signature,
          winner, clearingPrice: Number(price), setDigest: digest,
        });
        setKept(allClearings());
        say(`Signed by the enclave for RFQ ${rfqId}: ${winner} wins at ${price}. Settle it to move the lot and the payment.`);
      } catch (e) {
        const m = e as { shortMessage?: string; message?: string };
        say(`Clearing request failed: ${m.shortMessage ?? m.message ?? String(e)}`);
      } finally {
        setRequesting(null);
        refresh();
      }
    },
    [address, sender, writeContractAsync, say, refresh, rowIsReal],
  );

  const openCount = rfqs.filter((r) => !r.cleared).length;
  const sealedBids = rfqs.reduce((n, r) => n + (r.cleared ? 0 : r.bidCount), 0);

  const NAV = [
    ["auto", "Book"],
    ["folio", "Portfolio"],
    ["activity", "Activity"],
    ["audit", "Audit"],
  ] as const;

  // All / Open / Mine. "Mine" is the maker's own blocks - the one cut a desk
  // actually wants, and it needs no extra read because the maker is public.
  const shown = rfqs.filter((r) =>
    filter === "open" ? !r.cleared
    : filter === "mine" ? !!address && r.maker.toLowerCase() === address.toLowerCase()
    : true,
  );

  return (
    // Sans for everything a person reads, mono kept where it earns its keep:
    // the book's columns, ids, hashes and addresses. Setting mono on the whole
    // desk made prose harder to read to buy alignment that only the table needs.
    <div className="min-h-screen bg-bg text-fg text-[13.5px] md:flex">
      {/* ── sidebar ──
          Identity, the three places you can be, and the state of the desk - 
          all of it permanent, so the reader is never asked to remember which
          tab they were on or click something to find out where they are. On a
          phone it lays out along the top instead. */}
      <aside className="md:w-[13.5rem] md:shrink-0 md:sticky md:top-0 md:h-screen md:border-r-2 md:border-fg bg-bg flex flex-col">
        <div className="px-4 py-3 border-b border-line">
          <div className="font-macro text-[17px] tracking-tight uppercase leading-none" style={{ fontFamily: "var(--f-macro)" }}>
            BUTA<Red>®</Red>
          </div>
          <div className="mt-1 text-[11.5px] tracking-[0.12em] uppercase text-fg-mute">
            [ SEALED-BID OTC DESK ]
          </div>
        </div>

        {/* The chain this desk is on, stated once and permanently. */}
        {/* items-start and a shrink-0 dot: with items-center the label had no
            room to wrap, so "TEE PRODUCTION" ran straight out through the right
            border of its own box. */}
        <div className="hidden md:flex items-start gap-2 mx-4 my-3 px-2.5 py-1.5 border border-line bg-bg-1 text-[11.5px] tracking-[0.1em] uppercase text-fg-mute leading-snug">
          <span className={"mt-1 w-1.5 h-1.5 shrink-0 " + (tee.state === "production" ? "bg-accent" : "bg-fg-mute")} />
          <span className="min-w-0">
            {/* "TEE PRODUCTION" is the FCC registry's word for a machine that
                passed its availability check. It is not a claim about hardware,
                and the badge read as one: the footer says simulated-TEE path a
                screen below, and the landing page says so too. The status and
                what it does not mean now sit in the same line. */}
            {tee.state === "production" ? <>Coston2 <Red>///</Red> TEE production, simulated path</>
              : offline ? <Red>Extension offline</Red>
              : <>Coston2 <Red>///</Red> simulated TEE</>}
          </span>
        </div>

        {/* A way back out. The desk had two links in the whole page and neither
            went to the landing, the pitch or the source, so a reader who landed
            here first had nowhere to go for the argument behind it. */}
        <div className="hidden md:flex gap-3 px-4 pt-3 pb-1 text-[11.5px] tracking-[0.1em] uppercase text-fg-mute">
          <a className="hover:text-accent" href="/" rel="noopener">Landing</a>
          <a className="hover:text-accent" href="/deck" rel="noopener">Pitch</a>
          <a className="hover:text-accent" href="https://github.com/PugarHuda/buta" target="_blank" rel="noopener">Source</a>
        </div>

        {/* The one move that starts everything, and the only one that needs no
            auction selected. It was a tab, then a button in a strip; it belongs
            at the top of the sidebar where a primary action is looked for. */}
        <div className="px-4 pb-3">
          <button
            onClick={() => setPanel("post")}
            className={
              "w-full px-3 py-2.5 text-[11px] tracking-[0.12em] uppercase border transition-colors " +
              (panel === "post"
                ? "bg-fg text-bg border-fg"
                : "bg-accent text-bg border-accent hover:bg-fg hover:border-fg")
            }
          >
            + Post a block
          </button>
        </div>

        {/* Wraps on a phone. Four tabs side by side at px-4 come to 347px, so at
            320px the nav alone pushed the page 27px wide - the last thing left
            overflowing after the book's columns were made to drop. */}
        <nav className="flex flex-wrap md:flex-col border-y border-line">
          {NAV.map(([id, label]) => (
            <button
              key={id}
              onClick={() => setPanel(id)}
              className={
                "flex-1 md:flex-none text-left px-3 md:px-4 py-2.5 text-[11.5px] tracking-[0.12em] uppercase border-r md:border-r-0 md:border-b border-line " +
                (panel === id ? "bg-fg text-bg" : "text-fg-mute hover:text-fg hover:bg-bg-1")
              }
            >
              {panel === id ? <><Red>▸</Red> {label}</> : <span className="md:pl-3">{label}</span>}
            </button>
          ))}
        </nav>

        {/* The state of the desk. It used to exist only as "6 on the desk" in
            the book header, which said nothing about how many could be bid on. */}
        <div className="hidden md:block px-4 py-3 border-b border-line">
          <Lbl>On the desk</Lbl>
          <dl className="mt-2 flex flex-col gap-2">
            {[
              ["Open", openCount, "still taking bids"],
              ["Sealed bids", sealedBids, "committed, unreadable"],
              ["Cleared", rfqs.length - openCount, "settled, second price"],
            ].map(([label, value, hint]) => (
              <div key={String(label)}>
                <dt className="text-[11.5px] tracking-[0.1em] uppercase text-fg-mute">{label}</dt>
                <dd className="text-[17px] leading-tight" style={{ fontFamily: "var(--f-macro)" }}>
                  {String(value)}
                </dd>
                <div className="text-[11.5px] text-fg-mute leading-tight">{hint}</div>
              </div>
            ))}
          </dl>
        </div>

        <div className="hidden md:block flex-1" />

        {/* Connecting is the last thing a first-time reader needs and the first
            thing a returning one does, so it sits at the foot of the sidebar
            rather than competing with the masthead. */}
        <div className="hidden md:block px-4 py-3 border-t border-line">
          <a
            href={`https://coston2-explorer.flare.network/address/${TOKENS.FXRP.address}`}
            target="_blank" rel="noopener"
            className="block mb-3 text-[11.5px] tracking-[0.1em] uppercase text-fg-mute hover:text-accent"
            title="FXRP on Coston2"
          >
            SETTLES IN FXRP <Red>///</Red> {TOKENS.FXRP.address.slice(0, 6)}…
          </a>
          <ConnectButton showBalance={false} accountStatus="address" chainStatus="none" />
        </div>
      </aside>

      {/* ── everything else ── */}
      <div className="flex-1 min-w-0">
      <header className="md:hidden sticky top-0 z-40 bg-bg">
        <div className="flex items-center gap-4 px-4 py-2 justify-end">
          <span className="text-[11.5px] tracking-[0.1em] uppercase text-fg-mute">
            {tee.state === "production" ? (
              <>TEE <Red>PRODUCTION</Red></>
            ) : offline ? (
              <Red>EXTENSION OFFLINE</Red>
            ) : (
              <>SIMULATED TEE</>
            )}
          </span>
          <ConnectButton showBalance={false} accountStatus="address" chainStatus="none" />
        </div>
        <div className="h-[3px] bg-fg" />
      </header>

      {demo && (
        // Two facts, and the banner used to run them together in one uppercase
        // paragraph that was the longest thing on the page. The book below is
        // demo data; the machine is real. Say the first here and leave the
        // second to the Audit panel, which links it to the explorer.
        <div className="px-4 py-1.5 bg-accent text-bg text-[11.5px] tracking-[0.12em] uppercase">
          Demo book <span className="opacity-70"> - no enclave reachable from this browser.</span>{" "}
          <span className="opacity-70">Start it with <span className="opacity-100">VITE_ALLOW_UNVERIFIED_TEE_KEY=1 go run ./cmd/dev</span> for the live flow (the flag matters: cmd/dev registers nothing, so without it the desk seals to the registered machine's key and the local facade cannot open it);{" "}
          the machine itself is registered - see Audit.</span>
        </div>
      )}
      {/* who this is for - the first thing a judge reads */}
      <p className="px-4 py-3 max-w-[72ch] text-[12.5px] leading-relaxed text-fg-dim">
        For desks moving size. Post a block, collect sealed bids, clear at the fair second
        price. <b className="text-fg">Nobody can read a bid before it clears - not the maker,
        not the operator, not us.</b> Losing amounts are never revealed at all.
      </p>

      <Claims />
      <TryIt live={!demo && !offline} />

      {/* On a phone the sidebar's counts are hidden, so they belong here. */}
      <div className="md:hidden flex flex-wrap items-stretch border-t border-line">
        {[
          ["Open", openCount],
          ["Sealed bids", sealedBids],
          ["Cleared", rfqs.length - openCount],
        ].map(([label, value]) => (
          <div key={String(label)} className="px-4 py-2 border-r border-line min-w-[7rem]">
            <Lbl>{label}</Lbl>
            <div className="text-[15px] leading-tight" style={{ fontFamily: "var(--f-macro)" }}>
              {String(value)}
            </div>
          </div>
        ))}
      </div>
      <div className="h-px bg-line" />

      <main className="bg-bg min-h-[70vh]">
        {panel === "post" ? (
          <div className="max-w-[44rem]">
            <Head eyebrow={<>Buta <Red>·</Red> open a block</>}>Post a block</Head>
            <div className="px-4 pb-4"><PostForm
              address={address}
              block={block}
              onChain={postOnChain}
              // Only leave the form when the block was actually posted. It
              // reports failures through the same callback with id 0, and
              // closing the form on those threw away what was typed along with
              // the message explaining why it did not go through.
              onDone={(m, id) => {
                say(m);
                if (id) {
                  setSelected(id);
                  setPanel("auto");
                }
                refresh();
              }}
            /></div>
          </div>
        ) : panel === "folio" ? (
          <div>
            <Head eyebrow={<>Buta <Red>·</Red> your positions</>}>Portfolio</Head>
            <div className="px-4 pb-4"><Folio address={address} onLog={say} /></div>
          </div>
        ) : panel === "activity" ? (
          <div>
            <Head eyebrow={<>Buta <Red>·</Red> this session</>}>Activity</Head>
            <div className="px-4 pb-4">
              {activity.length === 0 ? (
                <p className="text-fg-mute max-w-[46ch] leading-relaxed">
                  Nothing yet. Post a block or seal a bid, and every receipt the desk hands back
                  is kept here - including the clearing outcomes, which used to be overwritten by
                  whatever happened next.
                </p>
              ) : (
                <div className="border border-line divide-y divide-line max-w-[64rem]">
                  {activity.map((a, i) => (
                    <div key={`${a.at}-${i}`} className="flex gap-3 px-3 py-2">
                      <span className="text-fg-mute shrink-0">{a.at}</span>
                      {/* Receipts carry addresses and digests inline, so this
                          reads as data even though it is written as prose. */}
                      <span className="text-fg-dim break-all leading-relaxed font-mono text-[12.5px]">{a.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : panel === "audit" ? (
          <Audit tee={tee} sender={sender} />
        ) : (
          <>
            {/* The privacy property, stated above the book rather than left for
                the reader to infer from a table full of numbers. */}
            <div className="flex flex-wrap items-end">
              <Head eyebrow={<>Lot and deadline public <Red>·</Red> bid amounts and reserve sealed</>}>
                Open blocks
              </Head>
              <span className="flex-1" />
              <div className="px-4 pb-3 flex flex-wrap items-baseline gap-4">
              <div className="flex">
                {(["all", "open", "mine"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={
                      "px-3 py-1 text-[11.5px] tracking-[0.12em] uppercase border border-line -ml-px first:ml-0 " +
                      (filter === f ? "bg-fg text-bg border-fg" : "text-fg-mute hover:text-fg")
                    }
                  >
                    {f}
                  </button>
                ))}
              </div>
              <span className="text-[11.5px] tracking-[0.1em] uppercase text-fg-mute">
                {shown.length} shown
                {/* A desk that quietly renders fewer rows than the enclave sent
                    is hiding a disagreement between the two. */}
                {dropped > 0 && (
                  <>
                    {" "}
                    <Red>
                      · {dropped} unreadable {dropped === 1 ? "row" : "rows"} dropped
                    </Red>
                  </>
                )}
              </span>
              </div>
            </div>

            {/* The book is eight columns of fixed widths, which comes to about
                700px - so on a phone it pushed the page 313px wider than the
                viewport, and the repo's own rule is that the body must never
                scroll sideways. It went unmeasured because the render checks
                only ever loaded the landing page at narrow widths; the desk was
                never looked at on a phone at all.
                Columns drop instead of the page stretching. Lot, bids and the
                deadline are all in the panel that opens under the row, so
                nothing is lost - and the redaction bar survives to the smallest
                layout that fits it, because that bar is the claim. */}
            <div className="grid grid-cols-[4.5rem_1fr_4.5rem_5rem] sm:grid-cols-[4.5rem_1fr_4rem_4.5rem_5rem] md:grid-cols-[5.5rem_1fr_7rem_6rem_4rem_8rem_6rem_5.5rem] gap-2 md:gap-3 px-4 py-2 border-y border-line bg-bg-1 text-[11px] font-medium tracking-[0.1em] uppercase text-fg-mute">
              <span>RFQ</span><span>Pair</span><span className="hidden md:block">Lot</span>
              <span className="hidden sm:block">Res</span>
              <span className="hidden md:block">Bids</span><span className="hidden md:block">Deadline</span>
              <span>Status</span><span />
            </div>

            {shown.length === 0 && (
              <p className="px-4 py-6 text-fg-mute">
                {/* An empty state that has not asked anything yet is a lie.
                    The first book request travels browser to proxy to a tunnel
                    to a container, which takes seconds, and for that whole
                    window the desk said "No blocks yet. Post the first one."
                    to somebody looking at a desk with four auctions on it. It
                    was caught by recording the page for a video: the flagship
                    shot was an empty product. */}
                {!loadedOnce
                  ? "Reading the book from the enclave."
                  : rfqs.length === 0
                  ? offline
                    ? "No enclave is answering this browser, so there is no book to show. The contract and its settlements are still on Coston2 - see Audit."
                    : "No blocks yet. Post the first one."
                  : filter === "mine"
                    ? "None of these are yours. Post a block, or switch the filter back to All."
                    : "Nothing open right now. Switch the filter back to All to see what has cleared."}
              </p>
            )}

            {shown.map((r) => (
              <div key={r.rfqId} className="border-b border-line-2/40">
                {/* A row is clickable, and nothing said so: same paper, same
                    ink, no cursor, no edge. Selected now carries a red rule on
                    the left so the open panel below is visibly attached to the
                    row it belongs to. */}
                <div
                  className={
                    "flex items-stretch cursor-pointer border-l-[3px] transition-colors " +
                    (selected === r.rfqId
                      ? "bg-bg-2 border-l-accent"
                      : "border-l-transparent hover:bg-bg-1 hover:border-l-line-2")
                  }
                >
                  {/* The row and its action are siblings, not nested - a button
                      inside a button is invalid and the inner one stops working. */}
                  <button
                    onClick={() => { setSelected(r.rfqId); setPanel("auto"); }}
                    className="flex-1 min-w-0 text-left grid grid-cols-[4.5rem_1fr_4.5rem] sm:grid-cols-[4.5rem_1fr_4rem_4.5rem] md:grid-cols-[5.5rem_1fr_7rem_6rem_4rem_8rem_6rem] gap-2 md:gap-3 px-4 py-3 items-center font-mono text-[13px]"
                  >
                    <span className="text-fg-mute">RFQ-{String(r.rfqId).padStart(3, "0")}</span>
                    <span>
                      {r.pair}
                      {/* Whose block this is, on the row rather than only in a
                          filter. A maker scanning the book should not have to
                          switch views to see which ones are theirs. */}
                      {!!address && r.maker.toLowerCase() === address.toLowerCase() && (
                        <span className="ml-2 px-1 border border-accent text-accent text-[10.5px] tracking-[0.1em] align-middle">
                          YOURS
                        </span>
                      )}
                      {myRfqs.has(r.rfqId) && (
                        <span
                          className="ml-2 px-1 border border-line text-fg-dim text-[10.5px] tracking-[0.1em] align-middle"
                          title="You have a sealed bid on this auction. The enclave accepts one per address."
                        >
                          BID SEALED
                        </span>
                      )}
                    </span>
                    <span className="hidden md:block">{r.lot.toLocaleString()}</span>
                    {/* A redaction bar, not the word "hidden". The reserve is a
                        number that exists and cannot be read, and the desk should
                        look like that on every row. */}
                    <span className="hidden sm:block">
                      <span
                        role="img"
                        aria-label="Reserve sealed, encrypted to the enclave"
                        className="inline-block w-10 md:w-14 h-[11px] bg-fg align-middle"
                        title="The maker's floor is ECIES-encrypted to the enclave key. Nobody else can read it - not the operator, not us."
                      />
                    </span>
                    <span className="hidden md:block">{r.bidCount}</span>
                    <span className="hidden md:block text-fg-mute leading-tight">
                      {/* data-volatile: both of these move with the chain, so
                          the pixel baseline overwrites them rather than failing
                          every run for the chain's reasons. */}
                      <span data-volatile>blk {r.deadline.toLocaleString()}</span>
                      {!r.cleared && countdown(r.deadline, block).text && (
                        <span
                          data-volatile
                          className={"block text-[11.5px] " + (countdown(r.deadline, block).passed ? "text-accent" : "")}
                        >
                          {countdown(r.deadline, block).text}
                        </span>
                      )}
                    </span>
                    <span>
                      <span
                        className={
                          "px-1.5 py-0.5 border text-[11.5px] tracking-[0.1em] uppercase " +
                          (r.cleared ? "border-accent text-accent" : "border-line text-fg-mute")
                        }
                      >
                        {r.cleared ? "CLEARED" : "SEALED"}
                      </span>
                    </span>
                  </button>
                  {/* The action is on the row it acts on. It used to be a panel
                      on the other side of the screen that you had to look at
                      after clicking, which is why the desk read as two things. */}
                  {/* The action on the row, at the weight of an action - and
                      naming the action that is actually available. An auction
                      past its deadline takes no more bids, and this said "Bid"
                      on it anyway; the only thing left to do there is clear it,
                      which is what the panel underneath offers. */}
                  <button
                    onClick={() => { setSelected(r.rfqId); setPanel("auto"); }}
                    className={
                      "w-[4.5rem] md:w-[5.5rem] shrink-0 my-2 mr-2 md:mr-4 py-1.5 text-[12px] font-semibold border transition-all active:translate-y-px " +
                      (r.cleared
                        ? "bg-white text-fg border-line-2 hover:border-fg hover:bg-bg-1"
                        : "bg-accent text-white border-accent hover:bg-[var(--accent-deep)] hover:border-[var(--accent-deep)]")
                    }
                  >
                    {r.cleared
                      ? "View"
                      : block === null
                        // The head is unreadable, so which action is available
                        // is unknown. "Bid →" was the old default and it was a
                        // guess - on an auction 12,000 blocks past its deadline
                        // it was the wrong one.
                        ? "Open"
                        : countdown(r.deadline, block).passed
                          ? "Clear"
                          : "Bid →"}
                  </button>
                </div>

                {/* The selected row opens under itself. One column, one place to
                    look, and the auction it belongs to is directly above it. */}
                {selected === r.rfqId && (
                  <div className="px-4 py-4 bg-bg-1 border-t border-line">
                    {r.cleared ? (
                      <>
                      <div className="grid sm:grid-cols-3 gap-px bg-line border border-line">
                        <div className="bg-bg px-3 py-2.5">
                          <Lbl>Winner</Lbl>
                          <div className="mt-1 break-all font-mono text-[12.5px]">{r.winner}</div>
                        </div>
                        <div className="bg-bg px-3 py-2.5">
                          <Lbl>Clearing price</Lbl>
                          {/* Who says so. The contract checks the enclave's
                              signature before it settles; the direct rail's
                              facade signs nothing at all, so a receipt from it
                              is the operator's word and should read that way
                              rather than looking identical to a proven one. */}
                          <div className="mt-1 text-[11.5px] text-fg-mute leading-relaxed">
                            {demo || offline
                              ? "Demo book - nothing here was signed."
                              : "Relayed without a signature on this rail: the enclave's signature is checked on-chain by relayClearing, not here."}
                          </div>
                          <div className="mt-1 text-[15px]" style={{ fontFamily: "var(--f-macro)" }}>
                            {r.clearingPrice?.toLocaleString()}
                          </div>
                          <div className="text-[11.5px] text-fg-mute">Vickrey second price</div>
                        </div>
                        <div className="bg-bg px-3 py-2.5">
                          <Lbl>Sealed forever</Lbl>
                          {/* The commitments, listed. "N losing amounts" is a
                              number you take on trust; the hashes are the thing
                              itself - each one was recorded on-chain before
                              anyone knew what was in it, and none of them can be
                              opened by anyone but the bidder who made it. */}
                          {!!r.commitments?.length && (
                            <div className="mt-1 mb-2 flex flex-col gap-0.5">
                              {r.commitments.map((c, i) => (
                                <div key={c} className="flex items-baseline gap-2 text-[11.5px]">
                                  <span className="text-fg-mute">bid {i + 1}</span>
                                  {/* A column of commitments only reads as a column
                                      if every line is the same width - and
                                      tabular-nums does nothing for a-f. */}
                                  <span className="text-fg-dim font-mono">{c.slice(2, 16)}…</span>
                                  <span className="inline-block w-8 h-[9px] bg-fg align-middle" title="amount sealed" />
                                </div>
                              ))}
                            </div>
                          )}
                          {/* "0 losing amounts, the winner's own bid, and the
                              reserve" is a strange thing to read on a one-bid
                              auction, and it is the sentence that carries the
                              product's claim. Say the true thing for the case. */}
                          <div className="mt-1">
                            {r.bidCount <= 1
                              ? "The winner's own bid and the reserve. It cleared at the reserve - there was no second bid to price it."
                              : `${r.bidCount - 1} losing ${r.bidCount - 1 === 1 ? "amount" : "amounts"}, the winner's own bid, and the reserve.`}
                          </div>
                        </div>
                      </div>
                      {/* The enclave has cleared it. Whether the CONTRACT has
                          settled it is a different question, and until it does
                          this row still has work left on it.
                          The signature comes from state if this session
                          produced it, and from storage if an earlier one did - 
                          the enclave will not issue it twice. */}
                      {(() => {
                        const held =
                          lastOutcome?.rfqId === r.rfqId
                            ? lastOutcome
                            : kept.find((c) => c.rfqId === r.rfqId);
                        return held ? (
                          <SettleBlock
                            outcome={held}
                            busy={settling === r.rfqId}
                            onSettle={() => settle({ ...held, bidCount: 0 } as never)}
                          />
                        ) : (
                          <RequestClearingBlock
                            busy={requesting === r.rfqId}
                            onRequest={() => requestClearingOnChain(r.rfqId)}
                            signedAlready
                          />
                        );
                      })()}
                      </>
                    ) : (
                      // max-w on the form: a bid is one number, and the field
                      // was stretching the full width of the panel for it.
                      <div className="grid lg:grid-cols-[minmax(0,34rem)_20rem] gap-6">
                        {/* No bid form past the deadline. commitBid is refused
                            after it, so the form was a page of controls that
                            could only fail - and the longest thing on screen
                            for a row whose only remaining move is to clear. */}
                        {block !== null && countdown(r.deadline, block).passed ? (
                          <div>
                            <Lbl>Bidding closed</Lbl>
                            <p className="mt-1 text-[11.5px] text-fg-mute leading-relaxed max-w-[40ch]">
                              Block {r.deadline.toLocaleString()} has passed, so no further bid can be
                              sealed on this one. {r.bidCount === 0
                                // This said clearing returns the lot, which is
                                // false and expensive: the enclave answers an
                                // empty auction with "no bids" and signs
                                // nothing, so requestClearing is a paid
                                // transaction that can never produce a
                                // settlement - and the desk then advises
                                // pressing it again. reclaimLot is the only
                                // call that moves the lot back.
                                ? "Nothing was bid. Clearing cannot settle an empty auction - the maker takes the lot back with reclaimLot, which anyone may call for them once the deadline has passed."
                                : `${r.bidCount} sealed ${r.bidCount === 1 ? "bid is" : "bids are"} waiting to be opened.`}
                            </p>
                          </div>
                        ) : (
                        <BidForm
                          sel={r}
                          address={address}
                          busyChain={sealingChain === r.rfqId}
                          onChain={(amount) => bidOnChain(r.rfqId, amount)}
                          onDone={(m) => { say(m); refresh(); }}
                        />
                        )}
                        <div className="lg:border-l lg:border-line lg:pl-6">
                          {/* This used to ask "Past the deadline?" - a question
                              the desk can answer from one eth_blockNumber, and
                              it offered the same button on an auction with two
                              hours left as on one that closed yesterday. */}
                          <Lbl>Clearing</Lbl>
                          <p className="mt-1 mb-2 text-[11.5px] text-fg-mute leading-relaxed max-w-[26ch]">
                            {block === null
                              ? "Cannot read the chain's head, so whether the deadline has passed is unknown."
                              : countdown(r.deadline, block).passed
                                ? `Block ${r.deadline.toLocaleString()} is behind us - this can be cleared now.`
                                : `Not until block ${r.deadline.toLocaleString()}, ${countdown(r.deadline, block).text}.`}
                          </p>
                          {/* Nothing to press before the deadline.
                              requestClearing reverts DeadlineNotReached and the
                              enclave refuses too, so an auction with two hours
                              left was offering two paid transactions that could
                              only fail - the same mistake as offering to bid on
                              a cleared auction, which the desk already refuses
                              to make. The countdown above says when, and this
                              says what will appear. */}
                          {/* Fails to "no controls", not to "all controls".
                              This read `block !== null && !passed`, so an
                              unreadable chain head made the condition false and
                              fell through to the else - offering a paid
                              requestClearing on an auction days from its
                              deadline, directly under a line saying we could not
                              tell whether the deadline had passed. The bid form
                              two columns over already failed the safe way. */}
                          {block === null || !countdown(r.deadline, block).passed || r.bidCount === 0 ? (
                            <p className="mt-2 text-[11.5px] text-fg-mute max-w-[30ch] leading-relaxed">
                              {block === null
                                ? "Nothing to press until the chain's head can be read - clearing before the deadline is refused by the contract, and we cannot tell yet which side of it this is."
                                : !countdown(r.deadline, block).passed
                                  ? "Clearing opens at that block, for anyone - liveness never depends on the maker. Nothing to press until then."
                                  // An empty auction has nothing to clear. The
                                  // enclave answers "no bids" and signs
                                  // nothing, so every clearing control here was
                                  // a paid transaction that could not end in a
                                  // settlement.
                                  : "No bids arrived, so there is nothing to open. Reclaiming is what closes this one."}
                            </p>
                          ) : (
                            <>
                              {/* The rail that can actually be settled comes
                                  first. The direct channel below reaches a
                                  clearing relayClearing will never accept, and
                                  the deployment refuses it outright. */}
                              <RequestClearingBlock
                                busy={requesting === r.rfqId}
                                onRequest={() => requestClearingOnChain(r.rfqId)}
                                signedAlready={false}
                              />

                              <div className="mt-3 pt-3 border-t border-line flex flex-col items-start gap-2">
                                <Btn
                                  quiet
                                  onClick={async () => {
                                    try {
                                      const out = await clearAuction(r.rfqId);
                                      setLastOutcome(out);
                                      say(
                                        `Cleared RFQ ${out.rfqId}: winner ${out.winner} at ${out.clearingPrice.toLocaleString()} (second price, ${out.bidCount} bids). Set digest ${out.setDigest.slice(0, 10)}…`
                                      );
                                      refresh();
                                    } catch (e) {
                                      say(String((e as Error).message));
                                    }
                                  }}
                                >
                                  Clear over the direct rail
                                </Btn>
                                <span className="text-[11.5px] text-fg-mute max-w-[30ch] leading-relaxed">
                                  No signature, so it cannot settle. Refused on the deployed desk.
                                </span>
                              </div>
                            </>
                          )}

                          {/* Settling is the step that makes the rest pay off.
                              The contract refuses a clearing whose signature
                              does not recover to the registered enclave, or
                              whose digest is not the digest of the commitments
                              IT recorded - so an auctioneer who dropped a bid
                              produces a settlement that reverts. */}
                          {lastOutcome?.rfqId === r.rfqId && (
                            <SettleBlock
                              outcome={lastOutcome}
                              busy={settling === r.rfqId}
                              onSettle={() => settle(lastOutcome)}
                            />
                          )}

                          {/* Your own block, past its deadline, with nothing on
                              it. reclaimLot has been in the contract from the
                              start with no way to call it: a maker who drew no
                              bid had escrowed a lot and no route back to it
                              except a hand-written transaction. */}
                          {/* Anyone, not just the maker. reclaimLot only ever
                              sends the lot back to whoever posted it, and the
                              contract lets any caller do that once the deadline
                              has passed - so hiding the control from everybody
                              else left an escrowed lot with, for most readers,
                              no visible way home. */}
                          {countdown(r.deadline, block).passed && (
                              <div className="mt-4 pt-4 border-t border-line">
                                <Lbl>{!!address && r.maker.toLowerCase() === address.toLowerCase() ? "Your lot" : "The lot"}</Lbl>
                                <p className="mt-1 mb-2 text-[11.5px] text-fg-mute leading-relaxed max-w-[30ch]">
                                  {r.bidCount === 0
                                    ? "Nobody bid. The lot goes back to the maker - anyone may send it, it can only go there."
                                    : `${r.bidCount} sealed ${r.bidCount === 1 ? "bid" : "bids"} are on this. Reclaiming closes it without clearing them.`}
                                </p>
                                <Btn
                                  quiet
                                  busy={reclaiming === r.rfqId}
                                  onClick={() => reclaim(r.rfqId)}
                                >
                                  Reclaim the lot
                                </Btn>
                              </div>
                            )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </>
        )}

        {/* The most recent line stays in view wherever you are - feedback has to
            be where the action was. The rest is kept under Activity. */}
        {latest && panel !== "activity" && (
          <p className="mx-4 mt-6 pt-4 border-t border-line text-[11px] leading-relaxed text-fg-dim break-all">
            <Red>&gt;&gt;&gt;</Red> {latest}
            {activity.length > 1 && (
              <button
                onClick={() => setPanel("activity")}
                className="ml-3 text-[11.5px] tracking-[0.1em] uppercase text-fg-mute hover:text-accent"
              >
                {activity.length - 1} more <Red>▸</Red>
              </button>
            )}
          </p>
        )}
      </main>

      <footer className="border-t-2 border-fg px-4 py-3 flex flex-wrap gap-x-6 gap-y-1 text-[11.5px] tracking-[0.08em] uppercase text-fg-mute">
        <span>BUTA<Red>®</Red> - sealed-bid OTC on Flare Confidential Compute</span>
        {/* "not deployed" sat three lines under a chip reading TEE PRODUCTION,
            which is a contradiction to anyone reading top to bottom. Both were
            true and neither said which sense it meant. */}
        <span>Coston2 testnet only <Red>///</Red> simulated-TEE path <Red>///</Red> not audited</span>
      </footer>
      </div>
    </div>
  );
}

// ── what this is, and why it takes an enclave ────────────────────────────────

/**
 * The three claims, where a reader lands.
 *
 * The desk led with what it does and never said why it takes an enclave to do
 * it - which is the first question anybody serious asks, and the one a sealed
 * bid on a public chain usually cannot answer. "Encrypted bids" is a feature
 * several things claim. The middle claim here is the one that is hard: the
 * enclave signs over the set the CONTRACT recorded, so the party running the
 * auction cannot quietly drop a bid it dislikes. Every mechanism named is
 * enforced somewhere a reader can check, and the Audit tab is where they check
 * it.
 */
function Claims() {
  // One line each.
  //
  // These were a paragraph apiece, and three paragraphs of argument above a
  // table is an essay, not a desk. The reasoning did not get worse for being
  // cut - it moved to where reasoning belongs, which is the code and
  // SUBMISSION.md. What a reader needs on the page is the claim and where it
  // bites.
  const claims: [string, React.ReactNode][] = [
    [
      "The auctioneer is blind",
      <>Encrypted to a key that exists only inside the enclave. The operator relays ciphertext it cannot open.</>,
    ],
    [
      "The set cannot be trimmed",
      <>
        The enclave signs over the commitments <b className="text-fg">the contract recorded</b>. Drop
        a bid and the settlement reverts.
      </>,
    ],
    [
      "Solvency, without disclosure",
      <>Bidders who could not pay are dropped - without anyone learning what they bid.</>,
    ],
  ];

  return (
    <div className="border-t border-line bg-bg-1">
      <div className="px-4 pt-3">
        <Lbl>Why this takes an enclave and not just a contract</Lbl>
      </div>
      <div className="px-4 py-3 grid gap-x-6 gap-y-4 md:grid-cols-3 max-w-[76rem]">
        {claims.map(([title, body]) => (
          <div key={title}>
            <div className="text-[13px] font-semibold leading-snug">
              <Red>▸</Red> {title}
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fg-dim">{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Run the whole thing yourself, in about three minutes.
 *
 * The desk assumed a reader who already knew what to press. Somebody arriving
 * cold - a judge, say - could read every claim on the page and still have no
 * route to testing one, because the only auctions on the book were ours and
 * they close when they close.
 *
 * The route was there all along: the post form takes its deadline in MINUTES,
 * so anyone can put up a two-minute block and watch it through post, seal,
 * clear and settle in one sitting. Saying so costs six lines. Not saying it
 * left the product's only self-service path invisible.
 */
function TryIt({ live }: { live: boolean }) {
  const steps: [string, React.ReactNode][] = [
    [
      "Fund a wallet",
      <>
        <a className="text-accent hover:underline" href="https://faucet.flare.network/coston2" target="_blank" rel="noopener">
          Coston2 faucet
        </a>{" "}
 - gas and FXRP, once a day per address.
      </>,
    ],
    ["Post a block", <>Set the deadline in minutes. Two is enough.</>],
    ["Seal a bid", <>Encrypted here, signed by your wallet. The chain gets a commitment.</>],
    [
      "Clear, then settle",
      <>
        {/* "Winner pays the runner-up's price" is false for exactly the
            person following these four steps: they are the only bidder, and a
            lone bid clears at the reserve. */}
        Winner pays the runner-up's price - or your reserve, if nobody else bid. Check it on{" "}
        <b className="text-fg">Audit</b>, not on our word.
      </>,
    ],
  ];

  return (
    <div className="border-t border-line px-4 py-3">
      <Lbl>Try it yourself - about three minutes</Lbl>
      {!live && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-accent max-w-[70ch]">
          The enclave is not answering this browser right now, so the book below is demo data and
          steps 2 to 4 will not go through. The contract and every settlement it has already made
          are on Coston2 and stay checkable - see Audit.
        </p>
      )}
      <ol className="mt-2 grid gap-x-6 gap-y-2 md:grid-cols-4 max-w-[76rem]">
        {steps.map(([title, body], i) => (
          <li key={title} className="text-[11.5px] leading-relaxed text-fg-dim">
            <span className="text-fg font-semibold">
              <Red>{i + 1}.</Red> {title}
            </span>
            <br />
            {body}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── audit ────────────────────────────────────────────────────────────────────

/**
 * What a reader can check without trusting the page.
 *
 * Every claim the desk makes about itself is a public read, and they were only
 * written down in SUBMISSION.md - which meant anyone looking at the product had
 * to leave it to find out whether any of this was true. The machine is read from
 * the diamond on load, so this panel cannot claim a machine that is not there.
 */
const EXPLORER = "https://coston2-explorer.flare.network/address/";
// Only a last resort. The desk asks the diamond which contract is bound to
// the desk's extension - a constant here was the first of four deployments while
// three later ones were live, and a stale address does not throw, it just
// reverts every transaction against a contract nobody is bound to any more.
const SENDER_FALLBACK = env.instructionSender || "0xa03821ADE58EfC07bcB1Eacd4D96ced9C7cDF74D";

function Audit({ tee, sender }: { tee: TeeStatus; sender: string }) {
  const rows: [string, React.ReactNode, string][] = [
    [
      "Instruction sender",
      <a className="hover:text-accent break-all font-mono" href={`${EXPLORER}${sender}`} target="_blank" rel="noopener">{sender}</a>,
      "Read from the diamond, not written down here - this is whatever contract is bound to the desk's extension right now. It records every commitment, checks the enclave's signature, and rejects a clearing whose set digest is not the set it recorded.",
    ],
    [
      "FCC extension",
      <span>{String(env.extensionId)}</span>,
      "The diamond returns this contract for getTeeExtensionInstructionsSender(extensionId).",
    ],
    [
      "TEE machine",
      tee.state === "production"
        ? <a className="hover:text-accent break-all font-mono" href={`${EXPLORER}${tee.machine}`} target="_blank" rel="noopener">{tee.machine}</a>
        : <span className="text-fg-mute">{tee.state === "none" ? "none active" : "could not read"}</span>,
      "Read from the diamond by this browser on load, not written down here. getRandomTeeIds(extensionId, 1) returns it instead of reverting TooMany().",
    ],
    [
      "Settles in",
      <a className="hover:text-accent break-all font-mono" href={`${EXPLORER}${TOKENS.FXRP.address}`} target="_blank" rel="noopener">{TOKENS.FXRP.address}</a>,
      "FXRP on Coston2. The winner pays the second price and receives the lot in the same transaction.",
    ],
  ];

  return (
    <div className="p-4">
      <div className="text-[11.5px] tracking-[0.14em] uppercase text-fg-mute">
        Nothing here is a claim <Red>·</Red> every line is a public read
      </div>
      <h1 className="mt-1 mb-4 text-[22px] leading-tight" style={{ fontFamily: "var(--f-macro)" }}>
        Audit
      </h1>
      <div className="border border-line divide-y divide-line max-w-[64rem]">
        {rows.map(([label, value, note]) => (
          <div key={label} className="grid sm:grid-cols-[10rem_1fr] gap-1 sm:gap-4 px-3 py-2.5">
            <Lbl>{label}</Lbl>
            <div>
              <div>{value}</div>
              <div className="mt-1 text-[11.5px] text-fg-mute leading-relaxed max-w-[70ch]">{note}</div>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-[11px] text-fg-dim leading-relaxed max-w-[70ch]">
        The clearing price is public by design - Vickrey pays the second price, so that number is
        on-chain. What stays sealed is which bid produced it, every amount that lost, and the
        maker's reserve.
      </p>
    </div>
  );
}

// ── forms ────────────────────────────────────────────────────────────────────

/** Only ever rendered for an auction that is open - the desk decides that, and
 *  shows something useful for the other two cases instead of a dead end here. */
function BidForm(props: {
  sel: RfqState;
  address?: Address;
  /** Seal into a commitBid transaction instead of the direct channel. Only
   *  this puts the commitment in the set relayClearing checks against. */
  onChain: (amount: bigint) => void;
  busyChain: boolean;
  onDone: (msg: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ commitment: string; nonce: string; amount: string } | null>(null);
  const { signMessageAsync } = useSignMessage();
  // useAccount().chainId is the chain the WALLET is on. useChainId() is the
  // chain wagmi is configured for - only Coston2 is configured, so it answered
  // 114 whatever the wallet was doing, and the warning could never fire.
  const { chainId: walletChain } = useAccount();
  const chainId = walletChain ?? coston2.id;

  const bidder = props.address;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Lbl>Bidding on</Lbl>
        <div className="mt-1">
          RFQ {String(props.sel.rfqId).padStart(3, "0")} - {props.sel.lot.toLocaleString()} {props.sel.pair}
        </div>
      </div>

      <Field
        label="Your bid (total, quote units)"
        value={amount}
        onChange={setAmount}
        placeholder="130450"
        hint="Vickrey: if you win, you pay the runner-up's price - so bid what it is worth to you."
      />

      {/* What has to be true before this can be sealed, said before it is
          pressed. All of it is decided in this browser: the reader can watch the
          amount stop being a number they typed and become something only the
          enclave can open. */}
      <div className="flex flex-col gap-1">
        <Lbl>Before it leaves this browser</Lbl>
        {[
          [/^\d+$/.test(amount.trim()) && BigInt(amount.trim() || "0") > 0n,
            "A whole, positive number of quote units"],
          [!!bidder, "A wallet to bind the bid to"],
          // The signature is domain-separated by chain id, so a wallet on the
          // wrong network produces one the enclave cannot match and the bid is
          // rejected as a forgery. Nothing said so: the connect button hides the
          // network, and the failure looks like the desk being broken.
          [chainId === coston2.id,
            chainId === coston2.id
              ? "Your wallet is on Coston2, which the signature is bound to"
              : `Your wallet is on chain ${chainId}, not Coston2 (${coston2.id}) - this bid would be rejected`],
          // The one line that must never be quietly true. Encrypting to a key
          // the relay handed over means the relay can read the bid, and that is
          // the whole thing this desk claims not to do.
          [!env.allowUnverifiedTeeKey,
            env.allowUnverifiedTeeKey
              ? "UNVERIFIED KEY: this build encrypts to whatever the relay serves, so the relay can read your bid"
              : "Encrypted to the key the chain published - the relay cannot substitute it"],
          [true, "keccak256(amount ‖ nonce ‖ your address) computed here, not sent"],
          [true, "The operator relays ciphertext"],
        ].map(([ok, text]) => (
          <div key={String(text)} className="flex items-baseline gap-2 text-[11.5px] leading-relaxed">
            <span className={ok ? "text-accent" : "text-fg-mute"}>{ok ? "✓" : "○"}</span>
            <span className={ok ? "text-fg-dim" : "text-fg-mute"}>{text}</span>
          </div>
        ))}
      </div>


      {!bidder ? (
        // The most common first click on this desk, and it used to be a
        // sentence. Telling a reader to connect a wallet beside a form they
        // have already filled in, with no control that does it, is a dead end
        // at exactly the point they decided to take part.
        <div className="flex flex-col items-start gap-2">
          <ConnectButton.Custom>
            {({ openConnectModal }) => (
              <Btn onClick={openConnectModal}>Connect a wallet to seal this bid</Btn>
            )}
          </ConnectButton.Custom>
          <span className="text-[11.5px] text-fg-mute leading-relaxed max-w-[44ch]">
            Sealed here, signed by your wallet - so nobody can bid in your name.
          </span>
        </div>
      ) : (
        <>
        {/* The transaction first, because it is the one that counts.
            A bid sealed over the direct channel lives in the enclave's memory
            and nowhere else, so it can demonstrate the mechanism but can never
            be part of a settlement - relayClearing checks a clearing against
            the set the CONTRACT recorded. Leading with the demo rail was
            defensible while the only desk that could reach an enclave was a
            local one. On the deployed desk the direct channel is closed on
            purpose (nothing unauthenticated over plain HTTP may write to an
            auction), so leading with it meant the most prominent button on the
            form answered 403. */}
        <div className="flex flex-col items-start gap-2">
          <Btn
            busy={props.busyChain}
            onClick={() => {
              if (!/^\d+$/.test(amount.trim()) || BigInt(amount.trim()) <= 0n) {
                return props.onDone("Bid must be a positive whole number.");
              }
              props.onChain(BigInt(amount.trim()));
            }}
          >
            Seal bid on-chain
          </Btn>
          <p className="text-[11.5px] text-fg-mute leading-relaxed max-w-[44ch]">
            A transaction. The commitment lands in the set the clearing has to match. One bid per
            address.
          </p>
        </div>
        <div className="pt-3 border-t border-line">
        <Btn
          quiet
          busy={busy}
          onClick={async () => {
            // BigInt throws on anything that is not a whole number - "1.5",
            // "1e9", "abc" - and this ran outside the try, so a typo killed the
            // click with an uncaught error and no message. One test in
            // qa/flows-desk.mjs types each of them.
            if (!/^\d+$/.test(amount.trim())) {
              return props.onDone("Bid must be a positive whole number.");
            }
            const amt = BigInt(amount.trim());
            if (amt <= 0n) return props.onDone("Bid must be a positive whole number.");
            setBusy(true);
            try {
              const r = await sealBid({
                rfqId: props.sel!.rfqId,
                bidder,
                amount: amt,
                chainId,
                sign: (raw) => signMessageAsync({ message: { raw } }),
              });
              setReceipt({ commitment: r.commitment, nonce: r.nonce, amount: amt.toString() });
              // Kept in this browser so the disclosure can be built later. The
              // panel below shows the nonce once; without this the only way to
              // ever prove this bid was to copy 32 bytes by hand before the
              // next render took them away.
              remember({
                rfqId: props.sel.rfqId, bidder,
                amount: amt.toString(), nonce: r.nonce, commitment: r.commitment,
              });
              props.onDone(`Sealed. You are bid #${r.bidCount} on RFQ ${r.rfqId}.`);
              setAmount("");
            } catch (e) {
              props.onDone(String((e as Error).message));
            } finally {
              setBusy(false);
            }
          }}
        >
          Seal over the direct rail
        </Btn>
        <p className="mt-2 text-[11.5px] text-fg-mute leading-relaxed max-w-[44ch]">
          Same envelope, straight to the enclave. Memory only, so it can never settle - and the
          deployed desk refuses it.
        </p>
        </div>
        </>
      )}

      {receipt && (
        <div className="border border-line bg-bg-1 p-3 flex flex-col gap-2">
          <Lbl>Your seal - keep the nonce</Lbl>
          {/* The nonce is 32 bytes somebody has to copy correctly or lose the
              only proof of what they bid. Rendering it in a proportional face,
              where 0/O and 1/l are the same glyph shape, is a way to lose it. */}
          <div className="text-[11.5px] break-all font-mono">
            <span className="text-fg-mute">commitment </span>{receipt.commitment}
          </div>
          <div className="text-[11.5px] break-all font-mono">
            <span className="text-fg-mute">nonce </span>{receipt.nonce}
          </div>
          <p className="text-[11.5px] text-fg-mute leading-relaxed">
            The chain records only the commitment. With the nonce you - and only you - can
            later prove to anyone what you bid, without it ever becoming public.
          </p>
        </div>
      )}
    </div>
  );
}

function PostForm(props: {
  address?: Address;
  block: bigint | null;
  onDone: (msg: string, rfqId: number) => void;
  /** The on-chain rail: approve the lot, then post it. Lives in the parent so
   *  it can use the same wallet client the reclaim button does. */
  onChain: (lot: number, deadlineBlock: number, invited: string, reserve: bigint, pair: string) => void;
}) {
  const [pair, setPair] = useState("FXRP/USDT0");
  const [lot, setLot] = useState("250000");
  const [reserve, setReserve] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [invited, setInvited] = useState("");
  const [bilateral, setBilateral] = useState(false);
  // On-chain by default.
  //
  // "direct" was the default from when the only desk that could reach an
  // enclave was a local one. On the deployed desk that rail is refused - the
  // proxy carries reads only - so the first action the page's own four-step
  // guide recommends answered 403, with the raw error as the only feedback.
  // The rail that escrows the lot and that a clearing can settle against is the
  // one a newcomer should land on.
  const [rail, setRail] = useState<"direct" | "chain">("chain");
  const [busy, setBusy] = useState(false);

  // Minutes in, block out. The field used to ask for a block number, with a
  // placeholder of 24109880 - a real block, nine million behind the chain by
  // now, so anyone who followed the example posted an auction whose deadline
  // had already passed. Nobody knows what block it will be in an hour; the
  // desk does.
  // Measured, not the target - the same 2.059s the countdown uses. This copy
  // was missed when blockClock.ts was corrected, so a form promising 60 minutes
  // produced a block the book then described as "about 1h 8m left": two numbers
  // disagreeing on one screen, seconds apart.
  const SECONDS_PER_BLOCK = 2.06;
  const mins = Number(minutes);
  const deadlineBlock =
    props.block !== null && Number.isFinite(mins) && mins > 0
      ? Number(props.block) + Math.round((mins * 60) / SECONDS_PER_BLOCK)
      : 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Two shapes, one mechanism. An invited auction with a single sealed bid
          IS a bilateral OTC settle - same commitment, same signature, same set
          digest - which is why there is no separate opcode for it. The UI never
          said so: the second product was an optional field at the bottom of the
          form, below the deadline. */}
      <div>
        <Lbl>How it clears</Lbl>
        <div className="mt-2 grid sm:grid-cols-2 gap-px bg-line border border-line">
          {[
            [false, "Open auction", "Anyone may seal a bid. Highest wins and pays the runner-up's price."],
            [true, "One counterparty", "Only the address you name may bid. A lone sealed bid clears at your reserve - a bilateral settle with the same guarantees."],
          ].map(([mode, title, why]) => (
            <button
              key={String(title)}
              onClick={() => setBilateral(mode as boolean)}
              className={
                "text-left px-3 py-2.5 " +
                (bilateral === mode ? "bg-fg text-bg" : "bg-bg hover:bg-bg-1")
              }
            >
              <div className="text-[11px] tracking-[0.1em] uppercase">
                {bilateral === mode ? <>▸ {title}</> : <span className="text-fg-dim">{title}</span>}
              </div>
              <div className={"mt-1 text-[11.5px] leading-relaxed " + (bilateral === mode ? "opacity-80" : "text-fg-mute")}>
                {why}
              </div>
            </button>
          ))}
        </div>
      </div>

      <Field label="Pair" value={pair} onChange={setPair} />
      <Field label="Lot (base units)" value={lot} onChange={setLot} />
      <Field
        label="Hidden reserve (quote units)"
        value={reserve}
        onChange={setReserve}
        placeholder="120000"
        hint="Your floor, ECIES-encrypted to the enclave key. Bidders never see it; a lone bidder pays exactly this."
      />
      <Field
        label="Open for (minutes)"
        value={minutes}
        onChange={setMinutes}
        placeholder="60"
        hint={
          props.block === null
            ? "Cannot read the chain's head, so this cannot be turned into a deadline block yet."
            : `Deadline is block ${deadlineBlock.toLocaleString()} - a block number, not a clock, because the enclave's clock is not a trust anchor.`
        }
      />
      {bilateral && (
        <Field
          label="The counterparty"
          value={invited}
          onChange={setInvited}
          placeholder="0x…"
          hint="Only this address may bid. Your reserve still stays hidden from them."
        />
      )}
      {/* Which rail. The direct one is the demo path the extension only opens
          with BUTA_ALLOW_DIRECT_AUCTION; on-chain is a transaction that escrows
          the lot in the contract and forwards the instruction through the
          diamond. Only the second one makes the commitment set the clearing has
          to match, so it is worth being able to choose. */}
      <div>
        <Lbl>Which rail</Lbl>
        <div className="mt-2 flex">
          {(["direct", "chain"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRail(r)}
              className={
                "px-3 py-1.5 text-[11.5px] tracking-[0.12em] uppercase border border-line -ml-px first:ml-0 " +
                (rail === r ? "bg-fg text-bg border-fg" : "text-fg-mute hover:text-fg")
              }
            >
              {r === "direct" ? "Direct (demo)" : "On-chain"}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11.5px] text-fg-mute leading-relaxed max-w-[52ch]">
          {rail === "direct"
            ? "Straight to the enclave. Nothing is escrowed and nothing is recorded on-chain - fine for a demo, not a trade."
            : `A transaction: ${TOKENS.FXRP.symbol} is escrowed in the contract and the instruction goes through the diamond, so the commitment set exists on-chain before the enclave has heard of it. Needs an approval first.`}
        </p>
      </div>

      <Btn
        busy={busy}
        onClick={async () => {
          if (!deadlineBlock) {
            return props.onDone("Set how long the block stays open, in minutes.", 0);
          }
          if (bilateral && !/^0x[0-9a-fA-F]{40}$/.test(invited.trim())) {
            return props.onDone("A bilateral block needs the counterparty's address.", 0);
          }
          // An empty reserve is a floor of zero, and clearing floors AT the
          // reserve - so a lone bid takes the lot for nothing. The field was
          // optional and said nothing about that.
          if (!/^\d+$/.test(reserve.trim()) || BigInt(reserve.trim()) === 0n) {
            return props.onDone(
              "Set a reserve above zero. It is your floor, and a single bid clears at exactly it - " +
                "a zero reserve gives the lot away.",
              0,
            );
          }
          if (rail === "chain") {
            return props.onChain(Number(lot), deadlineBlock, bilateral ? invited.trim() : "", BigInt(reserve.trim()), pair);
          }
          setBusy(true);
          try {
            const r = await postRfq({
              maker: props.address ?? "0x0000000000000000000000000000000000000000",
              pair,
              lot: Number(lot),
              reserve: Number(reserve || "0"),
              deadline: deadlineBlock,
              invited: bilateral ? invited.trim() : "",
            });
            props.onDone(`Posted RFQ ${r.rfqId}. Bids are sealed from this moment.`, r.rfqId);
          } catch (e) {
            props.onDone(String((e as Error).message), 0);
          } finally {
            setBusy(false);
          }
        }}
      >
        Post block
      </Btn>
    </div>
  );
}
