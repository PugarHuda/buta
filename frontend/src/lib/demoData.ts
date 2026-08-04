/**
 * demoData.ts — the book a visitor sees when no extension is reachable.
 *
 * A deployed desk has no backend of its own (the extension runs on the
 * operator's machine). Rather than show an empty "offline" screen to a judge
 * clicking through from the landing, the desk falls back to this snapshot — the
 * same shape LIST_RFQS returns — with a clear "demo book" banner. Running the
 * extension locally replaces it with the live book.
 *
 * The commitments are keccak of a fixed string, so they are stable between
 * builds and obviously not real openings. They are here because the desk shows
 * them: a bid count is a number you take on trust, and a list of commitment
 * hashes each marked as an amount nobody can read is the product's claim made
 * visible. A demo book without them would demonstrate the wrong thing.
 */

import type { RfqState } from "./buta";

/**
 * Deadlines are block numbers, and a fixed one goes stale: the book was written
 * around block 24.1M and Coston2 is past 33M, so every row read "deadline passed
 * 9,478,951 blocks ago" — which demonstrates the countdown by showing it in only
 * one state, the useless one. Placed around the chain's head instead, the demo
 * shows what it is for: two auctions with hours left, one that can be cleared
 * now, and the closed ones behind us.
 */
export function demoBook(head: bigint | null): RfqState[] {
  if (head === null) return DEMO_BOOK;
  const at = (offset: number) => Number(head) + offset;
  const OFFSETS: Record<number, number> = {
    6: -40_000, // cleared, well behind
    5: +4_000, //  about two hours left
    4: +1_200, //  about half an hour
    3: -50, //     past its deadline: clearable right now
    2: -30_000,
    1: -30_000,
  };
  return DEMO_BOOK.map((r) => ({ ...r, deadline: at(OFFSETS[r.rfqId] ?? -1_000) }));
}

export const DEMO_BOOK: RfqState[] = [
  {
    rfqId: 6, maker: "0x0000000000000000000000000000000000000000", pair: "FXRP/USDT0",
    lot: 60_000, deadline: 24_100_000, bidCount: 1, cleared: true,
    winner: "0x2222222222222222222222222222222222222222", clearingPrice: 29_400,
    commitments: ["0xfae8f6cb36a2674fca3a432001d7120f7fa1daab258e1dbec80d4ee4c62c0605"],
  },
  {
    rfqId: 5, maker: "0x0000000000000000000000000000000000000000", pair: "FXRP/USDT0",
    lot: 500_000, deadline: 24_125_000, bidCount: 1, cleared: false,
    commitments: ["0xfd2a777ff2ea8e981724165c631a98110eb20a1c438640160baa8079ef0baedf"],
  },
  {
    rfqId: 4, maker: "0x0000000000000000000000000000000000000000", pair: "FXRP/USDT0",
    lot: 80_000, deadline: 24_118_000, bidCount: 0, cleared: false,
    commitments: [],
  },
  {
    rfqId: 3, maker: "0x0000000000000000000000000000000000000000", pair: "FXRP/USDT0",
    lot: 1_200_000, deadline: 24_121_400, bidCount: 2, cleared: false,
    commitments: [
      "0x761db04c64d0d9f67dee18386dd67338937e6279c756f2c366c4345bae9dcc24",
      "0xcd809e18f3733077ce6c1592d9f3e2757b7a9fea175e853aa7bc7380d59a4fda",
    ],
  },
  {
    rfqId: 2, maker: "0x0000000000000000000000000000000000000000", pair: "FXRP/USDT0",
    lot: 250_000, deadline: 24_109_880, bidCount: 4, cleared: true,
    winner: "0x2222222222222222222222222222222222222222", clearingPrice: 129_850,
    commitments: [
      "0xf0dbef675fea713b518120fb68481e3d0daf0a87a45eb6457f43aa746c1c533b",
      "0xb4c935e547ed881f443e8baf479a879ee9897b16d3c588499c6e206b6958cd54",
      "0xfd01345526dddee11f070d72b206d489ab19345cfbc314c4ff15cc115edaf9af",
      "0x7b5aa096a0aedb2f65da6917022610dc2b57c71e9129b7bb09099581cf406e0d",
    ],
  },
  {
    rfqId: 1, maker: "0x0000000000000000000000000000000000000000", pair: "FXRP/USDT0",
    lot: 250_000, deadline: 24_109_880, bidCount: 3, cleared: true,
    winner: "0x2222222222222222222222222222222222222222", clearingPrice: 129_850,
    commitments: [
      "0x62d7ec22e7c8bd0abbb3805fffbe9febfb2c5709c5e014a56a3a4261f639433b",
      "0x94e6c8aac1afac7f72db48868c30c406e45a24635f8b7f71a959f29850371b3a",
      "0x034a0d961858eba4783d84c428267881cfab16411fcd0e3878129c39c2534d40",
    ],
  },
];
