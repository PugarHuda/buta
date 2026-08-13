/**
 * Put a live auction on the public desk.
 *
 *   node scripts/post-open-block.mjs [minutes]     default: 180
 *
 * The deployed desk reads its book from the enclave, and the enclave's book is
 * memory — it starts empty after every container replacement, and auctions that
 * have cleared stay on it as receipts. So a visitor could arrive at a desk with
 * nothing open on it, which reads as a product with nothing to do rather than
 * as a quiet market. Fourteen of the desk's own flow checks failed for the same
 * reason: there was no sealed auction to bid on, so every check about the bid
 * form had nothing to attach to.
 *
 * This posts one real auction: the lot goes into escrow on the contract, and
 * the instruction reaches the enclave the way any other does. Nothing here is
 * seeded into memory — a row that exists only in the enclave would look real on
 * the desk and revert the moment somebody sealed a bid against it on-chain.
 *
 * The reserve is ECIES-encrypted to the key the DIAMOND publishes for our
 * machine, not to whatever a proxy serves. Encrypting to a relayed key is the
 * one move that would hand the operator the maker's floor.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flareTestnet } from "viem/chains";
import { encrypt } from "ecies-geth";
import { EXT_ID, SENDER as INSTRUCTION_SENDER } from "./ext-config.mjs";

const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";
const ZERO = "0x0000000000000000000000000000000000000000";

const LOT = 2_000_000n;      // 2 FXRP, six decimals
const RESERVE = 500_000n;    // the floor a lone bidder pays
const FEE = 1_000_000_000n;  // what the diamond charges to forward one instruction
// Coston2 runs about 1.8s a block. Long enough that a judge who opens the desk
// hours after we posted still finds something they can bid on.
const BLOCKS_PER_MINUTE = 33n;

const minutes = BigInt(Number.parseInt(process.argv[2] ?? "180", 10));
if (!Number.isFinite(Number(minutes)) || minutes <= 0n) {
  console.error("usage: node scripts/post-open-block.mjs [minutes]   (a positive whole number)");
  process.exit(2);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const keyLine = fs
  .readFileSync(path.join(root, ".env"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("DEPLOYMENT_PRIVATE_KEY="));
if (!keyLine) {
  console.error("no DEPLOYMENT_PRIVATE_KEY in .env");
  process.exit(1);
}
const raw = keyLine.slice("DEPLOYMENT_PRIVATE_KEY=".length).trim();
const account = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);

const senderAbi = parseAbi([
  "function postRfq(address settleToken, address lotToken, uint256 lot, uint64 deadlineBlock, address invited, bytes encryptedReserve) payable returns (uint256)",
  "event RfqPosted(uint256 indexed rfqId, address indexed maker, uint256 lot, uint64 deadlineBlock)",
]);
const erc20Abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const diamondAbi = parseAbi([
  "function getRandomTeeIds(uint256,uint256) view returns (address[])",
  "function getPublicKey(address) view returns (bytes32 x, bytes32 y)",
]);

const pc = createPublicClient({ chain: flareTestnet, transport: http(RPC) });
const wc = createWalletClient({ account, chain: flareTestnet, transport: http(RPC) });
const xrp = (v) => `${(Number(v) / 1e6).toLocaleString()} FXRP`;

const balance = await pc.readContract({ address: FXRP, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
if (balance < LOT) {
  console.error(`not enough FXRP: the lot alone is ${xrp(LOT)}, this wallet holds ${xrp(balance)}`);
  process.exit(1);
}

const allowance = await pc.readContract({ address: FXRP, abi: erc20Abi, functionName: "allowance", args: [account.address, INSTRUCTION_SENDER] });
if (allowance < LOT) {
  const h = await wc.writeContract({ address: FXRP, abi: erc20Abi, functionName: "approve", args: [INSTRUCTION_SENDER, LOT * 4n] });
  await pc.waitForTransactionReceipt({ hash: h });
  console.log(`approved  ${xrp(LOT * 4n)}`);
}

const ids = await pc.readContract({ address: DIAMOND, abi: diamondAbi, functionName: "getRandomTeeIds", args: [EXT_ID, 1n] });
// viem hands back a two-element array for two outputs, named or not.
const pk = await pc.readContract({ address: DIAMOND, abi: diamondAbi, functionName: "getPublicKey", args: [ids[0]] });
const [x, y] = Array.isArray(pk) ? pk : [pk.x, pk.y];
const b = (h) => Buffer.from(h.slice(2), "hex");
const sealed = await encrypt(Buffer.concat([Buffer.from([0x04]), b(x), b(y)]), Buffer.from(JSON.stringify({ reserve: Number(RESERVE), pair: "FXRP/FXRP" })));

const head = await pc.getBlockNumber();
const deadline = head + minutes * BLOCKS_PER_MINUTE;

// An explicit ceiling rather than an estimate. postRfq pulls the lot with an
// FAsset transferFrom, and the cost of that shifts between the block the
// estimate is made in and the block it executes in — twice it reverted at a
// gasUsed BELOW the estimate, which reads like a contract bug and is not one.
const hash = await wc.writeContract({
  address: INSTRUCTION_SENDER, abi: senderAbi, functionName: "postRfq",
  args: [FXRP, FXRP, LOT, deadline, ZERO, `0x${sealed.toString("hex")}`],
  value: FEE,
  gas: 700_000n,
});
const rcpt = await pc.waitForTransactionReceipt({ hash });

let rfqId = 0n;
for (const log of rcpt.logs) {
  try {
    const e = decodeEventLog({ abi: senderAbi, data: log.data, topics: log.topics });
    if (e.eventName === "RfqPosted") rfqId = e.args.rfqId;
  } catch {
    /* not ours */
  }
}

console.log(`RFQ ${rfqId} open until block ${deadline} (~${minutes} minutes)`);
console.log(`lot ${xrp(LOT)}, reserve sealed to the enclave, maker ${account.address}`);
console.log(`https://coston2-explorer.flare.network/tx/${hash}`);
