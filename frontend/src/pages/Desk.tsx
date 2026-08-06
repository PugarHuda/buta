/**
 * Desk.tsx — the sealed-bid desk.
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
import {
  senderAbi, erc20Abi, preflight, bidPreflight, relayPreflight,
  instructionIdFrom, awaitSignedClearing, INSTRUCTION_FEE, ZERO,
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

const POLL_MS = 3000;

// ── shared atoms ─────────────────────────────────────────────────────────────

/** Every panel says what it is, twice: a small line naming the surface, then
 *  the heading. A screen that opens with a table and no title makes the reader
 *  work out where they are from the contents. */
function Head({ eyebrow, children }: { eyebrow: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="px-4 pt-4 pb-3">
      <div className="text-[10px] tracking-[0.14em] uppercase text-fg-mute">{eyebrow}</div>
      <h1 className="mt-1 text-[22px] leading-tight" style={{ fontFamily: "var(--f-macro)" }}>
        {children}
      </h1>
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] tracking-[0.12em] uppercase text-fg-mute">{children}</span>
  );
}

function Red({ children }: { children: React.ReactNode }) {
  return <span className="text-accent">{children}</span>;
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <Lbl>{props.label}</Lbl>
      <input
        className="bg-bg-1 border border-line px-2.5 py-2 font-mono text-[12px] text-fg outline-none focus:border-accent"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        spellCheck={false}
      />
      {props.hint && <span className="text-[10px] text-fg-mute">{props.hint}</span>}
    </label>
  );
}

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
        "px-4 py-2 text-[11px] tracking-[0.12em] uppercase font-mono border transition-colors " +
        (props.quiet
          ? "bg-bg text-fg-dim border-line hover:border-accent hover:text-fg"
          : "bg-accent text-bg border-accent hover:bg-fg hover:border-fg disabled:opacity-40")
      }
    >
      {props.busy ? "Working…" : props.children}
    </button>
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
  // happened was whatever the last one said — including the receipts, which are
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
  // it through the ref keeps `refresh` out of the block's dependency list — as a
  // dependency it would tear down and restart the poll every fifteen seconds.
  const headRef = useRef<bigint | null>(null);
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

  // A production bundle with no VITE_TEE_PROXY_URL has nowhere to ask: relative
  // URLs only resolve through vite's dev proxy. Polling anyway meant a 404
  // every few seconds in the console of anyone who opened the deployed desk,
  // for an answer we already knew. Go straight to the demo book instead.
  const canReachExtension = import.meta.env.DEV || Boolean(env.teeProxyUrl);

  const refresh = useCallback(async () => {
    if (!canReachExtension) {
      setRfqs(demoBook(headRef.current));
      setOffline(true);
      setDemo(true);
      return;
    }
    try {
      const { rfqs: list, dropped: bad } = await listRfqs();
      setRfqs(list);
      setDropped(bad);
      setOffline(false);
      setDemo(false);
    } catch {
      // No extension reachable — show the demo book so the desk is never empty.
      setRfqs(demoBook(headRef.current));
      setOffline(true);
      setDemo(true);
    }
  }, [canReachExtension]);

  useEffect(() => {
    refresh();
    if (!canReachExtension) return; // nothing to poll for
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh, canReachExtension]);

  // Only a SEALED auction can be bid on. The book is newest-first and the newest
  // is usually already cleared, so landing on nothing selected — or worse, on a
  // closed auction — was the first thing anyone saw. Open on the first one that
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
  // happened — including the hash, which is the only part a maker can check
  // against the chain themselves.
  const { writeContractAsync } = useWriteContract();
  const [reclaiming, setReclaiming] = useState<number | null>(null);
  const reclaim = useCallback(
    async (rfqId: number) => {
      setReclaiming(rfqId);
      try {
        const hash = await writeContractAsync({
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
    [writeContractAsync, say, refresh],
  );

  // Post a block as a transaction: escrow the lot, forward the instruction.
  //
  // Everything checkable is checked from public reads first. The desk's own
  // history is the argument — the postRfq that ran on Coston2 failed on "ERC20:
  // insufficient allowance", and the only way to find that out was to pay for a
  // reverted transaction.
  const postOnChain = useCallback(
    async (lot: number, deadlineBlock: number, invited: string, reserve: bigint, pair: string) => {
      if (!address) return say("Connect a wallet first — posting on-chain is a transaction.");
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

        if (pre.needsApproval) {
          say(`Approving ${lotUnits} ${TOKENS.FXRP.symbol} to the escrow — one transaction, then the block.`);
          const a = await writeContractAsync({
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
        const hash = await writeContractAsync({
          address: spender,
          abi: senderAbi,
          functionName: "postRfq",
          args: [TOKENS.USDT0.address, token, lotUnits, BigInt(deadlineBlock), (invited || ZERO) as Address, encryptedReserve],
          value: INSTRUCTION_FEE,
        });
        say(`Posted on-chain: ${hash}. The lot is escrowed and the instruction is on its way to the enclave.`);
        await pc.waitForTransactionReceipt({ hash });
        const count = await pc.readContract({ address: spender, abi: senderAbi, functionName: "rfqCount" });
        say(`Confirmed. rfqCount is now ${count} — the auction exists on-chain before the enclave has heard of it.`);
        setPanel("auto");
      } catch (e) {
        const m = e as { shortMessage?: string; message?: string };
        say(`On-chain post failed: ${m.shortMessage ?? m.message ?? String(e)}`);
      } finally {
        refresh();
      }
    },
    [address, writeContractAsync, say, refresh],
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
      if (!address) return say("Connect a wallet — sealing on-chain is a transaction.");
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

        // Same commitment and the same sealed opening as the direct rail — only
        // the transport differs, which is the point.
        const sealed = await sealBidEnvelope({
          rfqId, bidder: address, amount, chainId,
          sign: (raw) => signMessageAsync({ message: { raw } }),
        });
        const hash = await writeContractAsync({
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
    [address, chainId, signMessageAsync, writeContractAsync, say, refresh],
  );

  // Settle it. The only function that moves money, and the only one that makes
  // the whole design pay off: the contract will not settle a clearing whose
  // signature does not recover to the registered enclave, or whose set digest
  // is not the digest of the commitments IT recorded. An auctioneer who drops
  // an inconvenient bid produces a clearing that reverts.
  const [settling, setSettling] = useState<number | null>(null);
  // The last clearing this session produced, kept because settling needs the
  // signature and the action id — not just the winner and the price.
  const [lastOutcome, setLastOutcome] = useState<
    (ClearingOutcome & { actionId?: string; submissionTag?: string; signature?: string }) | null
  >(null);
  const settle = useCallback(
    async (out: ClearingOutcome & { actionId?: string; submissionTag?: string; signature?: string }) => {
      if (!address) return say("Connect a wallet — settling is a transaction.");
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

        const hash = await writeContractAsync({
          address: sender, abi: senderAbi, functionName: "relayClearing",
          args: [
            BigInt(out.rfqId), out.winner as Address, BigInt(out.clearingPrice),
            out.setDigest as `0x${string}`, (out.actionId ?? ZERO) as `0x${string}`,
            out.submissionTag ?? "submit", 1, out.signature as `0x${string}`,
          ],
        });
        say(`Settling: ${hash}. The winner pays the second price and the lot moves in the same transaction.`);
        await pc.waitForTransactionReceipt({ hash });
        say(`Settled on-chain. Delivery versus payment, and the losing amounts were never revealed to anyone.`);
      } catch (e) {
        const m = e as { shortMessage?: string; message?: string };
        say(`Settlement failed: ${m.shortMessage ?? m.message ?? String(e)}`);
      } finally {
        setSettling(null);
        refresh();
      }
    },
    [address, writeContractAsync, say, refresh],
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
      if (!address) return say("Connect a wallet — requesting a clearing is a transaction.");
      setRequesting(rfqId);
      try {
        const pc = createPublicClient({ chain: coston2, transport: http() });
        const hash = await writeContractAsync({
          address: sender, abi: senderAbi, functionName: "requestClearing",
          args: [BigInt(rfqId)], value: INSTRUCTION_FEE,
        });
        say(`Clearing requested on-chain: ${hash}. The enclave opens the bids and signs the outcome.`);
        const rcpt = await pc.waitForTransactionReceipt({ hash });
        const id = instructionIdFrom(rcpt.logs);
        if (!id) return say("The diamond logged no instruction id, so there is nothing to wait on.");

        const signed = await awaitSignedClearing(env.teeProxyUrl, id);
        if (!signed) {
          return say(
            "No signed outcome came back. The clearing may still have happened — but relayClearing " +
              "cannot settle without a signature, and the dev facade produces none.",
          );
        }
        const [oRfq, winner, price, digest] = decodeAbiParameters(
          [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
          signed.data,
        );
        setLastOutcome({
          rfqId: Number(oRfq), winner, clearingPrice: Number(price), bidCount: 0, setDigest: digest,
          actionId: signed.actionId, submissionTag: signed.submissionTag, signature: signed.signature,
        });
        say(`Signed by the enclave: ${winner} wins at ${price}. Settle it to move the lot and the payment.`);
      } catch (e) {
        const m = e as { shortMessage?: string; message?: string };
        say(`Clearing request failed: ${m.shortMessage ?? m.message ?? String(e)}`);
      } finally {
        setRequesting(null);
        refresh();
      }
    },
    [address, sender, writeContractAsync, say, refresh],
  );

  const openCount = rfqs.filter((r) => !r.cleared).length;
  const sealedBids = rfqs.reduce((n, r) => n + (r.cleared ? 0 : r.bidCount), 0);

  const NAV = [
    ["auto", "Book"],
    ["folio", "Portfolio"],
    ["activity", "Activity"],
    ["audit", "Audit"],
  ] as const;

  // All / Open / Mine. "Mine" is the maker's own blocks — the one cut a desk
  // actually wants, and it needs no extra read because the maker is public.
  const shown = rfqs.filter((r) =>
    filter === "open" ? !r.cleared
    : filter === "mine" ? !!address && r.maker.toLowerCase() === address.toLowerCase()
    : true,
  );

  return (
    <div className="min-h-screen bg-bg text-fg font-mono text-[12px] md:flex">
      {/* ── sidebar ──
          Identity, the three places you can be, and the state of the desk —
          all of it permanent, so the reader is never asked to remember which
          tab they were on or click something to find out where they are. On a
          phone it lays out along the top instead. */}
      <aside className="md:w-[13.5rem] md:shrink-0 md:sticky md:top-0 md:h-screen md:border-r-2 md:border-fg bg-bg flex flex-col">
        <div className="px-4 py-3 border-b border-line">
          <div className="font-macro text-[17px] tracking-tight uppercase leading-none" style={{ fontFamily: "var(--f-macro)" }}>
            BUTA<Red>®</Red>
          </div>
          <div className="mt-1 text-[10px] tracking-[0.12em] uppercase text-fg-mute">
            [ SEALED-BID OTC DESK ]
          </div>
        </div>

        {/* The chain this desk is on, stated once and permanently. */}
        {/* items-start and a shrink-0 dot: with items-center the label had no
            room to wrap, so "TEE PRODUCTION" ran straight out through the right
            border of its own box. */}
        <div className="hidden md:flex items-start gap-2 mx-4 my-3 px-2.5 py-1.5 border border-line bg-bg-1 text-[10px] tracking-[0.1em] uppercase text-fg-mute leading-snug">
          <span className={"mt-1 w-1.5 h-1.5 shrink-0 " + (tee.state === "production" ? "bg-accent" : "bg-fg-mute")} />
          <span className="min-w-0">
            {tee.state === "production" ? <>Coston2 <Red>///</Red> TEE production</>
              : offline ? <Red>Extension offline</Red>
              : <>Coston2 <Red>///</Red> simulated TEE</>}
          </span>
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

        <nav className="flex md:flex-col border-y border-line">
          {NAV.map(([id, label]) => (
            <button
              key={id}
              onClick={() => setPanel(id)}
              className={
                "flex-1 md:flex-none text-left px-4 py-2.5 text-[10px] tracking-[0.12em] uppercase border-r md:border-r-0 md:border-b border-line " +
                (panel === id ? "bg-fg text-bg" : "text-fg-mute hover:text-fg hover:bg-bg-1")
              }
            >
              {panel === id ? <><Red>▸</Red> {label}</> : <span className="pl-3">{label}</span>}
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
                <dt className="text-[10px] tracking-[0.1em] uppercase text-fg-mute">{label}</dt>
                <dd className="text-[17px] leading-tight" style={{ fontFamily: "var(--f-macro)" }}>
                  {String(value)}
                </dd>
                <div className="text-[10px] text-fg-mute leading-tight">{hint}</div>
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
            className="block mb-3 text-[10px] tracking-[0.1em] uppercase text-fg-mute hover:text-accent"
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
          <span className="text-[10px] tracking-[0.1em] uppercase text-fg-mute">
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
        <div className="px-4 py-1.5 bg-accent text-bg text-[10px] tracking-[0.12em] uppercase">
          Demo book <span className="opacity-70">— no enclave reachable from this browser.</span>{" "}
          <span className="opacity-70">Start it with <span className="opacity-100">go run ./cmd/dev</span> for the live flow;{" "}
          the machine itself is registered — see Audit.</span>
        </div>
      )}
      {/* who this is for — the first thing a judge reads */}
      <p className="px-4 py-3 max-w-[72ch] text-[12.5px] leading-relaxed text-fg-dim">
        For desks moving size. Post a block, collect sealed bids, clear at the fair second
        price. <b className="text-fg">Nobody can read a bid before it clears — not the maker,
        not the operator, not us.</b> Losing amounts are never revealed at all.
      </p>

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
                  is kept here — including the clearing outcomes, which used to be overwritten by
                  whatever happened next.
                </p>
              ) : (
                <div className="border border-line divide-y divide-line max-w-[64rem]">
                  {activity.map((a, i) => (
                    <div key={`${a.at}-${i}`} className="flex gap-3 px-3 py-2">
                      <span className="text-fg-mute shrink-0">{a.at}</span>
                      <span className="text-fg-dim break-all leading-relaxed">{a.text}</span>
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
                      "px-3 py-1 text-[10px] tracking-[0.12em] uppercase border border-line -ml-px first:ml-0 " +
                      (filter === f ? "bg-fg text-bg border-fg" : "text-fg-mute hover:text-fg")
                    }
                  >
                    {f}
                  </button>
                ))}
              </div>
              <span className="text-[10px] tracking-[0.1em] uppercase text-fg-mute">
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

            <div className="grid grid-cols-[5.5rem_1fr_7rem_6rem_4rem_8rem_6rem_5rem] gap-3 px-4 py-1.5 border-y border-line text-[10px] tracking-[0.12em] uppercase text-fg-mute">
              <span>RFQ</span><span>Pair</span><span>Lot</span><span>Reserve</span>
              <span>Bids</span><span>Deadline</span><span>Status</span><span />
            </div>

            {shown.length === 0 && (
              <p className="px-4 py-6 text-fg-mute">
                {rfqs.length === 0
                  ? offline
                    ? "The extension is not reachable. Start it with BUTA_ALLOW_DIRECT_AUCTION=1 and refresh."
                    : "No blocks yet. Post the first one."
                  : filter === "mine"
                    ? "None of these are yours. Post a block, or switch the filter back to All."
                    : "Nothing open right now. Switch the filter back to All to see what has cleared."}
              </p>
            )}

            {shown.map((r) => (
              <div key={r.rfqId} className="border-b border-line-2/40">
                <div className={"flex items-stretch " + (selected === r.rfqId ? "bg-bg-2" : "hover:bg-bg-1")}>
                  {/* The row and its action are siblings, not nested — a button
                      inside a button is invalid and the inner one stops working. */}
                  <button
                    onClick={() => { setSelected(r.rfqId); setPanel("auto"); }}
                    className="flex-1 min-w-0 text-left grid grid-cols-[5.5rem_1fr_7rem_6rem_4rem_8rem_6rem] gap-3 px-4 py-2.5 items-center"
                  >
                    <span className="text-fg-mute">RFQ-{String(r.rfqId).padStart(3, "0")}</span>
                    <span>
                      {r.pair}
                      {/* Whose block this is, on the row rather than only in a
                          filter. A maker scanning the book should not have to
                          switch views to see which ones are theirs. */}
                      {!!address && r.maker.toLowerCase() === address.toLowerCase() && (
                        <span className="ml-2 px-1 border border-accent text-accent text-[9px] tracking-[0.1em] align-middle">
                          YOURS
                        </span>
                      )}
                      {myRfqs.has(r.rfqId) && (
                        <span
                          className="ml-2 px-1 border border-line text-fg-dim text-[9px] tracking-[0.1em] align-middle"
                          title="You have a sealed bid on this auction. The enclave accepts one per address."
                        >
                          BID SEALED
                        </span>
                      )}
                    </span>
                    <span>{r.lot.toLocaleString()}</span>
                    {/* A redaction bar, not the word "hidden". The reserve is a
                        number that exists and cannot be read, and the desk should
                        look like that on every row. */}
                    <span
                      className="inline-block w-14 h-[11px] bg-fg align-middle"
                      title="The maker's floor is ECIES-encrypted to the enclave key. Nobody else can read it — not the operator, not us."
                    />
                    <span>{r.bidCount}</span>
                    <span className="text-fg-mute leading-tight">
                      {/* data-volatile: both of these move with the chain, so
                          the pixel baseline overwrites them rather than failing
                          every run for the chain's reasons. */}
                      <span data-volatile>blk {r.deadline.toLocaleString()}</span>
                      {!r.cleared && countdown(r.deadline, block).text && (
                        <span
                          data-volatile
                          className={"block text-[10px] " + (countdown(r.deadline, block).passed ? "text-accent" : "")}
                        >
                          {countdown(r.deadline, block).text}
                        </span>
                      )}
                    </span>
                    <span>
                      <span
                        className={
                          "px-1.5 py-0.5 border text-[10px] tracking-[0.1em] uppercase " +
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
                  <button
                    onClick={() => { setSelected(r.rfqId); setPanel("auto"); }}
                    className={
                      "w-[5rem] shrink-0 my-2 mr-4 text-[10px] tracking-[0.12em] uppercase border " +
                      (r.cleared
                        ? "border-line text-fg-dim hover:border-fg hover:text-fg"
                        : "border-accent text-accent hover:bg-accent hover:text-bg")
                    }
                  >
                    {r.cleared ? "View" : "Bid"}
                  </button>
                </div>

                {/* The selected row opens under itself. One column, one place to
                    look, and the auction it belongs to is directly above it. */}
                {selected === r.rfqId && (
                  <div className="px-4 py-4 bg-bg-1 border-t border-line">
                    {r.cleared ? (
                      <div className="grid sm:grid-cols-3 gap-px bg-line border border-line">
                        <div className="bg-bg px-3 py-2.5">
                          <Lbl>Winner</Lbl>
                          <div className="mt-1 break-all">{r.winner}</div>
                        </div>
                        <div className="bg-bg px-3 py-2.5">
                          <Lbl>Clearing price</Lbl>
                          {/* Who says so. The contract checks the enclave's
                              signature before it settles; the direct rail's
                              facade signs nothing at all, so a receipt from it
                              is the operator's word and should read that way
                              rather than looking identical to a proven one. */}
                          <div className="mt-1 text-[10px] text-fg-mute leading-relaxed">
                            {demo || offline
                              ? "Demo book — nothing here was signed."
                              : "Relayed without a signature on this rail: the enclave's signature is checked on-chain by relayClearing, not here."}
                          </div>
                          <div className="mt-1 text-[15px]" style={{ fontFamily: "var(--f-macro)" }}>
                            {r.clearingPrice?.toLocaleString()}
                          </div>
                          <div className="text-[10px] text-fg-mute">Vickrey second price</div>
                        </div>
                        <div className="bg-bg px-3 py-2.5">
                          <Lbl>Sealed forever</Lbl>
                          {/* The commitments, listed. "N losing amounts" is a
                              number you take on trust; the hashes are the thing
                              itself — each one was recorded on-chain before
                              anyone knew what was in it, and none of them can be
                              opened by anyone but the bidder who made it. */}
                          {!!r.commitments?.length && (
                            <div className="mt-1 mb-2 flex flex-col gap-0.5">
                              {r.commitments.map((c, i) => (
                                <div key={c} className="flex items-baseline gap-2 text-[10px]">
                                  <span className="text-fg-mute">bid {i + 1}</span>
                                  <span className="text-fg-dim">{c.slice(2, 16)}…</span>
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
                              ? "The winner's own bid and the reserve. It cleared at the reserve — there was no second bid to price it."
                              : `${r.bidCount - 1} losing ${r.bidCount - 1 === 1 ? "amount" : "amounts"}, the winner's own bid, and the reserve.`}
                          </div>
                        </div>
                      </div>
                    ) : (
                      // max-w on the form: a bid is one number, and the field
                      // was stretching the full width of the panel for it.
                      <div className="grid lg:grid-cols-[minmax(0,34rem)_20rem] gap-6">
                        <BidForm
                          sel={r}
                          address={address}
                          busyChain={sealingChain === r.rfqId}
                          onChain={(amount) => bidOnChain(r.rfqId, amount)}
                          onDone={(m) => { say(m); refresh(); }}
                        />
                        <div className="lg:border-l lg:border-line lg:pl-6">
                          {/* This used to ask "Past the deadline?" — a question
                              the desk can answer from one eth_blockNumber, and
                              it offered the same button on an auction with two
                              hours left as on one that closed yesterday. */}
                          <Lbl>Clearing</Lbl>
                          <p className="mt-1 mb-2 text-[10px] text-fg-mute leading-relaxed max-w-[26ch]">
                            {block === null
                              ? "Cannot read the chain's head, so whether the deadline has passed is unknown."
                              : countdown(r.deadline, block).passed
                                ? `Block ${r.deadline.toLocaleString()} is behind us — this can be cleared now.`
                                : `Not until block ${r.deadline.toLocaleString()}, ${countdown(r.deadline, block).text}.`}
                          </p>
                          <div className="mt-2 flex flex-col items-start gap-2">
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
                              Clear RFQ {String(r.rfqId).padStart(3, "0")}
                            </Btn>
                            <span className="text-[10px] text-fg-mute max-w-[26ch] leading-relaxed">
                              Anyone may clear once it is past. Liveness never depends on the maker.
                            </span>
                          </div>

                          {/* The rail that can actually be settled. The button
                              above goes down the direct channel, which a
                              production stack refuses and whose facade signs
                              nothing — so it reaches a clearing that
                              relayClearing will never accept. */}
                          <div className="mt-3">
                            <Btn
                              quiet
                              busy={requesting === r.rfqId}
                              onClick={() => requestClearingOnChain(r.rfqId)}
                            >
                              Request clearing on-chain
                            </Btn>
                            <p className="mt-2 text-[10px] text-fg-mute leading-relaxed max-w-[26ch]">
                              A transaction. The enclave opens the bids and signs the outcome, and only a
                              signed one can be settled.
                            </p>
                          </div>

                          {/* Settling is the step that makes the rest pay off.
                              The contract refuses a clearing whose signature
                              does not recover to the registered enclave, or
                              whose digest is not the digest of the commitments
                              IT recorded — so an auctioneer who dropped a bid
                              produces a settlement that reverts. */}
                          {lastOutcome?.rfqId === r.rfqId && (
                            <div className="mt-4 pt-4 border-t border-line">
                              <Lbl>Settle it</Lbl>
                              <p className="mt-1 mb-2 text-[10px] text-fg-mute leading-relaxed max-w-[26ch]">
                                {lastOutcome.signature
                                  ? "Signed by the enclave. relayClearing pays the maker and moves the lot in one transaction."
                                  : "This rail returned no signature, and relayClearing will not settle without one."}
                              </p>
                              <Btn quiet busy={settling === r.rfqId} onClick={() => settle(lastOutcome)}>
                                Settle on-chain
                              </Btn>
                            </div>
                          )}

                          {/* Your own block, past its deadline, with nothing on
                              it. reclaimLot has been in the contract from the
                              start with no way to call it: a maker who drew no
                              bid had escrowed a lot and no route back to it
                              except a hand-written transaction. */}
                          {!!address &&
                            r.maker.toLowerCase() === address.toLowerCase() &&
                            countdown(r.deadline, block).passed && (
                              <div className="mt-4 pt-4 border-t border-line">
                                <Lbl>Your lot</Lbl>
                                <p className="mt-1 mb-2 text-[10px] text-fg-mute leading-relaxed max-w-[26ch]">
                                  {r.bidCount === 0
                                    ? "Nobody bid. Take the lot back — this closes the auction with no winner."
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

        {/* The most recent line stays in view wherever you are — feedback has to
            be where the action was. The rest is kept under Activity. */}
        {latest && panel !== "activity" && (
          <p className="mx-4 mt-6 pt-4 border-t border-line text-[11px] leading-relaxed text-fg-dim break-all">
            <Red>&gt;&gt;&gt;</Red> {latest}
            {activity.length > 1 && (
              <button
                onClick={() => setPanel("activity")}
                className="ml-3 text-[10px] tracking-[0.1em] uppercase text-fg-mute hover:text-accent"
              >
                {activity.length - 1} more <Red>▸</Red>
              </button>
            )}
          </p>
        )}
      </main>

      <footer className="border-t-2 border-fg px-4 py-3 flex flex-wrap gap-x-6 gap-y-1 text-[10px] tracking-[0.08em] uppercase text-fg-mute">
        <span>BUTA<Red>®</Red> — sealed-bid OTC on Flare Confidential Compute</span>
        {/* "not deployed" sat three lines under a chip reading TEE PRODUCTION,
            which is a contradiction to anyone reading top to bottom. Both were
            true and neither said which sense it meant. */}
        <span>Coston2 testnet only <Red>///</Red> simulated-TEE path <Red>///</Red> not audited</span>
      </footer>
      </div>
    </div>
  );
}

// ── audit ────────────────────────────────────────────────────────────────────

/**
 * What a reader can check without trusting the page.
 *
 * Every claim the desk makes about itself is a public read, and they were only
 * written down in SUBMISSION.md — which meant anyone looking at the product had
 * to leave it to find out whether any of this was true. The machine is read from
 * the diamond on load, so this panel cannot claim a machine that is not there.
 */
const EXPLORER = "https://coston2-explorer.flare.network/address/";
// Only a last resort. The desk asks the diamond which contract is bound to
// extension 65642 — a constant here was the first of four deployments while
// three later ones were live, and a stale address does not throw, it just
// reverts every transaction against a contract nobody is bound to any more.
const SENDER_FALLBACK = env.instructionSender || "0x3085C89540353A4b275704b0Bd03eEc3C718D702";

function Audit({ tee, sender }: { tee: TeeStatus; sender: string }) {
  const rows: [string, React.ReactNode, string][] = [
    [
      "Instruction sender",
      <a className="hover:text-accent break-all" href={`${EXPLORER}${sender}`} target="_blank" rel="noopener">{sender}</a>,
      "Read from the diamond, not written down here — this is whatever contract is bound to extension 65642 right now. It records every commitment, checks the enclave's signature, and rejects a clearing whose set digest is not the set it recorded.",
    ],
    [
      "FCC extension",
      <span>65642</span>,
      "The diamond returns this contract for getTeeExtensionInstructionsSender(65642).",
    ],
    [
      "TEE machine",
      tee.state === "production"
        ? <a className="hover:text-accent break-all" href={`${EXPLORER}${tee.machine}`} target="_blank" rel="noopener">{tee.machine}</a>
        : <span className="text-fg-mute">{tee.state === "none" ? "none active" : "could not read"}</span>,
      "Read from the diamond by this browser on load, not written down here. getRandomTeeIds(65642, 1) returns it instead of reverting TooMany().",
    ],
    [
      "Settles in",
      <a className="hover:text-accent break-all" href={`${EXPLORER}${TOKENS.FXRP.address}`} target="_blank" rel="noopener">{TOKENS.FXRP.address}</a>,
      "FXRP on Coston2. The winner pays the second price and receives the lot in the same transaction.",
    ],
  ];

  return (
    <div className="p-4">
      <div className="text-[10px] tracking-[0.14em] uppercase text-fg-mute">
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
              <div className="mt-1 text-[10px] text-fg-mute leading-relaxed max-w-[70ch]">{note}</div>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-[11px] text-fg-dim leading-relaxed max-w-[70ch]">
        The clearing price is public by design — Vickrey pays the second price, so that number is
        on-chain. What stays sealed is which bid produced it, every amount that lost, and the
        maker's reserve.
      </p>
    </div>
  );
}

// ── forms ────────────────────────────────────────────────────────────────────

/** Only ever rendered for an auction that is open — the desk decides that, and
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
  // chain wagmi is configured for — only Coston2 is configured, so it answered
  // 114 whatever the wallet was doing, and the warning could never fire.
  const { chainId: walletChain } = useAccount();
  const chainId = walletChain ?? coston2.id;

  const bidder = props.address;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Lbl>Bidding on</Lbl>
        <div className="mt-1">
          RFQ {String(props.sel.rfqId).padStart(3, "0")} — {props.sel.lot.toLocaleString()} {props.sel.pair}
        </div>
      </div>

      <Field
        label="Your bid (total, quote units)"
        value={amount}
        onChange={setAmount}
        placeholder="130450"
        hint="Vickrey: if you win, you pay the runner-up's price — so bid what it is worth to you."
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
          [!!bidder, "A wallet to bind the bid to — the enclave recovers the signer"],
          // The signature is domain-separated by chain id, so a wallet on the
          // wrong network produces one the enclave cannot match and the bid is
          // rejected as a forgery. Nothing said so: the connect button hides the
          // network, and the failure looks like the desk being broken.
          [chainId === coston2.id,
            chainId === coston2.id
              ? "Your wallet is on Coston2, which the signature is bound to"
              : `Your wallet is on chain ${chainId}, not Coston2 (${coston2.id}) — the enclave would reject this bid`],
          // The one line that must never be quietly true. Encrypting to a key
          // the relay handed over means the relay can read the bid, and that is
          // the whole thing this desk claims not to do.
          [!env.allowUnverifiedTeeKey,
            env.allowUnverifiedTeeKey
              ? "UNVERIFIED KEY: this build encrypts to whatever the relay serves, so the relay can read your bid"
              : "Encrypted to the enclave key registered on-chain, which the relay cannot substitute"],
          [true, "keccak256(amount ‖ nonce ‖ your address) computed here, not sent"],
          [true, "The amount is ECIES-encrypted to the enclave key; the operator relays ciphertext"],
        ].map(([ok, text]) => (
          <div key={String(text)} className="flex items-baseline gap-2 text-[10px] leading-relaxed">
            <span className={ok ? "text-accent" : "text-fg-mute"}>{ok ? "✓" : "○"}</span>
            <span className={ok ? "text-fg-dim" : "text-fg-mute"}>{text}</span>
          </div>
        ))}
      </div>


      {!bidder ? (
        <p className="text-[11px] text-fg-mute">Connect a wallet to seal a bid.</p>
      ) : (
        <Btn
          busy={busy}
          onClick={async () => {
            // BigInt throws on anything that is not a whole number — "1.5",
            // "1e9", "abc" — and this ran outside the try, so a typo killed the
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
          Seal bid
        </Btn>
      )}

      {/* The same sealed envelope, in a transaction.
          The direct rail records the commitment in enclave memory; only this
          puts it in the set the contract keeps, and that set is what
          relayClearing checks a clearing against. A commitment that never
          reached the chain can demonstrate the mechanism but can never be part
          of a settlement. */}
      {!!bidder && (
        <div className="pt-3 border-t border-line">
          <Btn
            quiet
            busy={props.busyChain}
            onClick={() => {
              if (!/^\d+$/.test(amount.trim()) || BigInt(amount.trim()) <= 0n) {
                return props.onDone("Bid must be a positive whole number.");
              }
              props.onChain(BigInt(amount.trim()));
            }}
          >
            Seal on-chain instead
          </Btn>
          <p className="mt-2 text-[10px] text-fg-mute leading-relaxed max-w-[44ch]">
            A transaction, so the commitment lands in the set the clearing has to match.
            One bid per address, enforced by the contract as well as the enclave.
          </p>
        </div>
      )}

      {receipt && (
        <div className="border border-line bg-bg-1 p-3 flex flex-col gap-2">
          <Lbl>Your seal — keep the nonce</Lbl>
          <div className="text-[10px] break-all">
            <span className="text-fg-mute">commitment </span>{receipt.commitment}
          </div>
          <div className="text-[10px] break-all">
            <span className="text-fg-mute">nonce </span>{receipt.nonce}
          </div>
          <p className="text-[10px] text-fg-mute leading-relaxed">
            The chain records only the commitment. With the nonce you — and only you — can
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
  const [rail, setRail] = useState<"direct" | "chain">("direct");
  const [busy, setBusy] = useState(false);

  // Minutes in, block out. The field used to ask for a block number, with a
  // placeholder of 24109880 — a real block, nine million behind the chain by
  // now, so anyone who followed the example posted an auction whose deadline
  // had already passed. Nobody knows what block it will be in an hour; the
  // desk does.
  const SECONDS_PER_BLOCK = 1.8;
  const mins = Number(minutes);
  const deadlineBlock =
    props.block !== null && Number.isFinite(mins) && mins > 0
      ? Number(props.block) + Math.round((mins * 60) / SECONDS_PER_BLOCK)
      : 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Two shapes, one mechanism. An invited auction with a single sealed bid
          IS a bilateral OTC settle — same commitment, same signature, same set
          digest — which is why there is no separate opcode for it. The UI never
          said so: the second product was an optional field at the bottom of the
          form, below the deadline. */}
      <div>
        <Lbl>How it clears</Lbl>
        <div className="mt-2 grid sm:grid-cols-2 gap-px bg-line border border-line">
          {[
            [false, "Open auction", "Anyone may seal a bid. Highest wins and pays the runner-up's price."],
            [true, "One counterparty", "Only the address you name may bid. A lone sealed bid clears at your reserve — a bilateral settle with the same guarantees."],
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
              <div className={"mt-1 text-[10px] leading-relaxed " + (bilateral === mode ? "opacity-80" : "text-fg-mute")}>
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
            : `Deadline is block ${deadlineBlock.toLocaleString()} — a block number, not a clock, because the enclave's clock is not a trust anchor.`
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
                "px-3 py-1.5 text-[10px] tracking-[0.12em] uppercase border border-line -ml-px first:ml-0 " +
                (rail === r ? "bg-fg text-bg border-fg" : "text-fg-mute hover:text-fg")
              }
            >
              {r === "direct" ? "Direct (demo)" : "On-chain"}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-fg-mute leading-relaxed max-w-[52ch]">
          {rail === "direct"
            ? "Straight to the enclave. Nothing is escrowed and nothing is recorded on-chain — fine for a demo, not a trade."
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
          // reserve — so a lone bid takes the lot for nothing. The field was
          // optional and said nothing about that.
          if (!/^\d+$/.test(reserve.trim()) || BigInt(reserve.trim()) === 0n) {
            return props.onDone(
              "Set a reserve above zero. It is your floor, and a single bid clears at exactly it — " +
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
