/**
 * Everything a replaced enclave needs, in one command.
 *
 *   npm run rotate                      # host taken from the chain, or tunnel.log
 *   npm run rotate -- https://host      # or say it
 *
 * A TEE identity is ephemeral by design, so replacing the container is routine
 * and the five steps after it are not optional:
 *
 *   1. register the new machine and pass the availability check
 *   2. point the contract at it        <- the one everybody forgets
 *   3. retire the machine it replaced  <- the one that fails silently
 *   4. put it in the documents that claim it
 *   5. check all of the above from the chain
 *
 * Missing step 2 leaves every read healthy and only settlement broken, with
 * BadTeeSignature, at the moment money should move. Missing step 3 leaves two
 * machines in the active set, so getRandomTeeIds hands out either and half the
 * instructions go to an address nobody is listening on — nothing reverts, the
 * run just dies at "no signed outcome came back". Both have happened here, more
 * than once, which is the whole argument for this file.
 *
 * Each step is skipped when the chain already says it is done, so running this
 * when nothing changed is free and safe.
 */
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flareTestnet } from "viem/chains";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXT_ID, SENDER } from "./ext-config.mjs";

const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const LOCAL = process.env.EXT_PROXY_URL ?? "http://localhost:6674";
const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const root = fileURLToPath(new URL("../", import.meta.url));

let step = 0;
const head = (m) => console.log(`\n[${++step}] ${m}`);
const say = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

const pc = createPublicClient({ chain: flareTestnet, transport: http(RPC) });
const ABI = parseAbi([
  "function getTeeMachineStatus(address) view returns (uint8)",
  "function getTeeMachine(address) view returns ((address,address,string))",
  "function getRandomTeeIds(uint256,uint256) view returns (address[])",
  "function teeAddress() view returns (address)",
  "function setTeeAddress(address)",
]);

/** The deployer key, from the same .env every other script reads. */
function deployerKey() {
  const line = fs.readFileSync(path.join(root, ".env"), "utf8")
    .split(/\r?\n/).find((l) => l.startsWith("DEPLOYMENT_PRIVATE_KEY="));
  if (!line) die("DEPLOYMENT_PRIVATE_KEY is not in .env — the rotation is an admin call");
  const k = line.slice("DEPLOYMENT_PRIVATE_KEY=".length).trim();
  return k.startsWith("0x") ? k : `0x${k}`;
}

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: root, stdio: "inherit", env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  return r.status === 0;
};

// ---- who are we serving right now -------------------------------------------
head("read the machine the proxy is serving");
const info = await fetch(`${LOCAL}/info`, { signal: AbortSignal.timeout(8000) })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
if (!info) die(`nothing answered ${LOCAL}/info — start the stack first`);
const pk = info.teeInfo?.publicKey ?? info.machineData?.publicKey;
const hex = (v) => BigInt(v).toString(16).padStart(64, "0");
const serving = `0x${keccak256(`0x${hex(pk.x)}${hex(pk.y)}`).slice(-40)}`;
say(`serving ${serving}`);

// ---- 1. registered and in production ----------------------------------------
head("register it, if the chain has never seen it");
let status = 0;
try {
  status = Number(await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getTeeMachineStatus", args: [serving] }));
} catch { status = 0; }

if (status === 2) {
  say("already PRODUCTION — nothing to register");
} else {
  // The public host the data providers will push to. Prefer what the chain
  // already publishes for a machine we run; fall back to the keeper's log.
  let host = process.argv[2];
  if (!host) {
    const log = path.join(root, "tunnel.log");
    if (fs.existsSync(log)) {
      host = (fs.readFileSync(log, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/) ?? [])[0];
    }
  }
  if (!host) die("no public host: pass one as an argument, or start scripts/tunnel-keeper.sh");
  say(`registering against ${host}`);
  const ok = run("bash", ["scripts/post-build.sh"], {
    EXT_PROXY_URL: LOCAL,
    EXT_PROXY_HOST_URL: host,
    NORMAL_PROXY_URL: process.env.NORMAL_PROXY_URL ?? "https://tee-proxy-coston2-1.flare.rocks",
    CHAIN_URL: RPC,
    ADDRESSES_FILE: "config/coston2/deployed-addresses.json",
    REGISTER_COMMAND: "rRap",
    SKIP_ALLOW_VERSION: "true",
  });
  if (!ok) die("registration failed — see the output above");
}

// ---- 2. the contract has to trust it ----------------------------------------
head("point the contract at it");
const trusted = await pc.readContract({ address: SENDER, abi: ABI, functionName: "teeAddress" });
if (trusted.toLowerCase() === serving.toLowerCase()) {
  say("the contract already trusts this machine");
} else {
  say(`contract trusts ${trusted} — rotating`);
  const account = privateKeyToAccount(deployerKey());
  const wc = createWalletClient({ account, chain: flareTestnet, transport: http(RPC) });
  const hash = await wc.writeContract({ address: SENDER, abi: ABI, functionName: "setTeeAddress", args: [serving] });
  const rcpt = await pc.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") die(`setTeeAddress reverted: ${hash}`);
  say(`rotated: ${hash}`);
}

// ---- 3. nothing else may be in the active set --------------------------------
head("retire whatever else is still active");
let active = [];
for (let n = 1n; n <= 8n; n++) {
  try {
    active = await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getRandomTeeIds", args: [EXT_ID, n] });
  } catch { break; }
}
const strays = active.filter((a) => a.toLowerCase() !== serving.toLowerCase());
if (!strays.length) say(`active set is exactly ours (${active.join(", ") || "empty"})`);
for (const s of strays) {
  say(`pausing ${s}`);
  if (!run("node", ["scripts/retire-machine.mjs", s])) die(`could not retire ${s}`);
}

// ---- 4 and 5. the documents, then the chain ----------------------------------
head("put it in the documents");
if (!run("node", ["scripts/sync-machine-address.mjs"])) die("could not update the documents");

head("check all of it from the chain");
const healthy = run("node", ["scripts/health.mjs"]);
const claims = run("node", ["scripts/verify-submission.mjs"]);
if (!healthy || !claims) die("rotation finished but the checks disagree — read the output above");

console.log("\n  rotated, registered, trusted, alone in the set, and documented.\n");
