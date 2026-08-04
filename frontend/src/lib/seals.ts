/**
 * Your own seal receipts, kept in this browser.
 *
 * Selective disclosure is the sharpest thing this desk does — prove exactly
 * what you bid to one auditor, provably, without it ever becoming public — and
 * it was unusable. Building a disclosure needs the amount AND the 32-byte nonce
 * from the moment you sealed, and the desk showed them once, in a panel that
 * disappeared on the next render. The instruction was, in effect, "copy this by
 * hand or lose the ability to prove your own bid".
 *
 * So they are kept here. This is the right place for them: the nonce is the
 * bidder's secret and belongs to the bidder, not to the enclave and not to the
 * chain. It is also the only place they CAN be kept — the whole design is that
 * nobody else can reconstruct them.
 *
 * That means anyone with this browser can read what you bid. Said plainly in
 * the UI, with a way to forget them, rather than hidden.
 */
import type { Hex } from "viem";

const KEY = "buta.seals.v1";

export type Seal = {
  rfqId: number;
  /** Whose bid. Seals from another wallet are not yours to disclose. */
  bidder: string;
  amount: string;
  nonce: Hex;
  commitment: Hex;
  at: number;
};

function read(): Seal[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    // Corrupt or unavailable storage must not take the desk down with it.
    return [];
  }
}

export function seals(bidder?: string): Seal[] {
  const all = read().sort((a, b) => b.at - a.at);
  if (!bidder) return all;
  return all.filter((s) => s.bidder.toLowerCase() === bidder.toLowerCase());
}

export function remember(s: Omit<Seal, "at">): void {
  try {
    // One seal per (rfq, bidder): the enclave accepts one bid per address, so a
    // second entry for the same pair could only ever be a stale one.
    const rest = read().filter(
      (x) => !(x.rfqId === s.rfqId && x.bidder.toLowerCase() === s.bidder.toLowerCase()),
    );
    localStorage.setItem(KEY, JSON.stringify([...rest, { ...s, at: Date.now() }]));
  } catch {
    // Storage full or blocked. The bid is already sealed; losing the receipt is
    // bad but silently failing to seal would be worse, so this never throws.
  }
}

export function forget(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}
