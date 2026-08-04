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
console.log(`assembled: landing at /, desk at /dashboard/ (${copied} landing file(s))`);
