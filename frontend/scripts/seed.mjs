// Seed the dev facade with a book that reads like a working desk:
// cleared receipts, open auctions with sealed bids, an empty fresh one, and a
// directed (invite-only) block. Run with the facade up:
//
//   BUTA_ALLOW_DIRECT_AUCTION=1 go run ./cmd/dev     (from buta/)
//   node scripts/seed.mjs                            (from buta/frontend/)
//
// State lives in extension memory — reseed after every facade restart.

import { Buffer } from "buffer";
globalThis.Buffer = Buffer;
import { encodePacked, keccak256, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import eciesPkg from "ecies-geth";
const { encrypt } = eciesPkg;

const BASE = process.env.FACADE_URL || "http://127.0.0.1:6674";
const b32 = (s) => "0x" + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0");
const hexJson = (o) => "0x" + [...new TextEncoder().encode(JSON.stringify(o))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function call(cmd, payload) {
  const r = await fetch(`${BASE}/direct`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ opType: b32("BUTA"), opCommand: b32(cmd), message: hexJson(payload) }),
  });
  const { data: { id } } = await r.json();
  const res = await (await fetch(`${BASE}/action/result/${id}`)).json();
  if (res.result.status !== 1) throw new Error(`${cmd}: ${res.result.log}`);
  const hex = res.result.data.slice(2);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)))));
}

let nonceCounter = 1n;
async function seal(rfqId, acct, amount) {
  const nonce = "0x" + (nonceCounter++).toString(16).padStart(64, "0");
  const bidder = acct.address.toLowerCase();
  const commitment = keccak256(encodePacked(["uint256", "bytes32", "address"], [BigInt(amount), nonce, bidder]));
  // the enclave recovers this signature and refuses a sender mismatch
  const payload = keccak256(encodePacked(["string", "uint256", "bytes32"], ["BUTA_BID", BigInt(rfqId), commitment]));
  const sig = await acct.signMessage({ message: { raw: payload } });
  const ct = await encrypt(TEE_KEY, Buffer.from(JSON.stringify({ amount, nonce, sig })));
  return call("COMMIT_BID", { rfqId, bidder, commitment, ciphertext: "0x" + ct.toString("hex") });
}

// deterministic demo wallets, keyed 1..9
const W = (n) => privateKeyToAccount(("0x" + String(n).padStart(64, "0")));

// TEE public key, fetched once. Bids are sealed to it before they leave here.
const info = await (await fetch(`${BASE}/info`)).json();
const _x = hexToBytes(info.machineData.publicKey.x);
const _y = hexToBytes(info.machineData.publicKey.y);
const TEE_KEY = Buffer.concat([Buffer.from([0x04]), Buffer.from(_x), Buffer.from(_y)]);

// ── the book ──────────────────────────────────────────────────────────────

// 1: a settled block — the desk's proof it works
let { rfqId: r1 } = await call("POST_RFQ", { maker: W(1).address, pair: "FXRP/USDT0", lot: 250_000, reserve: 122_000, deadline: 24_109_880, invited: "" });
await seal(r1, W(2), 129_850);
await seal(r1, W(3), 130_450);
await seal(r1, W(4), 127_900);
await seal(r1, W(5), 126_300);
await call("CLEAR_AUCTION", { rfqId: r1 });

// 2: a whale block, sealed and live
let { rfqId: r2 } = await call("POST_RFQ", { maker: W(6).address, pair: "FXRP/USDT0", lot: 1_200_000, reserve: 590_000, deadline: 24_121_400, invited: "" });
await seal(r2, W(7), 615_000);
await seal(r2, W(8), 604_200);

// 3: fresh, no bids yet
await call("POST_RFQ", { maker: W(9).address, pair: "FXRP/USDT0", lot: 80_000, reserve: 38_500, deadline: 24_118_000, invited: "" });

// 4: directed block — one invited counterparty, one sealed quote
let { rfqId: r4 } = await call("POST_RFQ", { maker: W(1).address, pair: "FXRP/USDT0", lot: 500_000, reserve: 243_000, deadline: 24_125_000, invited: W(7).address });
await seal(r4, W(7), 251_500);

// 5: lone bidder cleared at the reserve — the honest edge case, on display
let { rfqId: r5 } = await call("POST_RFQ", { maker: W(3).address, pair: "FXRP/USDT0", lot: 60_000, reserve: 29_400, deadline: 24_100_000, invited: "" });
await seal(r5, W(2), 31_000);
await call("CLEAR_AUCTION", { rfqId: r5 });

const book = await call("LIST_RFQS", {});
console.log(`seeded ${book.length} auctions:`);
for (const r of book) {
  console.log(
    `  ${String(r.rfqId).padStart(3, "0")}  ${r.pair}  lot ${r.lot.toLocaleString()}  bids ${r.bidCount}  ` +
    (r.cleared ? `CLEARED @ ${r.clearingPrice.toLocaleString()}` : "SEALED")
  );
}
