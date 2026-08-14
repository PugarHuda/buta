/**
 * Deploy the quote token the desk settles in, and fund the wallets that need it.
 *
 *   node scripts/deploy-quote-token.mjs [--to 0xaddr ...]
 *
 * The desk posts every on-chain auction with USDT0 as the settlement token, and
 * the address it used - 0xe7cd86e1…C82D - has no code on Coston2. Nothing is
 * deployed there. So every block the desk has ever posted was unsettleable from
 * the moment it was posted: relayClearing calls transferFrom on an address that
 * is not a contract, and the pre-flight reported it as "the winner has approved
 * 0", because reading allowance from nothing throws and the read falls back to
 * zero.
 *
 * It went unnoticed because the two settlements that proved this system works
 * were FXRP/FXRP, posted by scripts/onchain-loop.ts, which never touches this
 * address.
 *
 * TestToken is mintable by anyone on purpose - it is a testnet quote asset, not
 * a claim to be a real USD₮0.
 */
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flareTestnet } from "viem/chains";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const MINT = 1_000_000_000n; // 1,000 units at six decimals, per wallet

const root = fileURLToPath(new URL("../", import.meta.url));
const envLine = fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
  .find((l) => l.startsWith("DEPLOYMENT_PRIVATE_KEY="));
const raw = envLine?.slice("DEPLOYMENT_PRIVATE_KEY=".length).trim();
if (!raw) {
  console.error("no DEPLOYMENT_PRIVATE_KEY in .env");
  process.exit(2);
}
const account = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);

const artifact = JSON.parse(
  fs.readFileSync(path.join(root, "out/TestToken.sol/TestToken.json"), "utf8"),
);

const extra = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--to" && process.argv[i + 1]) extra.push(process.argv[++i]);
}
// The bidder wallet always needs some: it is the winner, and the winner is the
// one who pays.
const bidderPath = path.join(root, ".bidder.key");
if (fs.existsSync(bidderPath)) {
  const k = fs.readFileSync(bidderPath, "utf8").trim();
  extra.push(privateKeyToAccount(k.startsWith("0x") ? k : `0x${k}`).address);
}

const pc = createPublicClient({ chain: flareTestnet, transport: http(RPC) });
const wc = createWalletClient({ account, chain: flareTestnet, transport: http(RPC) });

const hash = await wc.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args: ["Buta test quote", "USDT0t"],
});
const rcpt = await pc.waitForTransactionReceipt({ hash });
const token = rcpt.contractAddress;
console.log(`deployed ${token}  ${hash}`);

const ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
]);

for (const to of [account.address, ...extra]) {
  const h = await wc.writeContract({ address: token, abi: ABI, functionName: "mint", args: [to, MINT] });
  await pc.waitForTransactionReceipt({ hash: h });
  const b = await pc.readContract({ address: token, abi: ABI, functionName: "balanceOf", args: [to] });
  console.log(`  ${to} now holds ${formatUnits(b, 6)}`);
}

console.log(`
Point the desk at it:

  frontend/.env.local   VITE_USDT0=${token}

and rebuild. Until then the desk keeps posting auctions whose settlement token
does not exist, and none of them can ever settle.`);
