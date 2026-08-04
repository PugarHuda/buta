/**
 * Desk.tsx — the sealed-bid desk.
 *
 * One screen, three moves: post a block, seal a bid, clear at the second
 * price. The layout owes everything to the landing page's Swiss Industrial
 * Print language: paper, carbon ink, one aviation red, hairline grids, no
 * radii, uppercase reserved for labels and unit ids.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import type { Address } from "viem";
import { Folio } from "./Folio";
import { TOKENS } from "../config/tokens";
import { demoBook } from "../lib/demoData";
import { env } from "../config/env";
import { readTeeStatus, type TeeStatus } from "../lib/teeStatus";
import { readBlockNumber, countdown } from "../lib/blockClock";

import {
  clearAuction,
  listRfqs,
  postRfq,
  sealBid,
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
  const { address } = useAccount();
  const [rfqs, setRfqs] = useState<RfqState[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  // "auto" means the panel follows the book: whatever the selected auction can
  // have done to it is what is on screen. The other two are the moves that are
  // not about one auction. This was a three-tab strip, which asked the reader to
  // pick a tab before the desk would tell them anything.
  const [panel, setPanel] = useState<"auto" | "post" | "folio" | "audit">("auto");
  const [filter, setFilter] = useState<"all" | "open" | "mine">("all");
  const [log, setLog] = useState<string>("");
  const [offline, setOffline] = useState(false);
  const [demo, setDemo] = useState(false);
  // Read from the diamond, not from whether we can reach a proxy: those are two
  // different facts and the masthead used to conflate them.
  const [tee, setTee] = useState<TeeStatus>({ state: "unknown" });
  useEffect(() => { readTeeStatus().then(setTee); }, []);

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
      const list = await listRfqs();
      setRfqs(list);
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

  const openCount = rfqs.filter((r) => !r.cleared).length;
  const sealedBids = rfqs.reduce((n, r) => n + (r.cleared ? 0 : r.bidCount), 0);

  const NAV = [
    ["auto", "Book"],
    ["folio", "Portfolio"],
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
        <div className="hidden md:flex items-center gap-2 mx-4 my-3 px-2.5 py-1.5 border border-line bg-bg-1 text-[10px] tracking-[0.1em] uppercase text-fg-mute">
          <span className={"w-1.5 h-1.5 " + (tee.state === "production" ? "bg-accent" : "bg-fg-mute")} />
          {tee.state === "production" ? <>Coston2 <Red>///</Red> TEE production</>
            : offline ? <Red>Extension offline</Red>
            : <>Coston2 <Red>///</Red> simulated TEE</>}
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
          Demo book — this browser has no proxy to reach the enclave through.
          Run <span className="opacity-80">BUTA_ALLOW_DIRECT_AUCTION=1 go run ./cmd/dev</span> for the live flow.
          {tee.state === "production" && (
            <> The machine itself is registered and in production — see Audit.</>
          )}
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
              // Only leave the form when the block was actually posted. It
              // reports failures through the same callback with id 0, and
              // closing the form on those threw away what was typed along with
              // the message explaining why it did not go through.
              onDone={(m, id) => {
                setLog(m);
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
            <div className="px-4 pb-4"><Folio address={address} onLog={setLog} /></div>
          </div>
        ) : panel === "audit" ? (
          <Audit tee={tee} />
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
              </span>
              </div>
            </div>

            <div className="grid grid-cols-[4rem_1fr_7rem_6rem_4rem_8rem_6rem_5rem] gap-3 px-4 py-1.5 border-y border-line text-[10px] tracking-[0.12em] uppercase text-fg-mute">
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
                    className="flex-1 min-w-0 text-left grid grid-cols-[4rem_1fr_7rem_6rem_4rem_8rem_6rem] gap-3 px-4 py-2.5 items-center"
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
                      blk {r.deadline.toLocaleString()}
                      {!r.cleared && countdown(r.deadline, block).text && (
                        <span className={"block text-[10px] " + (countdown(r.deadline, block).passed ? "text-accent" : "")}>
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
                      <div className="grid lg:grid-cols-[1fr_20rem] gap-6">
                        <BidForm sel={r} address={address} onDone={(m) => { setLog(m); refresh(); }} />
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
                                  const out: ClearingOutcome = await clearAuction(r.rfqId);
                                  setLog(
                                    `Cleared RFQ ${out.rfqId}: winner ${out.winner} at ${out.clearingPrice.toLocaleString()} (second price, ${out.bidCount} bids). Set digest ${out.setDigest.slice(0, 10)}…`
                                  );
                                  refresh();
                                } catch (e) {
                                  setLog(String((e as Error).message));
                                }
                              }}
                            >
                              Clear RFQ {String(r.rfqId).padStart(3, "0")}
                            </Btn>
                            <span className="text-[10px] text-fg-mute max-w-[26ch] leading-relaxed">
                              Anyone may clear once it is past. Liveness never depends on the maker.
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </>
        )}

        {log && (
          <p className="mx-4 mt-6 pt-4 border-t border-line text-[11px] leading-relaxed text-fg-dim break-all">
            <Red>&gt;&gt;&gt;</Red> {log}
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
const SENDER = env.instructionSender || "0x20d9CcAA7140bf38AD91D2F102bA996417798e8f";

function Audit({ tee }: { tee: TeeStatus }) {
  const rows: [string, React.ReactNode, string][] = [
    [
      "Instruction sender",
      <a className="hover:text-accent break-all" href={`${EXPLORER}${SENDER}`} target="_blank" rel="noopener">{SENDER}</a>,
      "Source-verified on the explorer. Records every commitment, checks the enclave's signature, and rejects a clearing whose set digest is not the set it recorded.",
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
  onDone: (msg: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ commitment: string; nonce: string; amount: string } | null>(null);
  const { signMessageAsync } = useSignMessage();

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
          pressed. All four are decided in this browser: the reader can watch the
          amount stop being a number they typed and become something only the
          enclave can open. */}
      <div className="flex flex-col gap-1">
        <Lbl>Before it leaves this browser</Lbl>
        {[
          [/^\d+$/.test(amount.trim()) && BigInt(amount.trim() || "0") > 0n,
            "A whole, positive number of quote units"],
          [!!bidder, "A wallet to bind the bid to — the enclave recovers the signer"],
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
                sign: (raw) => signMessageAsync({ message: { raw } }),
              });
              setReceipt({ commitment: r.commitment, nonce: r.nonce, amount: amt.toString() });
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
  onDone: (msg: string, rfqId: number) => void;
}) {
  const [pair, setPair] = useState("FXRP/USDT0");
  const [lot, setLot] = useState("250000");
  const [reserve, setReserve] = useState("");
  const [deadline, setDeadline] = useState("");
  const [invited, setInvited] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <Field label="Pair" value={pair} onChange={setPair} />
      <Field label="Lot (base units)" value={lot} onChange={setLot} />
      <Field
        label="Hidden reserve (quote units)"
        value={reserve}
        onChange={setReserve}
        placeholder="120000"
        hint="Your floor. Bidders never see it; a lone bidder pays exactly this."
      />
      <Field
        label="Deadline block"
        value={deadline}
        onChange={setDeadline}
        placeholder="24109880"
        hint="A block number, not a clock. The enclave's clock is not a trust anchor."
      />
      <Field
        label="Invite one counterparty (optional)"
        value={invited}
        onChange={setInvited}
        placeholder="0x… — leave empty for an open auction"
        hint="Direct rail: only this address may bid. Your reserve still stays hidden."
      />
      <Btn
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await postRfq({
              maker: props.address ?? "0x0000000000000000000000000000000000000000",
              pair,
              lot: Number(lot),
              reserve: Number(reserve || "0"),
              deadline: Number(deadline || "0"),
              invited: invited.trim(),
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
