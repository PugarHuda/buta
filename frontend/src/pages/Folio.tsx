/**
 * Folio.tsx — portfolio + selective disclosure.
 *
 * A bidder can prove the exact amount they bid to a chosen party — an auditor,
 * a counterparty — without it ever becoming public, and without being able to
 * lie: any other amount produces a different commitment. Sharpest for the
 * winner, whose true bid stays hidden on-chain (Vickrey pays the second price)
 * yet remains bindingly disclosable.
 */

import { useEffect, useState } from "react";
import type { Address } from "viem";

import { getMyBids, makeDisclosure, verifyDisclosure, type MyBid } from "../lib/buta";
import { seals, forget, type Seal } from "../lib/seals";

function Lbl({ children }: { children: React.ReactNode }) {
  return <span className="text-[11.5px] tracking-[0.12em] uppercase text-fg-mute">{children}</span>;
}
function Red({ children }: { children: React.ReactNode }) {
  return <span className="text-accent">{children}</span>;
}
function Field(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
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
    </label>
  );
}
function Btn(props: { children: React.ReactNode; onClick: () => void; quiet?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      className={
        "px-4 py-2 text-[11px] tracking-[0.12em] uppercase font-mono border transition-colors " +
        (props.quiet
          ? "bg-bg text-fg-dim border-line hover:border-accent hover:text-fg"
          : "bg-accent text-bg border-accent hover:bg-fg hover:border-fg")
      }
    >
      {props.children}
    </button>
  );
}

const EXAMPLE = '{"rfqId":2,"bidder":"0x...","amount":"130450","nonce":"0x..."}';

export function Folio(props: { address?: Address; onLog: (m: string) => void }) {
  const [bids, setBids] = useState<MyBid[]>([]);
  const [amount, setAmount] = useState("");
  const [nonce, setNonce] = useState("");
  const [rfqId, setRfqId] = useState("");
  const [proof, setProof] = useState("");
  const [verdict, setVerdict] = useState("");
  const [mine, setMine] = useState<Seal[]>([]);

  useEffect(() => {
    if (!props.address) return;
    getMyBids(props.address).then(setBids).catch(() => setBids([]));
    setMine(seals(props.address));
  }, [props.address]);

  if (!props.address) {
    return <p className="text-fg-mute">Connect a wallet to see the bids you sealed.</p>;
  }

  const won = bids.filter((b) => b.cleared && b.won).length;
  const open = bids.filter((b) => !b.cleared).length;

  return (
    <div className="flex flex-col gap-6">
      {/* What you hold, before the lists. Counting rows in a table is work the
          page can do. */}
      <div className="flex flex-wrap border border-line">
        {[
          ["Sealed bids", bids.length, "amounts known only to you and the enclave"],
          ["Still open", open, "awaiting a deadline"],
          ["Won", won, "you pay the runner-up's price"],
          ["Seals kept here", mine.length, "in this browser, nowhere else"],
        ].map(([label, value, hint]) => (
          <div key={String(label)} className="px-3 py-2.5 border-r border-line min-w-[10rem] grow">
            <Lbl>{label}</Lbl>
            <div className="text-[19px] leading-tight" style={{ fontFamily: "var(--f-macro)" }}>
              {String(value)}
            </div>
            <div className="text-[11.5px] text-fg-mute leading-tight">{hint}</div>
          </div>
        ))}
      </div>

      <div>
        <Lbl>Your sealed bids</Lbl>
        {bids.length === 0 ? (
          <p className="mt-2 text-fg-mute">Nothing yet. Seal a bid and it shows here.</p>
        ) : (
          <div className="mt-2 flex flex-col gap-px bg-line border border-line">
            {bids.map((b, i) => (
              <div key={i} className="bg-bg px-3 py-2 grid grid-cols-[3rem_1fr_5rem] gap-2 items-center">
                <span className="text-fg-mute">{String(b.rfqId).padStart(3, "0")}</span>
                <span className="text-[11.5px] break-all text-fg-dim">{b.commitment.slice(0, 22)}…</span>
                <span className="text-right">
                  {!b.cleared ? (
                    <span className="text-fg-mute">SEALED</span>
                  ) : b.won ? (
                    <Red>WON</Red>
                  ) : (
                    <span className="text-fg-mute">CLOSED</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="pt-4 border-t border-line">
        <Lbl>Disclose a bid to an auditor</Lbl>
        <p className="mt-1 text-[11.5px] text-fg-mute leading-relaxed max-w-[46ch]">
          Reveal exactly what you bid to one party, provably, without it becoming public. Pick one
          of your seals below, or paste the amount and nonce from a receipt yourself.
        </p>
        {/* Your own seals, one click each.
            This form used to ask you to type back a 32-byte nonce the desk had
            shown you once, in a panel that vanished on the next render — so the
            sharpest thing the product does was, in practice, unusable. The
            seals are kept in this browser because that is the only place they
            CAN be: nobody else can reconstruct them, by design. */}
        {mine.length > 0 && (
          <div className="mt-3">
            <Lbl>Your seals, kept in this browser</Lbl>
            <div className="mt-2 flex flex-col gap-px bg-line border border-line">
              {mine.map((s) => (
                <button
                  key={`${s.rfqId}-${s.commitment}`}
                  onClick={() => {
                    setRfqId(String(s.rfqId));
                    setAmount(s.amount);
                    setNonce(s.nonce);
                    props.onLog(`Loaded your seal for RFQ ${s.rfqId}. Build the disclosure to hand over.`);
                  }}
                  className="bg-bg px-3 py-2 grid grid-cols-[4rem_1fr_6rem] gap-2 items-center text-left hover:bg-bg-1"
                >
                  <span className="text-fg-mute">RFQ-{String(s.rfqId).padStart(3, "0")}</span>
                  <span className="text-[11.5px] text-fg-dim break-all">{s.commitment.slice(0, 22)}…</span>
                  <span className="text-right text-[11.5px] tracking-[0.1em] uppercase text-accent">Use this</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11.5px] text-fg-mute leading-relaxed max-w-[52ch]">
              Anyone with this browser can read these, so they are yours to remove.{" "}
              <button
                onClick={() => { forget(); setMine([]); props.onLog("Seals forgotten. You can no longer prove those bids from this browser."); }}
                className="underline hover:text-accent"
              >
                Forget them
              </button>
            </p>
          </div>
        )}

        <div className="mt-3 flex flex-col gap-3">
          <Field label="RFQ" value={rfqId} onChange={setRfqId} placeholder="2" />
          <Field label="Amount you bid" value={amount} onChange={setAmount} placeholder="130450" />
          <Field label="Nonce (from your receipt)" value={nonce} onChange={setNonce} placeholder="0x…" />
          <Btn
            quiet
            onClick={() => {
              try {
                const p = makeDisclosure({
                  rfqId: Number(rfqId),
                  bidder: props.address!,
                  amount,
                  nonce: nonce as `0x${string}`,
                });
                setProof(p);
                props.onLog("Disclosure built. Hand it to your auditor — they verify it below.");
              } catch (e) {
                props.onLog(String((e as Error).message));
              }
            }}
          >
            Build disclosure
          </Btn>
        </div>
      </div>

      <div className="pt-4 border-t border-line">
        <Lbl>Verify a disclosure</Lbl>
        <p className="mt-1 text-[11.5px] text-fg-mute leading-relaxed max-w-[46ch]">
          Paste a disclosure a bidder gave you. This recomputes the commitment and checks it against
          the one the desk recorded — the bidder cannot lie about their number.
        </p>
        <textarea
          value={proof}
          onChange={(e) => setProof(e.target.value)}
          placeholder={EXAMPLE}
          className="mt-3 w-full bg-bg-1 border border-line px-2.5 py-2 font-mono text-[11.5px] text-fg break-all h-20 outline-none focus:border-accent"
        />
        <div className="mt-3 flex items-center gap-3">
          <Btn
            onClick={async () => {
              try {
                const r = await verifyDisclosure(proof);
                setVerdict(
                  r.ok
                    ? `VERIFIED — ${r.bidder.slice(0, 8)}… bid exactly ${Number(r.amount).toLocaleString()} on RFQ ${r.rfqId}.`
                    : "NOT VERIFIED — the amount does not match the recorded commitment."
                );
              } catch (e) {
                setVerdict(String((e as Error).message));
              }
            }}
          >
            Verify
          </Btn>
          {verdict && (
            <span className={"text-[11px] " + (verdict.startsWith("VERIFIED") ? "text-bid" : "text-accent")}>
              {verdict}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
