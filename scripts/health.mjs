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

const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const EXT_ID = 65642n;
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
    problems.push(`ext-proxy is not serving ${LOCAL}/info — ${e.message}. The stack is down, or the indexer is lagging again (docker compose logs ext-proxy | grep "out of sync").`);
    return { problems, notes };
  }

  // 2. What the chain thinks our address is.
  let onChainUrl = null;
  try {
    const m = await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getTeeMachine", args: [teeId] });
    onChainUrl = m[2];
    notes.push(`on-chain url ${onChainUrl}`);
  } catch (e) {
    problems.push(`the diamond has no record of ${teeId} — ${e.message}`);
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
      problems.push(`${onChainUrl} does not answer — ${e.message}. The tunnel moved or died; the keeper should have republished. Is it still running?`);
    }
  }

  // 4. And the two reads that decide whether instructions can be processed.
  try {
    const status = Number(await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getTeeMachineStatus", args: [teeId] }));
    const names = ["NONE", "INITIALIZED", "PRODUCTION", "SUSPENDED", "PAUSED"];
    if (status !== 2) problems.push(`machine status is ${status} (${names[status] ?? "?"}), not PRODUCTION`);
    else notes.push("status PRODUCTION");
  } catch (e) {
    problems.push(`could not read machine status — ${e.message}`);
  }

  try {
    const ids = await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getRandomTeeIds", args: [EXT_ID, 1n] });
    if (!ids.length) problems.push("getRandomTeeIds returned nothing — instructions cannot be processed");
    else notes.push(`getRandomTeeIds -> ${ids[0]}`);
  } catch {
    problems.push("getRandomTeeIds reverts — no active machine for extension 65642, so postRfq, commitBid and requestClearing all revert before reaching the diamond");
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
