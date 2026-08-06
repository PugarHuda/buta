/**
 * Reclaim lots left escrowed in retired deployments.
 *
 *   node scripts/reclaim-stranded.mjs [--dry] [0xcontract ...]
 *
 * Every redeploy of ButaInstructionSender left the previous one holding the
 * lots of any auction that never cleared. Testing produced four of those, and
 * 26 FXRP sat in contracts nothing points at any more — real balance on a
 * faucet-limited testnet, which is what stopped the last settlement rehearsal.
 *
 * `reclaimLot` is permissionless and always refunds `r.maker`, so this can run
 * from the deployer wallet regardless of who posted the block. It only needs
 * the deadline to be behind the chain, which for a retired deployment it always
 * is.
 */
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flareTestnet } from "viem/chains";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";
const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";

/** Every ButaInstructionSender that has been deployed, oldest first. The live
 *  one is included on purpose — a lot stranded there counts the same. */
const KNOWN = [
  "0x20d9CcAA7140bf38AD91D2F102bA996417798e8f",
  "0x04Ad1f8E59027E05D8bFc867e8e30B630aB4681F",
  "0x1338ae53002e45AFF1AF53e6fb94650b5C801c88",
  "0x3085C89540353A4b275704b0Bd03eEc3C718D702",
];

const dry = process.argv.includes("--dry");
const given = process.argv.slice(2).filter((a) => a.startsWith("0x"));
const contracts = given.length ? given : KNOWN;

const root = fileURLToPath(new URL("../", import.meta.url));
function envValue(file, key) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return null;
  const line = fs.readFileSync(p, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
}

const ABI = parseAbi([
  "function rfqCount() view returns (uint256)",
  "function rfqs(uint256) view returns (address maker, address settleToken, address lotToken, uint256 lot, uint64 deadlineBlock, address invited, bool cleared, address winner, uint256 clearingPrice)",
  "function reclaimLot(uint256 rfqId)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const pc = createPublicClient({ chain: flareTestnet, transport: http(RPC) });
const head = await pc.getBlockNumber();

let wc = null;
if (!dry) {
  const raw = process.env.DEPLOYMENT_PRIVATE_KEY ?? envValue(".env", "DEPLOYMENT_PRIVATE_KEY");
  if (!raw) {
    console.error("no DEPLOYMENT_PRIVATE_KEY — set it in the environment or .env (or pass --dry)");
    process.exit(2);
  }
  const account = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`);
  wc = createWalletClient({ account, chain: flareTestnet, transport: http(RPC) });
  console.log(`  calling from ${account.address}\n`);
}

/** Token decimals, read once per token — printing 6-decimal FXRP as ether is
 *  how "5 FXRP" became "0.000000000000005" in an earlier report. */
const dec = new Map();
async function decimalsOf(token) {
  if (!dec.has(token)) {
    dec.set(token, await pc.readContract({ address: token, abi: ABI, functionName: "decimals" }).catch(() => 18));
  }
  return dec.get(token);
}

let recovered = 0n;
let failures = 0;

for (const c of contracts) {
  const n = await pc.readContract({ address: c, abi: ABI, functionName: "rfqCount" }).catch(() => null);
  if (n === null) {
    console.log(`${c}  no rfqCount — not an instruction sender, skipped`);
    continue;
  }

  const open = [];
  for (let i = 1n; i <= n; i++) {
    const r = await pc.readContract({ address: c, abi: ABI, functionName: "rfqs", args: [i] });
    const [maker, , lotToken, lot, deadlineBlock, , cleared] = r;
    if (cleared || lot === 0n) continue;
    // The contract's own guard: `block.number <= deadlineBlock` reverts. A live
    // auction still taking bids is not stranded, it is open.
    if (head <= deadlineBlock) {
      console.log(`${c.slice(0, 10)}  rfq ${i} is still open (deadline ${deadlineBlock}, head ${head}) — left alone`);
      continue;
    }
    open.push({ id: i, maker, lotToken, lot });
  }

  if (!open.length) {
    console.log(`${c.slice(0, 10)}  nothing stranded`);
    continue;
  }

  for (const o of open) {
    const d = await decimalsOf(o.lotToken);
    const amount = `${formatUnits(o.lot, d)}${o.lotToken.toLowerCase() === FXRP.toLowerCase() ? " FXRP" : ""}`;
    if (dry) {
      console.log(`${c.slice(0, 10)}  rfq ${o.id} would refund ${amount} to ${o.maker}`);
      recovered += o.lot;
      continue;
    }
    try {
      // Estimate, then double it. One reclaim reverted twice with gasUsed
      // 116700 of a 118988 estimate: FXRP is an FAsset, its transfer cost moves
      // between estimation and execution, and the inner call only gets 63/64 of
      // what is left. It OOGs, returns false, and the contract's own
      // `require(..., "lot refund failed")` reverts — which reads like a
      // refund bug and is really a gas ceiling. Unused gas is refunded, so the
      // headroom costs nothing.
      const gas = await pc.estimateContractGas({
        address: c, abi: ABI, functionName: "reclaimLot", args: [o.id], account: wc.account,
      });
      const hash = await wc.writeContract({ address: c, abi: ABI, functionName: "reclaimLot", args: [o.id], gas: gas * 2n });
      const rcpt = await pc.waitForTransactionReceipt({ hash });
      if (rcpt.status === "success") {
        recovered += o.lot;
        console.log(`${c.slice(0, 10)}  rfq ${o.id} refunded ${amount} to ${o.maker}  ${hash}`);
      } else {
        failures++;
        console.log(`${c.slice(0, 10)}  rfq ${o.id} REVERTED  ${hash}`);
      }
    } catch (e) {
      failures++;
      console.log(`${c.slice(0, 10)}  rfq ${o.id} failed — ${String(e.shortMessage ?? e.message).split("\n")[0]}`);
    }
  }
}

console.log(
  `\n${dry ? "would recover" : "recovered"} ${formatUnits(recovered, 6)} FXRP` +
    (failures ? `, ${failures} failed` : ""),
);
process.exit(failures ? 1 : 0);
