/**
 * Assemble one site out of two pages.
 *
 *   node scripts/assemble.mjs        (runs from `npm run build`)
 *
 * Vite builds the desk with base=/dashboard/, so its assets already resolve
 * from there — this only has to put the HTML where the URL says it is and drop
 * the landing page in at the root.
 *
 * It lives inside frontend/ because Vercel only uploads the project root: a
 * sibling directory is simply not there at build time, and the build failed
 * with ENOENT on /vercel/landing.
 *
 * The landing is COPIED, not built. It is one self-contained file with inline
 * CSS, an inline WebGL script and a data-URI favicon; running it through a
 * bundler would gain nothing and would be a new way for it to break.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
const landing = path.join(root, "landing");

if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error("no dist/index.html — run vite build first");
  process.exit(1);
}

// The desk moves to /dashboard/, and so do its assets: `base` rewrites the
// URLs in the HTML to /dashboard/assets/… but `assetsDir` is still relative to
// the output root, so leaving them behind means every script and stylesheet
// 404s and the page renders as a blank white box with a correct <title>.
fs.mkdirSync(path.join(dist, "dashboard"), { recursive: true });
fs.renameSync(path.join(dist, "index.html"), path.join(dist, "dashboard", "index.html"));
if (fs.existsSync(path.join(dist, "assets"))) {
  fs.renameSync(path.join(dist, "assets"), path.join(dist, "dashboard", "assets"));
}

// The landing takes the root. Skip the deploy metadata and dotfiles.
let copied = 0;
for (const name of fs.readdirSync(landing)) {
  if (name.startsWith(".")) continue;
  const from = path.join(landing, name);
  if (!fs.statSync(from).isFile()) continue;
  fs.copyFileSync(from, path.join(dist, name));
  copied++;
}

if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error("the landing page did not land at the root — dist/index.html is missing");
  process.exit(1);
}
/**
 * Nothing secret may leave in the bundle.
 *
 * vite loads .env.local for PRODUCTION builds as well as dev, so a key put
 * there ships to everyone who opens the site. VITE_DIRECT_API_KEY did exactly
 * that, and was one `vercel --prod` away from being public. Dev-only values
 * belong in .env.development.local, which `vite build` never reads.
 *
 * This looks for the values themselves rather than the variable names, because
 * what ends up in the bundle is the value.
 */
// BUTA_DIRECT_API_KEY is the same key under a name vite will not inline — it
// belongs to the serverless proxy in api/, and it is present in the build
// environment on Vercel, so this check can actually see it there. A rename is
// exactly the kind of thing that would quietly turn the guard off.
const secrets = ["VITE_DIRECT_API_KEY", "BUTA_DIRECT_API_KEY"];
const bundle = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(js|html|css|map)$/.test(name)) bundle.push(fs.readFileSync(p, "utf8"));
  }
})(dist);

/**
 * The value as vite would have seen it — read from the env files, not from
 * process.env.
 *
 * This script runs as its own process after `vite build`, so it inherits none
 * of what vite loaded. The first version of this check read process.env, found
 * undefined, skipped every secret, and passed a build that DID contain the key.
 * A guard that cannot see what it is guarding is worse than no guard: it
 * reports safety.
 */
function fromEnvFiles(key) {
  for (const file of [".env.local", ".env", ".env.production.local", ".env.production"]) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    const line = fs.readFileSync(p, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    const v = line?.slice(key.length + 1).trim();
    if (v) return v;
  }
  return process.env[key];
}

for (const key of secrets) {
  const value = fromEnvFiles(key);
  // A short value would match half the alphabet; only a real one is worth
  // searching for.
  if (!value || value.length < 12) continue;
  if (bundle.some((f) => f.includes(value))) {
    console.error(
      `${key} is in the built bundle. Move it to .env.development.local — ` +
        "vite reads .env.local for production builds too, and this would have been published.",
    );
    process.exit(1);
  }
}

console.log(`assembled: landing at /, desk at /dashboard/ (${copied} landing file(s))`);
