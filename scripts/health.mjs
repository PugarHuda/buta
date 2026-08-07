// health.mjs — is the machine actually reachable, right now?
//
//   node scripts/health.mjs            once, exit 0 or 1
//   node scripts/health.mjs --watch    every 60s, shout when it breaks
//
// The keeper republishes the hostname when it moves, which is fine until the
// keeper itself dies. Then nothing moves, nothing complains, and the machine is
// quietly unreachable — the failure looks exactly like everything being fine,
// because the last thing anyone saw was "machine is reachable again".
//
// Four checks, in the order a failure actually propagates. Each one names the
// component, so the answer is not "something is wrong" but "this is wrong".
import { createPublicClient, http, parseAbi, keccak256 } from "viem";
import { flareTestnet } from "viem/chains";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
// From the file pre-build.sh writes, so a redeploy cannot leave the health check
// reporting on an extension nobody serves any more.
const EXT_ID = BigInt(
  fs.readFileSync(fileURLToPath(new URL("../config/extension.env", import.meta.url)), "utf8")
    .split(/\r?\n/).find((l) => l.startsWith("EXTENSION_ID="))?.slice("EXTENSION_ID=".length).trim()
    ?? (() => { throw new Error("EXTENSION_ID missing from config/extension.env"); })(),
);
const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const LOCAL = process.env.EXT_PROXY_URL ?? "http://localhost:6674";

const watch = process.argv.includes("--watch");
const EVERY_MS = Number(process.env.HEALTH_EVERY_MS ?? 60_000);

const pc = createPublicClient({ chain: flareTestnet, transport: http(RPC) });
const ABI = parseAbi([
  "function getTeeMachine(address) view returns ((address,address,string))",
  "function getTeeMachineStatus(address) view returns (uint8)",
  "function getRandomTeeIds(uint256,uint256) view returns (address[])",
]);

const hex = (v) => BigInt(v).toString(16).padStart(64, "0");

/** viem's revert messages are twenty lines of ABI detail. Keep the first. */
const first = (e) => String(e.shortMessage ?? e.message ?? e).split("\n")[0].slice(0, 120);

async function check() {
  const problems = [];
  const notes = [];

  // 1. The proxy. Everything else is meaningless if this is down.
  let teeId = null;
  try {
    const res = await fetch(`${LOCAL}/info`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    const pk = info.teeInfo?.publicKey ?? info.machineData?.publicKey;
    if (!pk) throw new Error("no public key in /info");
    teeId = `0x${keccak256(`0x${hex(pk.x)}${hex(pk.y)}`).slice(-40)}`;
    notes.push(`proxy ok, machine ${teeId}`);
  } catch (e) {
    problems.push(`ext-proxy is not serving ${LOCAL}/info — ${first(e)}. The stack is down, or the indexer is lagging again (docker compose logs ext-proxy | grep "out of sync").`);
    return { problems, notes };
  }

  // 2. What the chain thinks our address is.
  let onChainUrl = null;
  try {
    const m = await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getTeeMachine", args: [teeId] });
    onChainUrl = m[2];
    notes.push(`on-chain url ${onChainUrl}`);
  } catch (e) {
    // There is one way this happens in practice, and it is worth naming rather
    // than making the reader deduce it from a revert. tee-node generates its
    // key at startup and never persists it, so a restarted extension-tee comes
    // back as a machine the chain has never seen — while the machine it DID
    // register stays PRODUCTION and keeps being handed out by getRandomTeeIds.
    problems.push(
      `the diamond has no record of ${teeId}. The container was almost certainly restarted: ` +
        `tee-node mints a new key every start. Re-register with ` +
        `EXT_PROXY_HOST_URL=https://<tunnel-host> ./scripts/post-build.sh  (${first(e)})`,
    );
    return { problems, notes };
  }

  // 3. Is that address actually answering? This is the check the keeper exists
  //    to keep true, and therefore the one that goes stale when it dies.
  if (!/^https:\/\//.test(onChainUrl)) {
    problems.push(`the url on-chain is ${onChainUrl}, which no data provider can reach. Run scripts/update-machine-url.mjs, or start scripts/tunnel-keeper.sh.`);
  } else {
    try {
      const res = await fetch(`${onChainUrl}/info`, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      notes.push("the published url answers");
    } catch (e) {
      problems.push(`${onChainUrl} does not answer — ${first(e)}. The tunnel moved or died; the keeper should have republished. Is it still running?`);
    }
  }

  // 4. And the two reads that decide whether instructions can be processed.
  try {
    const status = Number(await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getTeeMachineStatus", args: [teeId] }));
    const names = ["NONE", "INITIALIZED", "PRODUCTION", "SUSPENDED", "PAUSED"];
    if (status !== 2) problems.push(`machine status is ${status} (${names[status] ?? "?"}), not PRODUCTION`);
    else notes.push("status PRODUCTION");
  } catch (e) {
    problems.push(`could not read machine status — ${first(e)}`);
  }

  // The whole active set, not one draw. A restarted container leaves its old
  // machine PRODUCTION forever, so the set grows and getRandomTeeIds hands out
  // either — half the instructions go to an address nobody is listening on.
  // Nothing reverts, so a single draw can look perfect while half the traffic
  // vanishes. This missed it once: it drew the live machine and said healthy
  // while the dead one was still in the set.
  try {
    let active = [];
    for (let n = 1n; n <= 8n; n++) {
      try {
        active = await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getRandomTeeIds", args: [EXT_ID, n] });
      } catch {
        break; // asked for more than the set holds
      }
    }
    if (!active.length) {
      problems.push("getRandomTeeIds returned nothing — instructions cannot be processed");
    } else {
      const strays = active.filter((a) => a.toLowerCase() !== teeId.toLowerCase());
      if (strays.length) {
        problems.push(
          `${active.length} machine(s) active for extension ${EXT_ID}; ${strays.length} of them ` +
            `is not the one we are serving (${strays.join(", ")}). getRandomTeeIds hands out either, so ` +
            `roughly ${Math.round((strays.length / active.length) * 100)}% of instructions go nowhere. ` +
            `Retire it: node scripts/retire-machine.mjs ${strays[0]}`,
        );
      } else {
        notes.push(`getRandomTeeIds -> ${active.join(", ")} (only ours)`);
      }
    }
  } catch {
    problems.push("getRandomTeeIds reverts — no active machine for the extension, so postRfq, commitBid and requestClearing all revert before reaching the diamond");
  }

  return { problems, notes };
}

async function once() {
  const { problems, notes } = await check();
  const stamp = new Date().toISOString().slice(11, 19);
  if (!problems.length) {
    console.log(`[${stamp}] healthy — ${notes.join("; ")}`);
    return true;
  }
  // Loud on purpose. A health check nobody notices failing is a health check
  // that does not exist.
  console.error(`\n[${stamp}] ===== UNHEALTHY =====`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  if (notes.length) console.error(`  (working: ${notes.join("; ")})`);
  console.error("");
  return false;
}

if (!watch) {
  process.exit((await once()) ? 0 : 1);
}

let wasHealthy = null;
for (;;) {
  const ok = await once();
  // Only announce transitions in watch mode; a line a minute trains people to
  // ignore the line.
  if (wasHealthy === true && !ok) console.error("  ^ this is a change. It was healthy a minute ago.");
  if (wasHealthy === false && ok) console.log("  ^ recovered.");
  wasHealthy = ok;
  await new Promise((r) => setTimeout(r, EVERY_MS));
}
