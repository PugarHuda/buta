/**
 * Check every on-chain claim SUBMISSION.md makes, against Coston2.
 *
 *   node scripts/verify-submission.mjs
 *
 * The submission is the document judges read, and every hard fact in it is a
 * public read. It also goes stale silently: the TEE machine address in it was
 * correct for three days and then wrong within an hour of a container restart,
 * and nothing would have said so.
 *
 * This does not parse prose. It pulls the specific identifiers out of the
 * markdown — contract, machine, extension id, transaction hashes — and asks the
 * chain whether each claim still holds. A claim that cannot be checked from a
 * public RPC does not belong in the table.
 */
import { createPublicClient, http, parseAbi } from "viem";
import { flareTestnet } from "viem/chains";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const EXT_ID = 65642n;

const doc = fileURLToPath(new URL("../SUBMISSION.md", import.meta.url));
const md = fs.readFileSync(doc, "utf8");

const pc = createPublicClient({ chain: flareTestnet, transport: http(RPC) });
const ABI = parseAbi([
  "function getTeeExtensionInstructionsSender(uint256) view returns (address)",
  "function getTeeMachineStatus(address) view returns (uint8)",
  "function getRandomTeeIds(uint256,uint256) view returns (address[])",
  "function teeAddressSet() view returns (bool)",
  "function rfqCount() view returns (uint256)",
]);

const failures = [];
let checks = 0;
const check = (name, ok, detail = "") => {
  checks++;
  if (ok) console.log(`  ok    ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

/** The one full-length address in the doc that is not the diamond or a token. */
function claimed(re, what) {
  const m = md.match(re);
  if (!m) {
    check(`SUBMISSION.md still states ${what}`, false, "the claim is gone from the document");
    return null;
  }
  return m[1];
}

// ---- the contract -----------------------------------------------------------
const sender = claimed(/`(0x20d9[0-9a-fA-F]{36})`/, "the instruction sender address");
if (sender) {
  const code = await pc.getCode({ address: sender });
  check("the instruction sender is deployed", !!code && code !== "0x", "no code at that address");

  const registered = await pc.readContract({
    address: DIAMOND, abi: ABI, functionName: "getTeeExtensionInstructionsSender", args: [EXT_ID],
  });
  check(
    `the diamond returns it for extension ${EXT_ID}`,
    registered.toLowerCase() === sender.toLowerCase(),
    `diamond says ${registered}`,
  );

  const bound = await pc.readContract({ address: sender, abi: ABI, functionName: "teeAddressSet" });
  check("teeAddressSet reads true", bound === true);

  // "rfqCount 0 -> 1" is the claim that postRfq really executed. It can only
  // grow, so anything below 1 means the claim was never true.
  const n = await pc.readContract({ address: sender, abi: ABI, functionName: "rfqCount" });
  check("rfqCount is at least 1, as the postRfq claim requires", n >= 1n, `rfqCount = ${n}`);
}

// ---- the TEE machine --------------------------------------------------------
const machine = claimed(/\*\*TEE machine in PRODUCTION\*\* \| `(0x[0-9a-fA-F]{40})`/, "a TEE machine in production");
if (machine) {
  const status = Number(
    await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getTeeMachineStatus", args: [machine] }),
  );
  check("that machine is PRODUCTION", status === 2, `status ${status}`);

  // The whole active set, not one draw — see health.mjs. A stale machine left
  // active is invisible to a single read and eats half the instructions.
  let active = [];
  for (let n = 1n; n <= 8n; n++) {
    try {
      active = await pc.readContract({ address: DIAMOND, abi: ABI, functionName: "getRandomTeeIds", args: [EXT_ID, n] });
    } catch {
      break;
    }
  }
  check(
    "it is the only machine getRandomTeeIds can return",
    active.length === 1 && active[0].toLowerCase() === machine.toLowerCase(),
    `active set: ${active.join(", ") || "empty"}`,
  );
}

// ---- the transactions it cites ----------------------------------------------
for (const [label, re] of [
  ["the postRfq transaction", /\*\*`postRfq` executed on-chain\*\* \| tx \[`(0x[0-9a-f]{64})`\]/],
  ["the updateTeeMachineSettings transaction", /updateTeeMachineSettings.*?`(0x[0-9a-f]{64})`/],
]) {
  const hash = claimed(re, label);
  if (!hash) continue;
  try {
    const r = await pc.getTransactionReceipt({ hash });
    check(`${label} succeeded`, r.status === "success", `status ${r.status}`);
  } catch (e) {
    check(`${label} exists on Coston2`, false, String(e.shortMessage ?? e.message).split("\n")[0]);
  }
}

console.log(`\n${checks} claims checked, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
