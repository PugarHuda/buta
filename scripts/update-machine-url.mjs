// update-machine-url.mjs — point the registered TEE machine at a new host URL.
//
//   node scripts/update-machine-url.mjs https://your-host
//
// Why this exists.
//
// Data providers push the availability check to the URL stored on-chain. Once a
// machine is registered, re-running post-build.sh does NOT change that URL:
// RegisterNode sees the machine already exists, skips PreRegistration — which is
// the only thing that writes the URL — and goes straight to requesting a fresh
// attestation. So "update EXT_PROXY_URL and re-run post-build", which is the
// advice in circulation, cannot work for a machine that is already registered.
// The check keeps being sent to the old hostname and keeps coming back 404.
//
// MachineManagerFacet.updateTeeMachineSettings is the function that does work.
// It is owner-only, and it also rewrites the proxy id — which matters here,
// because changing PROXY_PRIVATE_KEY (as we did, to stop sharing the scaffold's
// published devnet key) changes the proxy identity the check is verified against.
//
// Calling it on a PRODUCTION machine drops it to PAUSED, by design. On an
// INITIALIZED one there is nothing to lose.
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flareTestnet } from "viem/chains";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) {
  console.error(`
  usage: node scripts/update-machine-url.mjs <https://host>

  The host has to be one that survives a restart. Data providers push to
  whatever is written on-chain, so a hostname that changes leaves the machine
  unreachable — which is what INITIALIZED with a dead URL means.
`);
  process.exit(2);
}

/** Reads the gitignored deployer env rather than taking a key on the command line. */
function env(file) {
  const p = fileURLToPath(new URL(`../${file}`, import.meta.url));
  const out = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const deployer = env(".env.deployer");
const stack = env(".env");
const key = deployer.DEPLOYER_PRIVATE_KEY?.startsWith("0x")
  ? deployer.DEPLOYER_PRIVATE_KEY
  : `0x${deployer.DEPLOYER_PRIVATE_KEY}`;
const account = privateKeyToAccount(key);

// The proxy id is the address of PROXY_PRIVATE_KEY — the identity the
// availability check is verified against, so it has to be the key the proxy is
// actually running with.
const proxyKey = stack.PROXY_PRIVATE_KEY?.startsWith("0x")
  ? stack.PROXY_PRIVATE_KEY
  : `0x${stack.PROXY_PRIVATE_KEY}`;
const proxyId = privateKeyToAccount(proxyKey).address;

const ABI = parseAbi([
  "function updateTeeMachineSettings(address,address,string)",
  "function getTeeMachine(address) view returns ((address,address,string))",
  "function getTeeMachineStatus(address) view returns (uint8)",
]);

const pc = createPublicClient({ chain: flareTestnet, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: flareTestnet, transport: http(RPC) });

// The tee id is derived from the running node's public key, so read it rather
// than hard-code it — a rebuilt node is a different machine.
const info = await (await fetch(process.env.EXT_PROXY_URL ?? "http://localhost:6674/info")).json();
const pk = info.teeInfo?.publicKey ?? info.machineData?.publicKey;
if (!pk) throw new Error("the proxy did not return a public key — is the stack up?");
const { keccak256 } = await import("viem");
const hex = (v) => BigInt(v).toString(16).padStart(64, "0");
const teeId = `0x${keccak256(`0x${hex(pk.x)}${hex(pk.y)}`).slice(-40)}`;

const before = await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getTeeMachine", args: [teeId] });
console.log(`  machine   ${teeId}`);
console.log(`  proxy id  ${before[1]}  ->  ${proxyId}`);
console.log(`  host url  ${before[2]}  ->  ${url}`);

if (before[2] === url && before[1].toLowerCase() === proxyId.toLowerCase()) {
  console.log("\n  already set, nothing to do\n");
  process.exit(0);
}

const hash = await wallet.writeContract({
  address: DIAMOND,
  abi: ABI,
  functionName: "updateTeeMachineSettings",
  args: [teeId, proxyId, url],
});
console.log(`\n  tx ${hash}`);
await pc.waitForTransactionReceipt({ hash });

const after = await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getTeeMachine", args: [teeId] });
const status = await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getTeeMachineStatus", args: [teeId] });
console.log(`  host url now ${after[2]}`);
console.log(`  status ${status} (1 = INITIALIZED, 2 = PRODUCTION)\n`);
console.log("  now re-run the availability check:");
console.log("    REGISTER_COMMAND=ap ./scripts/post-build.sh\n");
