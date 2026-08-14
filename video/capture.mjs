/**
 * Record the real desk, so the video shows the product rather than a mock.
 *
 *   node video/capture.mjs [url]
 *
 * Playwright drives the deployed desk and records the session to webm. Every
 * frame is the live page talking to the live enclave: the book comes from the
 * machine on the tunnel, the countdown from the chain's head. Nothing here is
 * staged except the pacing, which is slowed on purpose so a viewer can follow a
 * pointer that has no hand attached to it.
 *
 * The clips land in video/public/clips/ where the Remotion composition reads
 * them. Re-run it and the video is re-cut from a fresh recording.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const out = path.join(root, "public", "clips");
const DESK = process.argv[2] ?? "https://buta-desk.vercel.app/dashboard/";
const DECK = "https://buta-desk.vercel.app/deck";

fs.mkdirSync(out, { recursive: true });

/** A visible pointer, because a screen recording with no cursor reads as a slideshow. */
const CURSOR = `
  (() => {
    const d = document.createElement("div");
    d.id = "__cur";
    d.style.cssText = "position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;" +
      "border:2px solid #CE1414;border-radius:50%;background:rgba(206,20,20,.16);pointer-events:none;" +
      "transition:transform .18s ease-out,opacity .2s;opacity:0";
    document.body.appendChild(d);
    window.__cur = (x, y) => { d.style.opacity = "1"; d.style.transform = "translate(" + x + "px," + y + "px)"; };
    window.__pulse = () => {
      d.animate([{ transform: d.style.transform + " scale(1)" }, { transform: d.style.transform + " scale(.55)" },
                 { transform: d.style.transform + " scale(1)" }], { duration: 260 });
    };
  })()
`;

async function pointAt(page, locator) {
  const box = await locator.boundingBox();
  if (!box) return null;
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.evaluate(([x, y]) => window.__cur?.(x, y), [x, y]);
  await page.waitForTimeout(420);
  return { x, y };
}

async function press(page, locator) {
  const at = await pointAt(page, locator);
  if (!at) return false;
  await page.evaluate(() => window.__pulse?.());
  await page.waitForTimeout(160);
  await locator.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(700);
  return true;
}

async function record(name, width, height, fn) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    recordVideo: { dir: out, size: { width, height } },
  });
  const page = await ctx.newPage();
  try {
    await fn(page);
  } finally {
    await page.close();
    await ctx.close();
    await browser.close();
  }
  // Playwright names the file itself; rename to something the composition can ask for.
  const made = fs.readdirSync(out).filter((f) => f.endsWith(".webm")).map((f) => ({
    f, t: fs.statSync(path.join(out, f)).mtimeMs,
  })).sort((a, b) => b.t - a.t)[0];
  if (!made) throw new Error(`no recording produced for ${name}`);
  const target = path.join(out, `${name}.webm`);
  fs.rmSync(target, { force: true });
  fs.renameSync(path.join(out, made.f), target);
  console.log(`  ${name}.webm  ${(fs.statSync(target).size / 1e6).toFixed(1)} MB`);
}

console.log("recording the live desk");

// 1. Arrival. What a judge sees, and the claims strip they read first.
await record("arrive", 1440, 900, async (page) => {
  await page.goto(DESK, { waitUntil: "load" });
  await page.waitForTimeout(7000);
  await page.addScriptTag({ content: CURSOR });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.waitForTimeout(1400);
  await page.evaluate(() => window.scrollTo({ top: 260, behavior: "smooth" }));
  await page.waitForTimeout(2200);
});

// 2. The book, and opening a live auction. The row is real: it came from the
//    enclave, and the countdown is the chain's head minus the deadline block.
await record("book", 1440, 900, async (page) => {
  await page.goto(DESK, { waitUntil: "load" });
  await page.waitForTimeout(7000);
  await page.addScriptTag({ content: CURSOR });
  await page.evaluate(() => window.scrollTo({ top: 300, behavior: "smooth" }));
  await page.waitForTimeout(1200);
  const rows = page.locator("button", { hasText: /FXRP\// });
  const n = await rows.count();
  if (n > 1) await press(page, rows.nth(1));
  await page.waitForTimeout(2600);
});

// 3. The sealing form: the preconditions list ticking, and the redaction bar
//    in the book. This is the product's whole argument on one screen.
await record("seal", 1440, 900, async (page) => {
  await page.goto(DESK, { waitUntil: "load" });
  await page.waitForTimeout(7000);
  await page.addScriptTag({ content: CURSOR });
  const rows = page.locator("button", { hasText: /FXRP\// });
  if (await rows.count()) await press(page, rows.first());
  await page.evaluate(() => window.scrollTo({ top: 420, behavior: "smooth" }));
  await page.waitForTimeout(1000);
  const field = page.locator("label", { hasText: /your bid/i }).locator("input").first();
  if (await field.count()) {
    await pointAt(page, field);
    await field.click({ timeout: 4000 }).catch(() => {});
    await field.type("130450", { delay: 110 });
    await page.waitForTimeout(1800);
  }
  await page.waitForTimeout(1200);
});

// 4. Audit. Every identifier read from the chain in this browser, which is the
//    answer to "why should I believe the page".
await record("audit", 1440, 900, async (page) => {
  await page.goto(DESK, { waitUntil: "load" });
  await page.waitForTimeout(7000);
  await page.addScriptTag({ content: CURSOR });
  const tab = page.locator("button", { hasText: /^▸? ?audit$/i }).first();
  if (await tab.count()) await press(page, tab);
  await page.waitForTimeout(3200);
});

// 5. The deck itself, advancing by keyboard.
await record("deck", 1440, 900, async (page) => {
  await page.goto(DECK, { waitUntil: "load" });
  await page.waitForTimeout(2200);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(1500);
  }
});

console.log("clips written to video/public/clips");
