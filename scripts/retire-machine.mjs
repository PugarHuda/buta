/**
 * Retire a TEE machine that no longer exists.
 *
 *   node scripts/retire-machine.mjs <teeId> [--force]
 *
 * tee-node mints a fresh key at every start, so a restarted container registers
 * as a NEW machine while the old one stays PRODUCTION on-chain forever. Both
 * then sit in extensionActiveTeeIds, and getRandomTeeIds hands out either - 
 * meaning roughly half of all instructions are routed to an address nobody is
 * listening on, and the desk simply never gets a result. Nothing reverts, so
 * nothing looks broken.
 *
 * `pause(teeId)` takes it out of the active set. It refuses to pause a machine
 * that is currently answering, because that would be the mistake this exists to
 * prevent; --force overrides.
 */
import { createPublicClient, createWalletClient, http, parseAbi, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flareTestnet } from "viem/chains";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
import { EXT_ID } from "./ext-config.mjs";
const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

const target = process.argv[2];
const force = process.argv.includes("--force");
if (!target?.startsWith("0x")) {
  console.error("usage: node scripts/retire-machine.mjs <teeId> [--force]");
  process.exit(2);
}

// No path.dirname here: new URL("../") already ends in a separator, so dirname
// would climb one level too far and read .env from outside the repo.
const root = fileURLToPath(new URL("../", import.meta.url));
function envValue(file, key) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return null;
  const line = fs.readFileSync(p, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
}

const raw = process.env.DEPLOYMENT_PRIVATE_KEY ?? envValue(".env", "DEPLOYMENT_PRIVATE_KEY");
if (!raw) {
  console.error("no DEPLOYMENT_PRIVATE_KEY - set it in the environment or .env");
  process.exit(2);
}
const account = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);

const ABI = parseAbi([
  "function pause(address)",
  "function getTeeMachine(address) view returns ((address,address,string))",
  "function getTeeMachineStatus(address) view returns (uint8)",
  "function getRandomTeeIds(uint256,uint256) view returns (address[])",
]);

const pc = createPublicClient({ chain: flareTestnet, transport: http(RPC) });
const wc = createWalletClient({ account, chain: flareTestnet, transport: http(RPC) });

const status = Number(
  await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getTeeMachineStatus", args: [target] }),
);
const NAMES = ["NONE", "INITIALIZED", "PRODUCTION", "SUSPENDED", "PAUSED"];
console.log(`  ${target} is ${NAMES[status] ?? status}`);
if (status !== 2) {
  console.log("  not in production - nothing to retire");
  process.exit(0);
}

// Refuse to retire a machine that is answering. Pausing the live one is the
// exact mistake this script exists to clean up after.
const [, , url] = await pc.readContract({
  address: DIAMOND, abi: ABI, functionName: "getTeeMachine", args: [target],
});
//
// The URL answering is NOT the test. Two machines can share a hostname - after
// a restart the keeper republishes the same tunnel for the new machine, so the
// dead one's recorded URL answers perfectly while a different key is behind it.
// Derive the teeId from the public key being served and compare.
let alive = false;
try {
  const res = await fetch(`${url}/info`, { signal: AbortSignal.timeout(10_000) });
  const info = await res.json();
  const pk = info.teeInfo?.publicKey ?? info.machineData?.publicKey;
  const hex = (v) => BigInt(v).toString(16).padStart(64, "0");
  const serving = `0x${keccak256(`0x${hex(pk.x)}${hex(pk.y)}`).slice(-40)}`;
  alive = serving.toLowerCase() === target.toLowerCase();
  console.log(`  its url ${url} is serving ${serving}`);
} catch {
  console.log(`  its url ${url} does not answer`);
}
if (alive && !force) {
  console.error("  refusing: this machine is serving. Pass --force if you really mean it.");
  process.exit(1);
}

const hash = await wc.writeContract({ address: DIAMOND, abi: ABI, functionName: "pause", args: [target] });
console.log(`  pause() sent: ${hash}`);
await pc.waitForTransactionReceipt({ hash });

const after = Number(
  await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getTeeMachineStatus", args: [target] }),
);
console.log(`  now ${NAMES[after] ?? after}`);

// The point of the exercise: what the extension will actually be handed.
for (const n of [1n, 2n, 3n]) {
  try {
    const ids = await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getRandomTeeIds", args: [EXT_ID, n] });
    console.log(`  active set (${n}): ${ids.join(", ")}`);
  } catch {
    console.log(`  active set has fewer than ${n}`);
    break;
  }
}
