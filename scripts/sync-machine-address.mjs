/**
 * Put the machine that is actually serving into the documents that claim it.
 *
 *   node scripts/sync-machine-address.mjs           rewrite
 *   node scripts/sync-machine-address.mjs --check   fail if they disagree
 *
 * A TEE identity is ephemeral by design, so every replaced container makes the
 * address in SUBMISSION.md and DORAHACKS_FORM.md wrong. That has now happened
 * four times in one day, and each time the fix was a hand-edit in two files plus
 * a short form in a third place - which is exactly the kind of step that gets
 * skipped at 2am before a deadline, leaving a submission that cites a machine
 * the chain has paused.
 *
 * The address is not invented here: it is derived from the public key the proxy
 * is serving right now, the same way health.mjs derives it, and then checked
 * against the chain before anything is written. A document is not updated to
 * point at a machine that is not in production.
 */
import { createPublicClient, http, parseAbi, keccak256, encodePacked } from "viem";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const LOCAL = process.env.EXT_PROXY_URL ?? "http://localhost:6674";
const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const check = process.argv.includes("--check");

const DOCS = ["../SUBMISSION.md", "../submission/DORAHACKS_FORM.md"];

const info = await fetch(`${LOCAL}/info`, { signal: AbortSignal.timeout(8000) })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
if (!info) {
  console.error(`no answer from ${LOCAL}/info - start the stack, or the address cannot be derived from anything trustworthy`);
  process.exit(2);
}
const pk = info.teeInfo?.publicKey ?? info.machineData?.publicKey;
const hex = (v) => BigInt(v).toString(16).padStart(64, "0");
const serving = `0x${keccak256(`0x${hex(pk.x)}${hex(pk.y)}`).slice(-40)}`;

// Checksummed, because that is the form the documents use and a lowercase
// address in a table reads like a different one.
const pc = createPublicClient({ transport: http(RPC) });
const ABI = parseAbi([
  "function getTeeMachineStatus(address) view returns (uint8)",
  "function getTeeMachine(address) view returns ((address,address,string))",
]);
const status = Number(
  await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getTeeMachineStatus", args: [serving] }),
);
if (status !== 2) {
  console.error(`the machine being served (${serving}) is status ${status}, not PRODUCTION - register it before citing it`);
  process.exit(1);
}
const [id] = await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getTeeMachine", args: [serving] });

const short = (a) => `${a.slice(0, 10)}…${a.slice(-4)}`;
let changed = 0;
const stale = [];

for (const rel of DOCS) {
  const path = fileURLToPath(new URL(rel, import.meta.url));
  const before = fs.readFileSync(path, "utf8");

  // Anchored on the two forms the documents use - the evidence row's full
  // address and the form's 0x1234…abcd short one - because a bare 40-hex string
  // is indistinguishable from the contract, a token, or the deployer, and a
  // blind sweep would rewrite all of them.
  const rowRe = /(\*\*TEE machine in PRODUCTION\*\* \| \[?`)(0x[0-9a-fA-F]{40})(`)/;
  const shortRe = /(TEE machine `)(0x[0-9a-fA-F]{8}…[0-9a-fA-F]{4})(`)/;
  // And the prose, which names it a third time. Anchored on the call rather than
  // on the address: a short form cannot be looked up on-chain to find out
  // whether it is a retired machine or something else entirely.
  const proseRe = /(getRandomTeeIds\([^)]*\)`? returns `)(0x[0-9a-fA-F]{8}…[0-9a-fA-F]{4})(`)/;
  const wasRow = before.match(rowRe)?.[2];
  const wasShort = before.match(shortRe)?.[2];
  const wasProse = before.match(proseRe)?.[2];

  let next = before
    .replace(rowRe, (_, a, __, c) => `${a}${id}${c}`)
    .replace(shortRe, (_, a, __, c) => `${a}${short(id)}${c}`)
    .replace(proseRe, (_, a, __, c) => `${a}${short(id)}${c}`);
  if (wasProse && wasProse !== short(id)) stale.push(`${rel}: ${wasProse}`);

  // The explorer link beside it names the same address, so it moves too.
  if (wasRow && wasRow.toLowerCase() !== id.toLowerCase()) {
    next = next.split(wasRow).join(id);
    stale.push(`${rel}: ${wasRow}`);
  }
  if (wasShort && wasShort !== short(id)) stale.push(`${rel}: ${wasShort}`);

  if (next !== before) {
    if (!check) fs.writeFileSync(path, next);
    changed++;
  }
}

if (check) {
  if (changed) {
    console.error(`the documents cite a machine that is not the one serving (${id}):`);
    for (const s of stale) console.error(`  ${s}`);
    process.exit(1);
  }
  console.log(`documents agree with the machine in production: ${id}`);
} else {
  console.log(changed ? `updated ${changed} document(s) to ${id}` : `already up to date: ${id}`);
}
