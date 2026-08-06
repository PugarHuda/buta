/**
 * Settle an auction using nothing but the desk.
 *
 *   node scripts/settle-from-browser.mjs
 *
 * scripts/onchain-loop.ts already settles on Coston2, and it shares libraries
 * with the desk — which is exactly why it does not prove the desk works. It
 * calls the same functions with arguments it builds itself. A button that never
 * fires, a field that never reaches the encoder, a rail wired to the wrong
 * outcome: none of that shows up in a script that bypasses the UI.
 *
 * So this drives the actual pages. Two browser contexts because FXRP reverts
 * CannotTransferToSelf and maker and winner must differ, and both wallets
 * broadcast for real. It spends testnet FXRP and gas, deliberately, which is
 * why it is a one-off driver and not part of any suite.
 *
 * Every step asserts against the chain rather than against what the page says,
 * because a desk that prints "Settled" while nothing moved is the failure this
 * is looking for.
 */
import { createPublicClient, decodeAbiParameters, formatUnits, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flareTestnet } from "viem/chains";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const PORT = Number(process.env.DESK_PORT ?? 5199);
const LOT = "2000000";       // 2 FXRP, six decimals
const RESERVE = "500000";    // 0.5 FXRP floor
const BID = "900000";        // above the floor, so it wins and pays the floor
const MINUTES = "6";      // room for the instruction to reach the enclave before bids close

const root = fileURLToPath(new URL("../", import.meta.url));
const failures = [];
let step = 0;
const say = (m) => console.log(`  ${m}`);
const head = (m) => console.log(`\n[${++step}] ${m}`);
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

function envValue(file, key) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return null;
  const line = fs.readFileSync(p, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
}
const norm = (k) => (k?.startsWith("0x") ? k : `0x${k}`);

const makerKey = norm(process.env.DEPLOYMENT_PRIVATE_KEY ?? envValue(".env", "DEPLOYMENT_PRIVATE_KEY"));
const bidderRaw = fs.existsSync(path.join(root, ".bidder.key"))
  ? fs.readFileSync(path.join(root, ".bidder.key"), "utf8").trim()
  : null;
if (!makerKey || !bidderRaw) {
  console.error("need DEPLOYMENT_PRIVATE_KEY (.env) and .bidder.key — two wallets, because FXRP refuses a self-transfer");
  process.exit(2);
}
const bidderKey = norm(bidderRaw);
const maker = privateKeyToAccount(makerKey);
const bidder = privateKeyToAccount(bidderKey);

const ABI = parseAbi([
  "function rfqCount() view returns (uint256)",
  "function rfqs(uint256) view returns (address maker, address settleToken, address lotToken, uint256 lot, uint64 deadlineBlock, address invited, bool cleared, address winner, uint256 clearingPrice)",
  "function getTeeExtensionInstructionsSender(uint256) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
]);
const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";
const pc = createPublicClient({ chain: flareTestnet, transport: http(RPC) });

// The contract the diamond currently points at, not one written down here.
const SENDER = await pc.readContract({
  address: DIAMOND, abi: ABI, functionName: "getTeeExtensionInstructionsSender", args: [65642n],
});

head("the stack the desk will talk to");
// VITE_TEE_PROXY_URL is deliberately empty — the desk reaches the enclave
// through vite's same-origin proxy, because the enclave sends no CORS headers.
// The upstream is what this script checks directly.
const proxyUrl = envValue("frontend/.env.local", "VITE_PROXY_UPSTREAM") || "http://127.0.0.1:6674";
const info = await fetch(`${proxyUrl}/info`).then((r) => r.ok).catch(() => false);
check(`the enclave proxy answers at ${proxyUrl}`, info, "bring the docker stack up first");
if (!info) process.exit(1);
say(`instruction sender ${SENDER}`);
say(`maker  ${maker.address}`);
say(`bidder ${bidder.address}`);
for (const [who, a] of [["maker", maker.address], ["bidder", bidder.address]]) {
  const b = await pc.readContract({ address: FXRP, abi: ABI, functionName: "balanceOf", args: [a] });
  check(`the ${who} holds FXRP`, b > 0n, `${formatUnits(b, 6)} FXRP`);
  say(`${who} holds ${formatUnits(b, 6)} FXRP`);
}
if (failures.length) process.exit(1);

head(`serve the desk on :${PORT} — the real bundle, with the proxy url it ships with`);
// --host 127.0.0.1 on purpose: left to itself vite binds "localhost", which on
// this machine resolves to ::1 only, and every fetch to 127.0.0.1 gets nothing
// while the port looks taken.
const dev = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: path.join(root, "frontend"),
  stdio: "ignore",
  shell: process.platform === "win32",
});
const url = `http://127.0.0.1:${PORT}/dashboard/`;
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  up = await fetch(url).then((r) => r.ok).catch(() => false);
  if (!up) await new Promise((r) => setTimeout(r, 1000));
}
check("the desk is serving", up);
const stop = () => { try { dev.kill(); } catch { /* already gone */ } };
process.on("exit", stop);
if (!up) { stop(); process.exit(1); }

// Playwright and the wallet harness both live in the undelayed repo — that is
// where the QA suites are. Resolve them from there rather than adding a second
// copy of a browser download to this one.
const qaDir = path.join(root, "..", "undelayed", "qa");
const fileUrl = (p) => `file://${p.split(path.sep).join("/")}`;
const require = createRequire(path.join(qaDir, "wallet.mjs"));
// playwright's entry is CommonJS, so a file:// import puts it on `default`
// rather than exposing named exports.
const pw = await import(fileUrl(require.resolve("playwright")));
const chromium = pw.chromium ?? pw.default?.chromium;
const { installWallet, connect } = await import(fileUrl(path.join(qaDir, "wallet.mjs")));
const browser = await chromium.launch();

/** A page with a broadcasting wallet, already connected. */
async function desk(privateKey, address, seedClearing) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await installWallet(ctx, { privateKey, broadcast: true });
  if (seedClearing) {
    // Exactly what the desk writes when a clearing arrives. Seeding it is how a
    // signature produced in an earlier session is settled — which is the whole
    // reason lib/clearings.ts exists, since the enclave answers
    // "auction: already cleared" and never issues it a second time.
    await ctx.addInitScript((c) => {
      localStorage.setItem("buta.clearings.v1", JSON.stringify([c]));
    }, seedClearing);
  }
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  page error: ${String(e).slice(0, 120)}`));
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(5000);
  const ok = await connect(page, address);
  check(`the desk connects as ${address.slice(0, 8)}…`, ok);
  return page;
}

/** The desk narrates into a receipt strip; this is how a step reports itself. */
const receipts = async (page) => ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
const fill = async (page, label, value) => {
  const i = page.locator("label", { hasText: label }).locator("input").first();
  if (!(await i.count())) return false;
  await i.fill(value);
  return true;
};
/** Wait for a sentence to appear, rather than a fixed sleep — a transaction
 *  takes as long as the chain takes. */
async function until(page, re, seconds = 180) {
  for (let i = 0; i < seconds; i++) {
    if (re.test(await receipts(page))) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

/**
 * Pick up a run that already has an auction on the contract.
 *
 *   RFQ_ID=10 node scripts/settle-from-browser.mjs
 *
 * The waiting is the expensive part — six minutes of blocks — and a run that
 * dies during it has already escrowed a lot and sealed a bid. Re-posting throws
 * both away and strands the lot. This resumes at the deadline instead.
 */
const RESUME = Number(process.env.RFQ_ID ?? 0);
let mp, rfqId, row;
/** A seeded clearing means the enclave has already done its part. */
let skipClearing = false;

if (RESUME) {
  head(`resume RFQ ${RESUME} — it is already posted and bid on`);
  rfqId = BigInt(RESUME);
  row = await pc.readContract({ address: SENDER, abi: ABI, functionName: "rfqs", args: [rfqId] });
  check("that auction exists on the contract", row[0] !== "0x0000000000000000000000000000000000000000");
  check("and it has not settled yet", row[6] === false, "already cleared on-chain");
  const bid = await pc.readContract({
    address: SENDER, abi: parseAbi(["function hasBid(uint256, address) view returns (bool)"]),
    functionName: "hasBid", args: [rfqId, bidder.address],
  }).catch(() => false);
  check("and the bidder's bid is recorded", bid, "no bid from that wallet — nothing to clear");
  if (failures.length) { stop(); process.exit(1); }
  say(`RFQ ${rfqId}, lot ${formatUnits(row[3], 6)} FXRP, deadline block ${row[4]}`);

  // INSTRUCTION_ID: the clearing already happened, in a session whose browser
  // is gone. The proxy still has the signed result filed under the diamond's
  // instruction id, so hand it to the desk the way the desk would have kept it.
  let seed = null;
  if (process.env.INSTRUCTION_ID) {
    const iid = process.env.INSTRUCTION_ID;
    for (const tag of ["threshold", "end", "submit"]) {
      const r = await fetch(`${proxyUrl}/action/result/${iid}?submissionTag=${tag}`).catch(() => null);
      if (!r?.ok) continue;
      const j = await r.json();
      // Only "threshold" carries the four-word ABI outcome; "end" is the
      // consensus envelope, signed and useless. The shape is the test.
      if (j?.result?.status !== 1 || !j?.signature) continue;
      if (!/^0x[0-9a-fA-F]{256}$/.test(j.result.data)) continue;
      const [oR, oW, oP, oD] = decodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
        j.result.data,
      );
      seed = {
        rfqId: Number(oR), instructionId: iid, data: j.result.data, actionId: j.result.id,
        submissionTag: j.result.submissionTag ?? tag, signature: j.signature,
        winner: oW, clearingPrice: Number(oP), setDigest: oD, at: Date.now(),
      };
      break;
    }
    check("the archived clearing was found and is the ABI outcome", !!seed, `nothing settle-able under ${iid}`);
    if (!seed) { stop(); process.exit(1); }
    check("and it is for this auction", seed.rfqId === Number(rfqId), `it is for RFQ ${seed?.rfqId}`);
    say(`recovered: winner ${seed.winner} at ${formatUnits(BigInt(seed.clearingPrice), 6)} FXRP`);
  }
  mp = await desk(makerKey, maker.address, seed);
  if (seed) skipClearing = true;
} else {

head("the maker posts a block, on-chain, from the form");
const before = await pc.readContract({ address: SENDER, abi: ABI, functionName: "rfqCount" });
mp = await desk(makerKey, maker.address);
await mp.locator("button", { hasText: /post a block/i }).first().click().catch(() => {});
await mp.waitForTimeout(700);
await mp.locator("button", { hasText: /^on-chain$/i }).first().click().catch(() => {});
await mp.waitForTimeout(300);
check("the lot field took the amount", await fill(mp, "Lot (base units)", LOT));
check("the reserve field took the floor", await fill(mp, "Hidden reserve (quote units)", RESERVE));
check("the deadline field took the minutes", await fill(mp, "Open for (minutes)", MINUTES));
await mp.locator("button", { hasText: /^post block/i }).last().click().catch(() => {});
// An approval usually comes first, so this waits for the confirmation rather
// than the send.
const posted = await until(mp, /rfqCount is now|posted on-chain/i, 240);
check("the desk says it posted", posted, (await receipts(mp)).slice(-200));

// The desk says "posted" when it has a hash, not when the block lands. Reading
// rfqCount straight after raced the chain and reported 3 -> 3 for a post that
// went through a second later.
let after = before;
for (let i = 0; i < 60 && after <= before; i++) {
  after = await pc.readContract({ address: SENDER, abi: ABI, functionName: "rfqCount" });
  if (after <= before) await new Promise((r) => setTimeout(r, 2000));
}
check("and the CONTRACT agrees a new auction exists", after > before, `rfqCount ${before} -> ${after}`);
if (after <= before) {
  console.log(`\n  what the desk actually said:\n  ${(await receipts(mp)).slice(-700)}`);
  await browser.close();
  stop();
  process.exit(1);
}
rfqId = after;
row = await pc.readContract({ address: SENDER, abi: ABI, functionName: "rfqs", args: [rfqId] });
say(`RFQ ${rfqId}, lot ${formatUnits(row[3], 6)} FXRP, deadline block ${row[4]}`);
check("the maker on-chain is the wallet that pressed the button", row[0].toLowerCase() === maker.address.toLowerCase());

head("a second wallet seals a bid, on-chain, from the desk");
const bp = await desk(bidderKey, bidder.address);
// Rows carry the pair; find the one this run just created.
// No fallback to "any sealed row". There used to be one, and it is how a whole
// run was spent on the DEMO book: /direct was rejected for a missing API key,
// the desk showed demo rows, the fallback picked demo row 5, and the on-chain
// buttons then sent real transactions about contract RFQ 5. If the row this run
// created is not on screen, that is the finding.
// `\b` does not work here: the row renders as "RFQ-008FXRP/USDT0…" with no
// separator, so the boundary after the digits never exists. Look ahead for a
// non-digit instead, which is what "not RFQ-0080" actually means.
const rowBtn = bp.locator("button", { hasText: new RegExp(`RFQ.?0*${rfqId}(?![0-9])`) }).first();
// The auction exists on the contract before the enclave has heard of it — that
// ordering is the point of the design, and it means the book does not show it
// the instant the transaction confirms. Wait for the instruction to arrive
// rather than reading the book once and calling it missing.
let picked = false;
for (let i = 0; i < 18 && !picked; i++) {
  picked = (await rowBtn.count()) > 0;
  if (!picked) {
    await bp.waitForTimeout(10_000);
    await bp.reload({ waitUntil: "networkidle" }).catch(() => {});
    await bp.waitForTimeout(4000);
    // wagmi usually reconnects an injected wallet on load, but "usually" is not
    // something to seal a bid on.
    await connect(bp, bidder.address).catch(() => {});
  }
}
if (picked) await rowBtn.click();
check("the bidder can open the auction the maker just posted", picked, "never appeared in the book");
if (!picked) { await browser.close(); stop(); process.exit(1); }
await bp.waitForTimeout(1200);
await bp.locator("button", { hasText: /seal a bid/i }).first().click().catch(() => {});
await bp.waitForTimeout(600);
check("the bid field is there", await fill(bp, /your bid/i, BID));
await bp.locator("button", { hasText: /seal on-chain instead/i }).first().click().catch(() => {});
// A transaction hash, not the word "commitment" — which is in the static copy
// beside the button and made this pass without a bid ever being sent.
const sealed = await until(bp, /sealed on-chain: 0x[0-9a-f]{64}/i, 240);
check("the desk says the bid is sealed on-chain", sealed, (await receipts(bp)).slice(-200));

// And the contract agrees. The desk's own sentence is the operator's word.
let onChainBid = false;
for (let i = 0; i < 30 && !onChainBid; i++) {
  onChainBid = await pc.readContract({
    address: SENDER,
    abi: parseAbi(["function hasBid(uint256, address) view returns (bool)"]),
    functionName: "hasBid",
    args: [rfqId, bidder.address],
  }).catch(() => false);
  if (!onChainBid) await new Promise((r) => setTimeout(r, 2000));
}
check("and the CONTRACT recorded a bid from that wallet", onChainBid);

} // end of the post-and-bid path; a resumed run joins here

head(`wait for block ${row[4]} — nobody may clear before it`);
for (;;) {
  const h = await pc.getBlockNumber();
  if (h > row[4]) break;
  process.stdout.write(`\r  ${row[4] - h} blocks to go   `);
  await new Promise((r) => setTimeout(r, 5000));
}
console.log("\r  deadline passed          ");

head(
  skipClearing
    ? "the clearing is already signed — the desk picks it up from storage"
    : "the maker asks the enclave to clear it — from the desk",
);
await mp.reload({ waitUntil: "networkidle" });
await mp.waitForTimeout(6000);
const mine = mp.locator("button", { hasText: new RegExp(`RFQ.?0*${rfqId}(?![0-9])`) }).first();
if (await mine.count()) await mine.click();
await mp.waitForTimeout(1000);
if (!skipClearing) {
  const reqBtn = mp.locator("button", { hasText: /request clearing on-chain/i }).first();
  check("the desk offers to request the clearing on-chain", (await reqBtn.count()) > 0);
  if (await reqBtn.count()) await reqBtn.click();
  // The enclave has to open the bids and sign; that is minutes, not seconds.
  const signed = await until(mp, /signed by the enclave/i, 420);
  check("the enclave signed an outcome and the desk shows it", signed, (await receipts(mp)).slice(-260));
}

head("settle — the only transaction that moves money");
// The SETTLEMENT token, not FXRP. The maker is paid in the quote asset and
// gives FXRP away as the lot, so watching their FXRP showed a flat line through
// a settlement that had worked perfectly — a check that could only ever fail.
// row[1] is settleToken, taken from the contract rather than from config.
const quote = row[1];
const mBefore = await pc.readContract({ address: quote, abi: ABI, functionName: "balanceOf", args: [maker.address] });
const wLotBefore = await pc.readContract({ address: FXRP, abi: ABI, functionName: "balanceOf", args: [bidder.address] });
const settleBtn = mp.locator("button", { hasText: /settle on-chain/i }).first();
check("the desk offers to settle", (await settleBtn.count()) > 0);
if (!(await settleBtn.count())) {
  // Which control is missing matters more than that one is. Twice now the
  // answer was neither the button nor the click but what the desk had decided
  // about the row underneath it.
  console.log(`  buttons on screen: ${(await mp.locator("button").allTextContents()).map((s) => s.trim()).filter(Boolean).join(" | ").slice(0, 400)}`);
  console.log(`  the desk's last words: ${(await receipts(mp)).slice(-500)}`);
}
if (await settleBtn.count()) await settleBtn.click();
const said = await until(mp, /settled on-chain/i, 300);
check("the desk says it settled", said, (await receipts(mp)).slice(-260));

// The only answer that counts.
const finalRow = await pc.readContract({ address: SENDER, abi: ABI, functionName: "rfqs", args: [rfqId] });
const mAfter = await pc.readContract({ address: quote, abi: ABI, functionName: "balanceOf", args: [maker.address] });
const wLotAfter = await pc.readContract({ address: FXRP, abi: ABI, functionName: "balanceOf", args: [bidder.address] });
check("the CONTRACT records it cleared", finalRow[6] === true);
check("the winner is the wallet that sealed the bid", finalRow[7].toLowerCase() === bidder.address.toLowerCase(), finalRow[7]);
check(
  "the winner paid the reserve, not their own bid — second price",
  finalRow[8] === BigInt(RESERVE),
  `paid ${formatUnits(finalRow[8], 6)}`,
);
// Both legs, because "delivery versus payment" is a claim about both. One of
// them moving is not a settlement, it is a transfer.
check(
  "and the maker was actually paid, in the settlement token",
  mAfter - mBefore === finalRow[8],
  `${formatUnits(mBefore, 6)} -> ${formatUnits(mAfter, 6)}`,
);
check(
  "and the winner actually got the lot",
  wLotAfter - wLotBefore === finalRow[3],
  `${formatUnits(wLotBefore, 6)} -> ${formatUnits(wLotAfter, 6)} FXRP`,
);
say(`RFQ ${rfqId}: ${formatUnits(finalRow[8], 6)} paid by ${finalRow[7].slice(0, 10)}…, lot ${formatUnits(finalRow[3], 6)} FXRP the other way`);

await browser.close();
stop();
console.log(`\n${failures.length ? `${failures.length} failed` : "the desk settled it, end to end"}`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
