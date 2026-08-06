/**
 * Put the deployed desk on the same origin as the enclave.
 *
 *   node scripts/point-desk-at-machine.mjs https://buta-tee.ngrok-free.app
 *   node scripts/point-desk-at-machine.mjs --clear
 *
 * The extension proxy sends no Access-Control-Allow-Origin header, so a browser
 * cannot fetch it cross-origin at all. Baking the machine's URL into the bundle
 * therefore does nothing: /info, /direct and the signed-clearing poll are all
 * blocked before they leave the page, the desk quietly falls back to the demo
 * book, and every script keeps working because node has no CORS to enforce.
 *
 * In dev, vite's server.proxy already solves this — the desk fetches relative
 * paths and vite forwards them. This is the same trick for production: Vercel
 * rewrites are server-side, so /info on the desk's own origin is served from the
 * machine with no preflight and no header to add on the enclave.
 *
 * Run it whenever the machine's hostname changes. With a static ngrok domain,
 * that should be never.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const CONFIG = fileURLToPath(new URL("../frontend/vercel.json", import.meta.url));
/** Exactly the paths vite proxies in dev — see frontend/vite.config.ts. */
const PATHS = ["/info", "/direct", "/state", "/action"];
/** Ours are identified by their source, not by a marker key — vercel.json is
 *  schema-validated and an unknown property in a rewrite is a deploy error. */
const ours = (r) => PATHS.some((p) => r.source === p || r.source === `${p}/:path*`);

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/point-desk-at-machine.mjs <https://host> | --clear");
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
config.rewrites = (config.rewrites ?? []).filter((r) => !ours(r));

if (arg !== "--clear") {
  let host;
  try {
    host = new URL(arg);
  } catch {
    console.error(`${arg} is not a URL`);
    process.exit(2);
  }
  if (host.protocol !== "https:") {
    // The desk is served over https, and a browser will not let it fetch http.
    console.error("the machine has to be on https — a page on https cannot fetch http");
    process.exit(2);
  }
  const base = arg.replace(/\/$/, "");

  // Fail here rather than after a deploy that silently serves nothing.
  const alive = await fetch(`${base}/info`).then((r) => r.ok).catch(() => false);
  if (!alive) {
    console.error(`${base}/info does not answer — publish the machine first`);
    process.exit(1);
  }

  // Rewrites are matched in order and the /dashboard one has to keep winning
  // for its own paths, so these go after it.
  for (const p of PATHS) {
    config.rewrites.push({ source: `${p}/:path*`, destination: `${base}${p}/:path*` });
    config.rewrites.push({ source: p, destination: `${base}${p}` });
  }
  console.log(`the desk will reach the enclave at ${base}, on its own origin`);
} else {
  console.log("machine rewrites removed — the desk falls back to the demo book");
}

fs.writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote ${CONFIG}`);
console.log("deploy for it to take effect:  cd frontend && npx vercel --prod");
