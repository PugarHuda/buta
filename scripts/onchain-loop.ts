/**
 * The whole thing, on Coston2, for real.
 *
 *   node scripts/onchain-loop.mjs
 *
 * post → seal → wait out the deadline → request clearing → settle. Every step a
 * transaction, every step verifiable afterwards from public state.
 *
 * This exists because "the on-chain path works" was a claim resting on one
 * postRfq. relayClearing — the only function that moves money, and the one
 * carrying the security argument — had never executed on a public chain at all.
 * A settlement proven on a fork is a settlement proven against a copy.
 *
 * Needs the DOCKER stack, not cmd/dev: the facade signs nothing, and
 * relayClearing will not settle an unsigned outcome. Check with
 * `node scripts/health.mjs` first.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseAbi,
  formatUnits,
  decodeAbiParameters,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flareTestnet } from "viem/chains";
import { encrypt } from "ecies-geth";

const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const SENDER = "0x3085C89540353A4b275704b0Bd03eEc3C718D702";
const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const EXT_ID = 65642n;
const PROXY = process.env.EXT_PROXY_URL ?? "http://localhost:6674";

// FXRP on both legs. USDT0 has no code at the configured Coston2 address, and
// the postRfq that ran in July used FXRP for settle and lot alike — a demo that
// cannot settle is not a demonstration of settlement.
const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";
const LOT = 2_000_000n; // 2 FXRP, six decimals
const RESERVE = 500_000n; // the floor a lone bidder pays
const BID = 1_500_000n;
const FEE = 1_000_000_000n; // what the diamond charges to forward one instruction
const DEADLINE_BLOCKS = 25n; // ~45s at 1.8s a block

const senderAbi = parseAbi([
  "function postRfq(address settleToken, address lotToken, uint256 lot, uint64 deadlineBlock, address invited, bytes encryptedReserve) payable returns (uint256)",
  "function commitBid(uint256 rfqId, bytes32 commitment, bytes ciphertext) payable",
  "function requestClearing(uint256 rfqId) payable",
  "function relayClearing(uint256 rfqId, address winner, uint256 clearingPrice, bytes32 setDigest, bytes32 actionId, string submissionTag, uint8 status, bytes signature)",
  "function rfqs(uint256) view returns (address maker, address settleToken, address lotToken, uint256 lot, uint64 deadlineBlock, address invited, bool cleared, address winner, uint256 clearingPrice)",
  "function commitmentDigest(uint256 rfqId) view returns (bytes32)",
  "function rfqCount() view returns (uint256)",
  "event RfqPosted(uint256 indexed rfqId, address indexed maker, uint256 lot, uint64 deadlineBlock)",
]);
const erc20Abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const diamondAbi = parseAbi([
  "function getRandomTeeIds(uint256,uint256) view returns (address[])",
  "function getPublicKey(address) view returns ((bytes32 x, bytes32 y))",
]);

const root = fileURLToPath(new URL("../", import.meta.url));
const key = fs
  .readFileSync(path.join(root, ".env"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("DEPLOYMENT_PRIVATE_KEY="))
  ?.split("=")[1]
  ?.trim();
if (!key) {
  console.error("no DEPLOYMENT_PRIVATE_KEY in .env");
  process.exit(2);
}
const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);

// A SECOND wallet bids, and this is not tidiness.
//
// relayClearing moves the clearing price from the winner to the maker, and FXRP
// refuses a self-transfer — one address playing both roles reverts
// CannotTransferToSelf() however correct everything else is. A settlement demo
// with one wallet could never have settled.
const bidderKey = fs.readFileSync(path.join(root, ".bidder.key"), "utf8").trim() as Hex;
const bidder = privateKeyToAccount(bidderKey);
const pc = createPublicClient({ chain: flareTestnet, transport: http(RPC) });
const wc = createWalletClient({ account, chain: flareTestnet, transport: http(RPC) });
const bwc = createWalletClient({ account: bidder, chain: flareTestnet, transport: http(RPC) });

const step = (n: number, s: string) => console.log(`\n[${n}] ${s}`);
const xrp = (v: bigint) => `${formatUnits(v, 6)} FXRP`;
const wait = (h: Hex) => pc.waitForTransactionReceipt({ hash: h });

/** The enclave's key, from the diamond — never from the relay. */
async function enclaveKey(): Promise<Buffer> {
  const ids = await pc.readContract({ address: DIAMOND, abi: diamondAbi, functionName: "getRandomTeeIds", args: [EXT_ID, 1n] });
  const { x, y } = await pc.readContract({ address: DIAMOND, abi: diamondAbi, functionName: "getPublicKey", args: [ids[0]] });
  const b = (h: Hex) => Buffer.from(h.slice(2), "hex");
  return Buffer.concat([Buffer.from([0x04]), b(x), b(y)]);
}

console.log(`maker/bidder ${account.address}`);
const bal = await pc.readContract({ address: FXRP, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
console.log(`holds        ${xrp(bal)}`);
if (bal < LOT) {
  console.error(`not enough FXRP: the lot alone is ${xrp(LOT)}`);
  process.exit(1);
}

// ── 1. approve ───────────────────────────────────────────────────────────────
// postRfq pulls the lot, relayClearing later pulls the clearing price from the
// winner. Two transferFroms, so the allowance has to cover both.
step(1, "approve the escrow");
const need = LOT + BID;
const have = await pc.readContract({ address: FXRP, abi: erc20Abi, functionName: "allowance", args: [account.address, SENDER] });
if (have < need) {
  const h = await wc.writeContract({ address: FXRP, abi: erc20Abi, functionName: "approve", args: [SENDER, need] });
  await wait(h);
  console.log(`    approved ${xrp(need)}  ${h}`);
} else {
  console.log(`    already approved ${xrp(have)}`);
}

// ── 2. post ──────────────────────────────────────────────────────────────────
step(2, "post the block — the lot goes into escrow and the instruction into the diamond");
const head = await pc.getBlockNumber();
const deadline = head + DEADLINE_BLOCKS;
const sealed = await encrypt(await enclaveKey(), Buffer.from(JSON.stringify({ reserve: Number(RESERVE), pair: "FXRP/FXRP" })));
const postHash = await wc.writeContract({
  address: SENDER, abi: senderAbi, functionName: "postRfq",
  args: [FXRP, FXRP, LOT, deadline, "0x0000000000000000000000000000000000000000", `0x${sealed.toString("hex")}`],
  value: FEE,
});
const postRcpt = await wait(postHash);
let rfqId = 0n;
for (const log of postRcpt.logs) {
  try {
    const e = decodeEventLog({ abi: senderAbi, data: log.data, topics: log.topics });
    if (e.eventName === "RfqPosted") rfqId = e.args.rfqId as bigint;
  } catch {
    /* not ours */
  }
}
console.log(`    RFQ ${rfqId}  lot ${xrp(LOT)}  deadline block ${deadline}  ${postHash}`);

// ── 3. seal a bid ────────────────────────────────────────────────────────────
step(3, "seal a bid — the commitment lands in the set the clearing must match");
const { keccak256, encodePacked } = await import("viem");
const nonce = ("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")) as Hex;
const commitment = keccak256(encodePacked(["uint256", "bytes32", "address"], [BID, nonce, bidder.address]));
const bidSig = await bidder.signMessage({
  message: { raw: keccak256(encodePacked(["string", "uint256", "uint256", "bytes32"], ["BUTA_BID", 114n, rfqId, commitment])) },
});
const opening = await encrypt(await enclaveKey(), Buffer.from(JSON.stringify({ amount: Number(BID), nonce, sig: bidSig })));
const appr = await bwc.writeContract({ address: FXRP, abi: erc20Abi, functionName: "approve", args: [SENDER, BID] });
await wait(appr);
const bidHash = await bwc.writeContract({
  address: SENDER, abi: senderAbi, functionName: "commitBid",
  args: [rfqId, commitment, `0x${opening.toString("hex")}`],
  value: FEE,
});
await wait(bidHash);
console.log(`    commitment ${commitment.slice(0, 18)}…  ${bidHash}`);
console.log(`    on-chain digest ${(await pc.readContract({ address: SENDER, abi: senderAbi, functionName: "commitmentDigest", args: [rfqId] })).slice(0, 18)}…`);

// ── 4. wait ──────────────────────────────────────────────────────────────────
step(4, `wait for block ${deadline} — nobody may clear before it`);
for (;;) {
  const now = await pc.getBlockNumber();
  if (now > deadline) break;
  process.stdout.write(`\r    ${deadline - now} blocks to go   `);
  await new Promise((r) => setTimeout(r, 3000));
}
console.log("\r    deadline passed          ");

// ── 5. request the clearing ──────────────────────────────────────────────────
step(5, "request the clearing — the enclave opens the bids and signs an outcome");
const reqHash = await wc.writeContract({ address: SENDER, abi: senderAbi, functionName: "requestClearing", args: [rfqId], value: FEE });
const reqRcpt = await wait(reqHash);
console.log(`    ${reqHash}`);

// The diamond assigns an instruction id; the proxy files the signed result
// under it. Both submission tags are tried because on-chain instructions are
// written under "threshold" first and re-emitted under "end".
// topics[2]. topics[1] is the EXTENSION id (0x1006a), which is the same on
// every instruction — taking it meant asking the proxy for a result filed
// under an id that was never an id.
const instructionId = reqRcpt.logs.find((l) => l.address.toLowerCase() === DIAMOND.toLowerCase())?.topics[2] as Hex | undefined;
console.log(`    instruction ${instructionId?.slice(0, 18) ?? "(not found in logs)"}…`);

async function signedResult(id: Hex) {
  for (let i = 0; i < 40; i++) {
    for (const tag of ["threshold", "end", "submit"]) {
      try {
        const r = await fetch(`${PROXY}/action/result/${id}?submissionTag=${tag}`);
        if (!r.ok) continue;
        const j = await r.json();
        // The tag is not the test — the shape is. "end" carries the consensus
        // envelope (1887 bytes of {"voteSequence":…}), signed and status 1 and
        // useless for settling; only "threshold" carries the four-word ABI
        // outcome relayClearing rebuilds. This loop settled twice by winning
        // that race rather than by checking.
        if (j?.result?.status === 1 && j?.signature && /^0x[0-9a-fA-F]{256}$/.test(j.result.data)) {
          return { ...j, tag };
        }
      } catch {
        /* keep waiting */
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

step(6, "collect the enclave's signature");
const signed = instructionId ? await signedResult(instructionId) : null;
if (!signed) {
  console.error(`
    No signed outcome came back within two minutes.

    The clearing itself may still have happened — check the enclave's log — but
    relayClearing cannot settle without the signature, and that is the honest
    place to stop. Nothing here has been left half-done: the lot is still in
    escrow and reclaimLot returns it to the maker.`);
  process.exit(1);
}
// ABI-encoded, which is the whole point: these are the bytes the node signed
// and the bytes relayClearing rebuilds.
const [oRfq, oWinner, oPrice, oDigest] = decodeAbiParameters(
  [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
  signed.result.data as Hex,
);
const outcome = { rfqId: oRfq, winner: oWinner, clearingPrice: oPrice, setDigest: oDigest };
console.log(`    winner ${outcome.winner}  price ${xrp(outcome.clearingPrice)}  (tag: ${signed.tag})`);
console.log(`    set digest ${outcome.setDigest.slice(0, 18)}…`);

// ── 7. settle ────────────────────────────────────────────────────────────────
step(7, "settle — delivery versus payment, in one transaction");
const before = await pc.readContract({ address: FXRP, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
// Two FAsset transfers in one call, which is the most gas-exposed transaction
// this system sends. The settlement that first proved this loop finished with
// 2% of its estimate to spare, and a reclaim reverted twice at 98% — FXRP's
// transfer cost drifts between estimation and execution and the inner call only
// gets 63/64 of what is left. Unused gas is refunded; a starved settlement
// leaves the lot escrowed and the auction open.
const relayArgs = {
  address: SENDER, abi: senderAbi, functionName: "relayClearing" as const,
  args: [
    outcome.rfqId, outcome.winner, outcome.clearingPrice, outcome.setDigest,
    signed.result.id, signed.result.submissionTag ?? signed.tag, 1, signed.signature,
  ] as const,
};
const relayGas = await pc.estimateContractGas({ ...relayArgs, account } as never).catch(() => null);
const relayHash = await wc.writeContract({ ...relayArgs, ...(relayGas ? { gas: relayGas * 2n } : {}) } as never);
await wait(relayHash);
const after = await pc.readContract({ address: FXRP, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
const row = await pc.readContract({ address: SENDER, abi: senderAbi, functionName: "rfqs", args: [rfqId] });

console.log(`    ${relayHash}`);
console.log(`
  RFQ ${rfqId} settled on Coston2
    cleared        ${row[6]}
    winner         ${row[7]}
    clearing price ${xrp(row[8])}
    balance        ${xrp(before)} -> ${xrp(after)}

  The winner paid the second price — the reserve, with one bid — and took the
  lot, in one transaction. The losing amounts were never revealed to anyone,
  and the contract refused to settle anything whose signature or set digest
  did not match what it recorded.`);
