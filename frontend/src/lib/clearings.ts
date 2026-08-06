/**
 * Signed clearings, kept in this browser until they are settled.
 *
 * Between "the enclave signed it" and "the contract paid" there is a real gap,
 * and the desk used to lose everything in it. The outcome lived in React state:
 * reload the page, close the tab, and the signature was gone — with the lot
 * still escrowed and no way to get it back, because asking the enclave again
 * does not work. It answers `error: auction: already cleared` and returns
 * nothing. The outcome is produced exactly once.
 *
 * It is still retrievable, though, because the proxy archives every result
 * under the instruction id the diamond assigned. Losing it was never a fact
 * about the enclave — only about the desk not writing down the id.
 *
 * So it is written down. Same reasoning as seals.ts: this belongs in the
 * browser of the person who asked for it, and nothing here is a secret — a
 * signed clearing is meant to be relayed, and anyone may relay it.
 */
import type { Hex } from "viem";

const KEY = "buta.clearings.v1";

export type StoredClearing = {
  rfqId: number;
  /** The diamond's instruction id — how the archived result is found again. */
  instructionId: Hex;
  data: Hex;
  actionId: Hex;
  submissionTag: string;
  signature: Hex;
  winner: string;
  clearingPrice: number;
  setDigest: Hex;
  at: number;
};

function read(): StoredClearing[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    // Corrupt or unavailable storage must not take the desk down with it.
    return [];
  }
}

function write(list: StoredClearing[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private browsing, quota, a disabled store — none of it is fatal here */
  }
}

/** Keep it, replacing any earlier one for the same auction. */
export function rememberClearing(c: Omit<StoredClearing, "at">) {
  write([...read().filter((x) => x.rfqId !== c.rfqId), { ...c, at: Date.now() }]);
}

export function recallClearing(rfqId: number): StoredClearing | null {
  return read().find((c) => c.rfqId === rfqId) ?? null;
}

export function allClearings(): StoredClearing[] {
  return read();
}

/** Once the contract has settled it, the signature has done its work. */
export function forgetClearing(rfqId: number) {
  write(read().filter((c) => c.rfqId !== rfqId));
}
