// prove-screen.mjs — drive one auction through the running dev extension and
// show the solvency screen actually passing over a bidder who cannot pay.
//
//   BUTA_ALLOW_DIRECT_AUCTION=1 BUTA_FUNDS_RPC=... BUTA_INSTRUCTION_SENDER=0x... go run ./cmd/dev
//   node scripts/prove-screen.mjs
//
// The screen was wired and unit-tested and had never run against a real balance.
// Two bidders: the higher one is a throwaway key holding nothing, the lower one
// is our deployer, which holds FTestXRP and has approved the desk. Vickrey says
// the higher bid wins. Solvency says it cannot settle. The screen decides.
import { createPublicClient, http, keccak256, encodePacked, toHex, parseAbi } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { flareTestnet } from "viem/chains";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROXY = process.env.EXT_PROXY_URL ?? "http://localhost:6674";
import { SENDER as CONFIGURED } from "./ext-config.mjs";
const SENDER = process.env.BUTA_INSTRUCTION_SENDER ?? CONFIGURED;
const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";
const CHAIN_ID = 114;

const env = Object.fromEntries(
  readFileSync(fileURLToPath(new URL("../.env.deployer", import.meta.url)), "utf8")
    .split(/\r?\n/).filter((l) => l && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const funded = privateKeyToAccount(
  env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`,
);
const broke = privateKeyToAccount(generatePrivateKey());

const pad32 = (s) => "0x" + Buffer.from(s).toString("hex").padEnd(64, "0");
const hexMsg = (o) => toHex(JSON.stringify(o));

async function direct(opCommand, payload) {
  const res = await fetch(`${PROXY}/direct`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ opType: pad32("BUTA"), opCommand: pad32(opCommand), message: hexMsg(payload) }),
  });
  if (!res.ok) throw new Error(`${opCommand}: HTTP ${res.status} ${await res.text()}`);
  const { data } = await res.json();
  // The dev server answers synchronously; the id is the handle to the result.
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${PROXY}/action/result/${data.id}`).catch(() => null);
    if (r?.ok) {
      const j = await r.json();
      if (j?.result) return j.result;
    }
    await new Promise((s) => setTimeout(s, 250));
  }
  return data;
}

// Commit = keccak256(uint256(amount) || nonce || bidder), as pkg/auction does.
const commit = (amount, nonce, addr) =>
  keccak256(encodePacked(["uint256", "bytes32", "address"], [BigInt(amount), nonce, addr]));

const bidPayload = (rfqId, commitment) =>
  keccak256(
    encodePacked(["string", "uint256", "uint256", "bytes32"], ["BUTA_BID", BigInt(CHAIN_ID), BigInt(rfqId), commitment]),
  );

console.log("\n  proving the solvency screen against real balances\n");

const pc = createPublicClient({ chain: flareTestnet, transport: http() });
const bal = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
for (const [who, a] of [["funded", funded], ["broke ", broke]]) {
  const [b, al] = await Promise.all([
    pc.readContract({ address: FXRP, abi: bal, functionName: "balanceOf", args: [a.address] }),
    pc.readContract({ address: FXRP, abi: bal, functionName: "allowance", args: [a.address, SENDER] }),
  ]);
  console.log(`  ${who} ${a.address}  balance ${Number(b) / 1e6} FXRP  allowance ${Number(al) / 1e6}`);
}

const post = await direct("POST_RFQ", {
  rfqId: 0, maker: funded.address, pair: "FXRP/FXRP", lot: 1000, reserve: 100, deadline: 1, invited: "", settleToken: FXRP,
});
const rfqId = JSON.parse(Buffer.from((post.data ?? "0x").slice(2), "hex").toString() || "{}").rfqId;
console.log(`\n  rfq ${rfqId} posted`);

for (const [label, acct, amount, seed] of [
  ["broke  bids 900 (highest)", broke, 900, 1],
  ["funded bids 500", funded, 500, 2],
]) {
  const nonce = ("0x" + String(seed).padStart(64, "0"));
  const c = commit(amount, nonce, acct.address);
  const sig = await acct.signMessage({ message: { raw: bidPayload(rfqId, c) } });
  await direct("COMMIT_BID", {
    rfqId, bidder: acct.address.toLowerCase(), commitment: c, amount, nonce, sig,
  });
  console.log(`  ${label}`);
}

const cleared = await direct("CLEAR_AUCTION", { rfqId });
const body = Buffer.from((cleared.data ?? "0x").slice(2), "hex").toString();
console.log(`\n  clearing: ${body || cleared.log || "(no data)"}\n`);

const out = JSON.parse(body || "{}");
if (out.winner?.toLowerCase() === funded.address.toLowerCase()) {
  console.log("  The highest bid lost. It could not settle, so the screen passed over it");
  console.log("  and awarded to the bidder who can — which is the whole point.\n");
} else if (out.winner?.toLowerCase() === broke.address.toLowerCase()) {
  console.log("  The unfunded bidder WON — the screen is not running.\n");
  process.exit(1);
}
