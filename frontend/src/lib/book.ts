/**
 * The book, as it arrives, before anything renders it.
 *
 * The submission's whole claim is that the operator relaying for the enclave is
 * not trusted. The desk did trust it completely: it took whatever LIST_RFQS
 * returned and called `.toLocaleString()` on it. A row missing `lot`, or a
 * response that was an object rather than an array, threw during render and
 * white-screened the entire desk — nothing on the page, no message, no book.
 *
 * A hostile operator did not need to be clever about it. Version skew between
 * enclave and desk would do the same thing by accident.
 *
 * So: one guard, where every caller routes through, rather than a guard at
 * every place a field is read. Anything that is not a usable row is dropped
 * instead of being rendered as NaN, Infinity or [object Object].
 */
import type { MyBid, RfqState } from "./buta";

/** A finite, non-negative integer, or null. Rejects NaN, Infinity, strings,
 *  objects, and negatives — a lot cannot be -5000 and a deadline cannot be
 *  1e308, whatever the wire says. */
function count(v: unknown): number | null {
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  // MAX_SAFE_INTEGER, not just "finite". 1e308 is a finite number and passed —
  // then the countdown multiplied it by 1.8 seconds a block and the desk
  // printed "Infinity". Past 2^53 these are not integers anyway, so rendering
  // one as a lot or a block number would be a lie whatever it did downstream.
  if (n > Number.MAX_SAFE_INTEGER) return null;
  return Math.floor(n);
}

function text(v: unknown, max = 64): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

/** One row, or null if it cannot be shown honestly. */
function row(raw: unknown): RfqState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const rfqId = count(r.rfqId);
  const lot = count(r.lot);
  const deadline = count(r.deadline);
  const bidCount = count(r.bidCount);
  const maker = text(r.maker);
  const pair = text(r.pair, 32);
  if (rfqId === null || lot === null || deadline === null || bidCount === null) return null;
  if (maker === null || pair === null) return null;
  if (typeof r.cleared !== "boolean") return null;

  const out: RfqState = { rfqId, maker, pair, lot, deadline, bidCount, cleared: r.cleared };

  // A cleared auction without a winner and a price is not a cleared auction.
  // Showing one as CLEARED with an empty receipt would be the desk making a
  // claim on the operator's behalf.
  if (r.cleared) {
    const winner = text(r.winner);
    const price = count(r.clearingPrice);
    if (winner === null || price === null) return null;
    out.winner = winner;
    out.clearingPrice = price;
  }

  // Commitments are optional — an older enclave does not send them — but if
  // they arrive they must look like the 32-byte hashes they claim to be.
  if (Array.isArray(r.commitments)) {
    out.commitments = r.commitments.filter(
      (c): c is string => typeof c === "string" && /^0x[0-9a-fA-F]{64}$/.test(c),
    );
  }
  return out;
}

/**
 * Whatever came back, turned into rows that can be rendered — and a count of
 * what was thrown away, so the desk can say so rather than quietly showing a
 * shorter book than the enclave reported.
 */
/**
 * The same treatment for the bidder's own receipts.
 *
 * Guarding LIST_RFQS and leaving this raw was half a fix: Portfolio renders
 * `b.commitment.slice(0, 22)`, so one receipt without a commitment white-screens
 * it exactly the way a bad row white-screened the book.
 */
export function readMyBids(raw: unknown): MyBid[] {
  if (!Array.isArray(raw)) return [];
  const out: MyBid[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    const rfqId = count(b.rfqId);
    const pair = text(b.pair, 32);
    const commitment = text(b.commitment, 66);
    if (rfqId === null || pair === null || commitment === null) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(commitment)) continue;
    if (typeof b.cleared !== "boolean" || typeof b.won !== "boolean") continue;
    out.push({ rfqId, pair, commitment: commitment as MyBid["commitment"], cleared: b.cleared, won: b.won });
  }
  return out;
}

export function readBook(raw: unknown): { rfqs: RfqState[]; dropped: number } {
  if (!Array.isArray(raw)) return { rfqs: [], dropped: raw == null ? 0 : 1 };
  const rfqs: RfqState[] = [];
  let dropped = 0;
  for (const item of raw) {
    const r = row(item);
    if (r) rfqs.push(r);
    else dropped++;
  }
  return { rfqs, dropped };
}
