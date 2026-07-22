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

function Lbl({ children }: { children: React.ReactNode }) {
  return <span className="text-[10px] tracking-[0.12em] uppercase text-fg-mute">{children}</span>;
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

  useEffect(() => {
    if (!props.address) return;
    getMyBids(props.address).then(setBids).catch(() => setBids([]));
  }, [props.address]);

  if (!props.address) {
    return <p className="text-fg-mute">Connect a wallet to see the bids you sealed.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Lbl>Your sealed bids</Lbl>
        {bids.length === 0 ? (
          <p className="mt-2 text-fg-mute">Nothing yet. Seal a bid and it shows here.</p>
        ) : (
          <div className="mt-2 flex flex-col gap-px bg-line border border-line">
            {bids.map((b, i) => (
              <div key={i} className="bg-bg px-3 py-2 grid grid-cols-[3rem_1fr_5rem] gap-2 items-center">
                <span className="text-fg-mute">{String(b.rfqId).padStart(3, "0")}</span>
                <span className="text-[10px] break-all text-fg-dim">{b.commitment.slice(0, 22)}…</span>
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
        <p className="mt-1 text-[10px] text-fg-mute leading-relaxed max-w-[46ch]">
          Reveal exactly what you bid to one party, provably, without it becoming public. Paste the
          amount and the nonce from your seal receipt.
        </p>
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
        <p className="mt-1 text-[10px] text-fg-mute leading-relaxed max-w-[46ch]">
          Paste a disclosure a bidder gave you. This recomputes the commitment and checks it against
          the one the desk recorded — the bidder cannot lie about their number.
        </p>
        <textarea
          value={proof}
          onChange={(e) => setProof(e.target.value)}
          placeholder={EXAMPLE}
          className="mt-3 w-full bg-bg-1 border border-line px-2.5 py-2 font-mono text-[10px] text-fg break-all h-20 outline-none focus:border-accent"
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
