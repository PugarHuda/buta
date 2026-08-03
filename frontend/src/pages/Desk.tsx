/**
 * Desk.tsx — the sealed-bid desk.
 *
 * One screen, three moves: post a block, seal a bid, clear at the second
 * price. The layout owes everything to the landing page's Swiss Industrial
 * Print language: paper, carbon ink, one aviation red, hairline grids, no
 * radii, uppercase reserved for labels and unit ids.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import type { Address } from "viem";
import { Folio } from "./Folio";
import { TOKENS } from "../config/tokens";
import { DEMO_BOOK } from "../lib/demoData";
import { env } from "../config/env";
import { readTeeStatus, type TeeStatus } from "../lib/teeStatus";

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
  const [tab, setTab] = useState<"bid" | "post" | "folio">("bid");
  const [log, setLog] = useState<string>("");
  const [offline, setOffline] = useState(false);
  const [demo, setDemo] = useState(false);
  // Read from the diamond, not from whether we can reach a proxy: those are two
  // different facts and the masthead used to conflate them.
  const [tee, setTee] = useState<TeeStatus>({ state: "unknown" });
  useEffect(() => { readTeeStatus().then(setTee); }, []);

  // A production bundle with no VITE_TEE_PROXY_URL has nowhere to ask: relative
  // URLs only resolve through vite's dev proxy. Polling anyway meant a 404
  // every few seconds in the console of anyone who opened the deployed desk,
  // for an answer we already knew. Go straight to the demo book instead.
  const canReachExtension = import.meta.env.DEV || Boolean(env.teeProxyUrl);

  const refresh = useCallback(async () => {
    if (!canReachExtension) {
      setRfqs(DEMO_BOOK);
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
      setRfqs(DEMO_BOOK);
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

  const sel = useMemo(() => rfqs.find((r) => r.rfqId === selected) ?? null, [rfqs, selected]);

  return (
    <div className="min-h-screen bg-bg text-fg font-mono text-[12px]">
      {/* masthead */}
      <header className="sticky top-0 z-40 bg-bg">
        <div className="flex items-center gap-4 px-4 py-2">
          <span className="font-macro text-[15px] tracking-tight uppercase" style={{ fontFamily: "var(--f-macro)" }}>
            BUTA<Red>®</Red>
          </span>
          <span className="hidden md:block text-[10px] tracking-[0.12em] uppercase text-fg-mute">
            [ SEALED-BID OTC DESK ]
          </span>
          <span className="flex-1" />
          <a
            href={`https://coston2-explorer.flare.network/address/${TOKENS.FXRP.address}`}
            target="_blank" rel="noopener"
            className="hidden lg:block text-[10px] tracking-[0.1em] uppercase text-fg-mute hover:text-accent"
            title="FXRP on Coston2"
          >
            SETTLES IN FXRP <Red>///</Red> {TOKENS.FXRP.address.slice(0, 6)}…
          </a>
          <span className="text-[10px] tracking-[0.1em] uppercase text-fg-mute">
            {tee.state === "production" ? (
              <>COSTON2 <Red>///</Red> TEE <Red>PRODUCTION</Red></>
            ) : offline ? (
              <Red>EXTENSION OFFLINE</Red>
            ) : (
              <>COSTON2 <Red>///</Red> SIMULATED TEE</>
            )}
          </span>
          <ConnectButton showBalance={false} accountStatus="address" chainStatus="none" />
        </div>
        <div className="h-[3px] bg-fg" />
      </header>

      {demo && (
        <div className="px-4 py-1.5 bg-accent text-bg text-[10px] tracking-[0.12em] uppercase">
          Demo data — no extension reachable from here. Run <span className="opacity-80">BUTA_ALLOW_DIRECT_AUCTION=1 go run ./cmd/dev</span> locally for the live flow.
          {tee.state === "production" && (
            <> The TEE machine <span className="opacity-80">{tee.machine.slice(0, 10)}…</span> is registered and in production on Coston2 — this browser simply has no proxy to reach it through.</>
          )}
        </div>
      )}
      {/* who this is for — the first thing a judge reads */}
      <p className="px-4 py-3 max-w-[72ch] text-[12.5px] leading-relaxed text-fg-dim">
        For desks moving size. Post a block, collect sealed bids, clear at the fair second
        price. <b className="text-fg">Nobody can read a bid before it clears — not the maker,
        not the operator, not us.</b> Losing amounts are never revealed at all.
      </p>
      <div className="h-px bg-line" />

      <main className="grid md:grid-cols-[1.5fr_1fr] gap-px bg-line">
        {/* ── the book ── */}
        <section className="bg-bg min-h-[70vh]">
          <div className="flex items-baseline gap-4 px-4 py-2.5">
            <Lbl>Open auctions</Lbl>
            <span className="text-[10px] text-fg-mute">{rfqs.length} on the desk</span>
          </div>
          <div className="grid grid-cols-[3rem_1fr_6rem_4rem_7rem_6rem] gap-2 px-4 py-1.5 border-y border-line text-[10px] tracking-[0.12em] uppercase text-fg-mute">
            <span>No</span><span>Pair</span><span>Lot</span><span>Bids</span><span>Deadline</span><span className="text-right">State</span>
          </div>
          {rfqs.length === 0 && (
            <p className="px-4 py-6 text-fg-mute">
              {offline
                ? "The extension is not reachable. Start it with BUTA_ALLOW_DIRECT_AUCTION=1 and refresh."
                : "No auctions yet. Post the first block on the right."}
            </p>
          )}
          {rfqs.map((r) => (
            <button
              key={r.rfqId}
              onClick={() => setSelected(r.rfqId)}
              className={
                "w-full text-left grid grid-cols-[3rem_1fr_6rem_4rem_7rem_6rem] gap-2 px-4 py-2 border-b border-line-2/40 hover:bg-bg-1 " +
                (selected === r.rfqId ? "bg-bg-2" : "")
              }
            >
              <span className="text-fg-mute">{String(r.rfqId).padStart(3, "0")}</span>
              <span>{r.pair}</span>
              <span>{r.lot.toLocaleString()}</span>
              <span>{r.bidCount}</span>
              <span className="text-fg-mute">blk {r.deadline.toLocaleString()}</span>
              <span className="text-right">
                {r.cleared ? <Red>CLEARED</Red> : <span className="text-fg-mute">SEALED</span>}
              </span>
            </button>
          ))}

          {/* clearing receipt for the selected auction */}
          {sel?.cleared && (
            <div className="m-4 border border-fg">
              <div className="px-3 py-2 border-b border-line bg-bg-2 flex items-baseline gap-3">
                <Lbl>Clearing receipt</Lbl>
                <span className="text-fg-mute text-[10px]">RFQ {String(sel.rfqId).padStart(3, "0")}</span>
              </div>
              <div className="grid sm:grid-cols-3 gap-px bg-line">
                <div className="bg-bg px-3 py-2.5">
                  <Lbl>Winner</Lbl>
                  <div className="mt-1 break-all">{sel.winner}</div>
                </div>
                <div className="bg-bg px-3 py-2.5">
                  <Lbl>Clearing price</Lbl>
                  <div className="mt-1 text-[15px]" style={{ fontFamily: "var(--f-macro)" }}>
                    {sel.clearingPrice?.toLocaleString()}
                  </div>
                  <div className="text-[10px] text-fg-mute">Vickrey second price</div>
                </div>
                <div className="bg-bg px-3 py-2.5">
                  <Lbl>Sealed forever</Lbl>
                  <div className="mt-1">
                    {sel.bidCount - 1} losing {sel.bidCount - 1 === 1 ? "amount" : "amounts"},
                    the winner's own bid, and the reserve.
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* ── actions ── */}
        <section className="bg-bg">
          <div className="flex border-b border-line">
            {(["bid", "post", "folio"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  "px-4 py-2.5 text-[10px] tracking-[0.12em] uppercase border-r border-line " +
                  (tab === t ? "bg-fg text-bg" : "text-fg-mute hover:text-fg")
                }
              >
                {t === "bid" ? "Seal a bid" : t === "post" ? "Post a block" : "Portfolio"}
              </button>
            ))}
          </div>

          <div className="p-4">
            {tab === "bid" ? (
              <BidForm sel={sel} address={address} onDone={(m) => { setLog(m); refresh(); }} />
            ) : tab === "post" ? (
              <PostForm address={address} onDone={(m, id) => { setLog(m); setSelected(id); refresh(); }} />
            ) : (
              <Folio address={address} onLog={setLog} />
            )}

            {sel && !sel.cleared && (
              <div className="mt-6 pt-4 border-t border-line">
                <Lbl>Deadline reached?</Lbl>
                <div className="mt-2 flex items-center gap-3">
                  <Btn
                    quiet
                    onClick={async () => {
                      try {
                        const out: ClearingOutcome = await clearAuction(sel.rfqId);
                        setLog(
                          `Cleared RFQ ${out.rfqId}: winner ${out.winner} at ${out.clearingPrice.toLocaleString()} (second price, ${out.bidCount} bids). Set digest ${out.setDigest.slice(0, 10)}…`
                        );
                        refresh();
                      } catch (e) {
                        setLog(String((e as Error).message));
                      }
                    }}
                  >
                    Clear RFQ {String(sel.rfqId).padStart(3, "0")}
                  </Btn>
                  <span className="text-[10px] text-fg-mute max-w-[24ch]">
                    Anyone may clear after the deadline. Liveness never depends on the maker.
                  </span>
                </div>
              </div>
            )}

            {log && (
              <p className="mt-6 pt-4 border-t border-line text-[11px] leading-relaxed text-fg-dim break-all">
                <Red>&gt;&gt;&gt;</Red> {log}
              </p>
            )}
          </div>
        </section>
      </main>

      <footer className="border-t-2 border-fg px-4 py-3 flex flex-wrap gap-x-6 gap-y-1 text-[10px] tracking-[0.08em] uppercase text-fg-mute">
        <span>BUTA<Red>®</Red> — sealed-bid OTC on Flare Confidential Compute</span>
        <span>Demo runs the simulated-TEE path <Red>///</Red> not audited <Red>///</Red> not deployed</span>
      </footer>
    </div>
  );
}

// ── forms ────────────────────────────────────────────────────────────────────

function BidForm(props: {
  sel: RfqState | null;
  address?: Address;
  onDone: (msg: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ commitment: string; nonce: string; amount: string } | null>(null);
  const { signMessageAsync } = useSignMessage();

  if (!props.sel) {
    return <p className="text-fg-mute">Select an auction on the left to bid on it.</p>;
  }
  if (props.sel.cleared) {
    return <p className="text-fg-mute">This auction has cleared. The book is closed.</p>;
  }

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
