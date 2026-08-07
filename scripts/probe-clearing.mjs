/**
 * Ask the contract to clear an auction and print what comes back, verbatim.
 *
 *   node scripts/probe-clearing.mjs 10
 *
 * The desk and scripts/onchain-loop.ts run the same three steps — requestClearing,
 * pull the instruction id out of the diamond's log, poll the proxy for a signed
 * result — and get different answers. The loop settles; the desk decodes an
 * rfqId of 5569537058682514101…, which is a 32-byte word starting 0x7b, which is
 * `{`. That is JSON being read as a uint256.
 *
 * This narrows it to one of two things and does not guess between them: either
 * the enclave signs JSON for this instruction, or the id being asked about is
 * not this instruction's.
 */
import { EXT_ID } from "./ext-config.mjs";
import { createPublicClient, createWalletClient, decodeAbiParameters, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flareTestnet } from "viem/chains";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const PROXY = process.env.PROXY ?? "http://127.0.0.1:6674";
const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const FEE = 1_000_000_000n;

const rfqId = BigInt(process.argv[2] ?? 0);
if (!rfqId) {
  console.error("usage: node scripts/probe-clearing.mjs <rfqId>");
  process.exit(2);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const line = fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
  .find((l) => l.startsWith("DEPLOYMENT_PRIVATE_KEY="));
const raw = line?.slice("DEPLOYMENT_PRIVATE_KEY=".length).trim();
const account = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);

const ABI = parseAbi([
  "function requestClearing(uint256 rfqId) payable",
  "function getTeeExtensionInstructionsSender(uint256) view returns (address)",
]);
const pc = createPublicClient({ chain: flareTestnet, transport: http(RPC) });
const wc = createWalletClient({ account, chain: flareTestnet, transport: http(RPC) });
const SENDER = await pc.readContract({
  address: DIAMOND, abi: ABI, functionName: "getTeeExtensionInstructionsSender", args: [EXT_ID],
});

const hash = await wc.writeContract({
  address: SENDER, abi: ABI, functionName: "requestClearing", args: [rfqId], value: FEE,
});
console.log(`requestClearing(${rfqId})  ${hash}`);
const rcpt = await pc.waitForTransactionReceipt({ hash });

// Every diamond log, not just the first — if the id is being taken from the
// wrong one, that shows up here and nowhere else.
console.log(`\ndiamond logs in this receipt:`);
for (const l of rcpt.logs) {
  if (l.address.toLowerCase() !== DIAMOND.toLowerCase()) continue;
  console.log(`  topics: ${l.topics.map((t) => `${t.slice(0, 18)}…`).join("  ")}`);
}
const id = rcpt.logs.find((l) => l.address.toLowerCase() === DIAMOND.toLowerCase())?.topics[2];
console.log(`\nthe id the desk would use (topic 2 of the first): ${id}`);

for (let i = 0; i < 60; i++) {
  for (const tag of ["threshold", "end", "submit"]) {
    const r = await fetch(`${PROXY}/action/result/${id}?submissionTag=${tag}`).catch(() => null);
    if (!r?.ok) continue;
    const j = await r.json();
    if (j?.result?.status !== 1 || !j?.signature) continue;
    const data = j.result.data;
    console.log(`\ntag ${tag}: ${data.length} chars of data, ${(data.length - 2) / 2} bytes`);
    // 128 bytes is the four-word ABI encoding relayClearing rebuilds. Anything
    // else is a different shape, and printing it as text says which.
    console.log(`as text : ${Buffer.from(data.slice(2), "hex").toString("utf8").slice(0, 160)}`);
    try {
      const d = decodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
        data,
      );
      console.log(`as abi  : rfqId ${d[0]}  winner ${d[1]}  price ${d[2]}`);
    } catch (e) {
      console.log(`as abi  : will not decode — ${String(e.shortMessage ?? e.message).split("\n")[0]}`);
    }
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log("\nnothing signed came back");
process.exit(1);
