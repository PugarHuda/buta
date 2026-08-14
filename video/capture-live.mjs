/**
 * Record the desk doing the whole thing, once, for real.
 *
 *   node video/capture-live.mjs
 *
 * The first capture filmed the page. This one films the WORK: a wallet
 * connects, a block is posted, the book grows a row, a second wallet seals a
 * bid, the deadline passes, the enclave signs, and the contract settles. Every
 * transaction on screen is a real Coston2 transaction sent by an injected
 * wallet that actually broadcasts.
 *
 * It records one continuous session rather than four, and writes down the
 * second each step happened, so the composition can cut to "the moment the
 * receipt appeared" instead of playing three minutes of waiting. Input, then
 * output, in the same shot.
 *
 * Needs two funded wallets, because FXRP refuses a transfer to yourself:
 * DEPLOYMENT_PRIVATE_KEY in .env, and .bidder.key beside it. Both are already
 * there if scripts/settle-from-browser.mjs has ever run.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flareTestnet } from "viem/chains";

const here = fileURLToPath(new URL("./", import.meta.url));
const root = path.join(here, "..");
const out = path.join(here, "public", "clips");
const DESK = process.env.DESK_URL ?? "https://buta-desk.vercel.app/dashboard/";
const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

fs.mkdirSync(out, { recursive: true });

const envValue = (file, key) => {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return null;
  const line = fs.readFileSync(p, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
};
const norm = (k) => (k?.startsWith("0x") ? k : `0x${k}`);

const makerKey = norm(process.env.DEPLOYMENT_PRIVATE_KEY ?? envValue(".env", "DEPLOYMENT_PRIVATE_KEY"));
const bidderRaw = fs.existsSync(path.join(root, ".bidder.key"))
  ? fs.readFileSync(path.join(root, ".bidder.key"), "utf8").trim()
  : null;
if (!makerKey || !bidderRaw) {
  console.error("need DEPLOYMENT_PRIVATE_KEY in .env and .bidder.key - two wallets, FXRP refuses a self-transfer");
  process.exit(2);
}
const maker = privateKeyToAccount(makerKey);
const bidder = privateKeyToAccount(norm(bidderRaw));

const { installWallet, connect } = await import(
  pathToFileURL(path.join(root, "..", "undelayed", "qa", "wallet.mjs")).href
);

const pc = createPublicClient({ chain: flareTestnet, transport: http(RPC) });
const senderAbi = parseAbi(["function rfqCount() view returns (uint256)"]);
const SENDER = (() => {
  const line = fs
    .readFileSync(path.join(root, "config", "extension.env"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("INSTRUCTION_SENDER="));
  return line.slice("INSTRUCTION_SENDER=".length).trim();
})();

/** A drawn pointer, so a click is something a viewer can see coming. */
const CURSOR = `
  (() => {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;z-index:2147483647;width:24px;height:24px;margin:-12px 0 0 -12px;" +
      "border:3px solid #CE1414;border-radius:50%;background:rgba(206,20,20,.18);pointer-events:none;" +
      "transition:transform .22s ease-out,opacity .2s;opacity:0";
    document.body.appendChild(d);
    window.__cur = (x, y) => { d.style.opacity = "1"; d.style.transform = "translate(" + x + "px," + y + "px)"; };
    window.__pulse = () => d.animate(
      [{ transform: d.style.transform + " scale(1)" }, { transform: d.style.transform + " scale(.5)" },
       { transform: d.style.transform + " scale(1)" }], { duration: 300 });
  })()
`;

const marks = {};
const at = {};
let clock = 0;
const now = () => (Date.now() - clock) / 1000;
const moment = (name) => {
  at[name] = Math.max(0, now());
  console.log(`  ${name.padEnd(14)} ${at[name].toFixed(1)}s`);
};

async function mark(page, name, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return;
  marks[name] = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
}

async function pointAt(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return false;
  await page.evaluate(([x, y]) => window.__cur?.(x, y), [
    Math.round(box.x + box.width / 2),
    Math.round(box.y + box.height / 2),
  ]);
  await page.waitForTimeout(500);
  return true;
}

async function press(page, locator) {
  if (!(await pointAt(page, locator))) return false;
  await page.evaluate(() => window.__pulse?.());
  await page.waitForTimeout(200);
  await locator.click({ timeout: 8000 }).catch(() => {});
  return true;
}

/** Wait for a phrase to appear, so a beat ends when the OUTPUT does. */
async function until(page, re, seconds) {
  const stop = Date.now() + seconds * 1000;
  while (Date.now() < stop) {
    const t = (await page.textContent("body").catch(() => "")) ?? "";
    if (re.test(t)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  recordVideo: { dir: out, size: { width: 1440, height: 900 } },
});
await installWallet(ctx, { privateKey: makerKey, broadcast: true });
clock = Date.now();

const page = await ctx.newPage();
await page.goto(DESK, { waitUntil: "load" });
await page
  .waitForFunction(() => !/reading the book from the enclave/i.test(document.body.innerText), null, { timeout: 45000 })
  .catch(() => {});
await page.waitForTimeout(2000);
await page.addScriptTag({ content: CURSOR });

console.log("recording a real run");

// 1. Connect. The address in the corner is the first output.
await connect(page, maker.address).catch(() => {});
await page.waitForTimeout(1500);
moment("connected");

// 2. Post a block. Deadline in minutes, kept short so the whole loop fits in
//    one recording rather than in an hour of waiting.
const before = await pc.readContract({ address: SENDER, abi: senderAbi, functionName: "rfqCount" });
await press(page, page.locator("button", { hasText: /post a block/i }).first());
await page.waitForTimeout(1200);

const fill = async (label, value) => {
  const input = page.locator("label", { hasText: label }).locator("input").first();
  if (!(await input.count())) return;
  await pointAt(page, input);
  await input.click().catch(() => {});
  await input.fill("");
  await input.type(value, { delay: 90 });
  await page.waitForTimeout(400);
};
await fill(/lot/i, "2");
await fill(/reserve/i, "500000");
await fill(/minutes/i, "2");
await mark(page, "postForm", page.locator("label", { hasText: /minutes/i }));
await page.waitForTimeout(900);
moment("postFilled");

await press(page, page.locator("button", { hasText: /^post block$/i }).last());
const posted = await until(page, /posted on-chain|rfq \d+/i, 180);
console.log(`  posted: ${posted}`);
await page.waitForTimeout(3000);
moment("posted");

// The book grew a row. That is the output of the input above.
await page.evaluate(() => window.scrollTo({ top: 320, behavior: "smooth" }));
await page.waitForTimeout(2500);
await mark(page, "newRow", page.locator("button", { hasText: /FXRP\// }).first());
moment("bookGrew");

const after = await pc.readContract({ address: SENDER, abi: senderAbi, functionName: "rfqCount" });
const rfqId = Number(after);
console.log(`  rfqCount ${before} -> ${after}`);

// 3. A second wallet seals a bid on it.
const ctx2 = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  recordVideo: { dir: out, size: { width: 1440, height: 900 } },
});
await installWallet(ctx2, { privateKey: norm(bidderRaw), broadcast: true });
const bidPage = await ctx2.newPage();
await bidPage.goto(DESK, { waitUntil: "load" });
await bidPage
  .waitForFunction(() => !/reading the book from the enclave/i.test(document.body.innerText), null, { timeout: 45000 })
  .catch(() => {});
await bidPage.waitForTimeout(2000);
await bidPage.addScriptTag({ content: CURSOR });
await connect(bidPage, bidder.address).catch(() => {});
await bidPage.waitForTimeout(1200);

const row = bidPage.locator("button", { hasText: new RegExp(`RFQ.?0*${rfqId}(?![0-9])`) }).first();
if (await row.count()) await press(bidPage, row);
await bidPage.waitForTimeout(1500);

const bidField = bidPage.locator("label", { hasText: /your bid/i }).locator("input").first();
if (await bidField.count()) {
  await pointAt(bidPage, bidField);
  await bidField.click().catch(() => {});
  await bidField.type("1500000", { delay: 110 });
  await bidPage.waitForTimeout(1200);
}
await press(bidPage, bidPage.locator("button", { hasText: /^seal bid on-chain$/i }).first());
const sealed = await until(bidPage, /sealed on-chain: 0x[0-9a-f]{64}/i, 240);
console.log(`  sealed: ${sealed}`);
await bidPage.waitForTimeout(3000);

await bidPage.close();
await ctx2.close();

// The bidder's recording is its own file.
const bidClip = fs
  .readdirSync(out)
  .filter((f) => f.endsWith(".webm"))
  .map((f) => ({ f, t: fs.statSync(path.join(out, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (bidClip) {
  fs.rmSync(path.join(out, "live-bid.webm"), { force: true });
  fs.renameSync(path.join(out, bidClip.f), path.join(out, "live-bid.webm"));
  console.log(`  live-bid.webm  ${(fs.statSync(path.join(out, "live-bid.webm")).size / 1e6).toFixed(1)} MB`);
}

// 4. Back on the maker's page: wait out the deadline, clear, settle.
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(6000);
await page.addScriptTag({ content: CURSOR });
const mine = page.locator("button", { hasText: new RegExp(`RFQ.?0*${rfqId}(?![0-9])`) }).first();
if (await mine.count()) await press(page, mine);
await page.waitForTimeout(1500);
moment("waiting");

// Press it, and press it again if the first dispatch comes back empty: that is
// what the desk itself tells a person to do.
let signed = false;
for (let i = 0; i < 3 && !signed; i++) {
  const btn = page.locator("button", { hasText: /request clearing on-chain|ask again for the signed outcome/i }).first();
  if (!(await btn.count())) {
    await page.waitForTimeout(15000);
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(6000);
    await page.addScriptTag({ content: CURSOR });
    if (await mine.count()) await press(page, mine);
    await page.waitForTimeout(1500);
    continue;
  }
  await press(page, btn);
  signed = await until(page, /signed by the enclave/i, i === 0 ? 300 : 150);
}
console.log(`  signed: ${signed}`);
await page.waitForTimeout(2500);
moment("cleared");

const settleBtn = page.locator("button", { hasText: /settle on-chain/i }).first();
if (await settleBtn.count()) await press(page, settleBtn);
const settled = await until(page, /settled on-chain/i, 240);
console.log(`  settled: ${settled}`);
await page.waitForTimeout(4000);
moment("settled");

await page.close();
await ctx.close();
await browser.close();

const madeMain = fs
  .readdirSync(out)
  .filter((f) => f.endsWith(".webm") && f !== "live-bid.webm")
  .map((f) => ({ f, t: fs.statSync(path.join(out, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (madeMain) {
  fs.rmSync(path.join(out, "live.webm"), { force: true });
  fs.renameSync(path.join(out, madeMain.f), path.join(out, "live.webm"));
  console.log(`  live.webm  ${(fs.statSync(path.join(out, "live.webm")).size / 1e6).toFixed(1)} MB`);
}

const marksPath = path.join(here, "src", "marks.json");
const existing = fs.existsSync(marksPath) ? JSON.parse(fs.readFileSync(marksPath, "utf8")) : { marks: {}, starts: {} };
existing.marks = { ...existing.marks, ...marks };
existing.live = at;
existing.rfqId = rfqId;
fs.writeFileSync(marksPath, JSON.stringify(existing, null, 2));
console.log(`moments: ${Object.entries(at).map(([k, v]) => `${k} ${v.toFixed(0)}s`).join(", ")}`);
