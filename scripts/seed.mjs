/**
 * Put a book on the dev desk that is worth looking at.
 *
 *   node scripts/seed.mjs [proxyUrl]      default: http://127.0.0.1:6675
 *
 * README told people to run this and the file did not exist, so the documented
 * first run ended in "Cannot find module". It exists now, and it seeds the one
 * thing a screenshot of an empty desk cannot show: auctions on both sides of
 * their deadline.
 *
 * The deadlines are placed around the CHAIN'S head, not hardcoded. A fixed
 * block number goes stale - the demo book was written around 24.1M while
 * Coston2 is past 33M, so every row read "deadline passed 9,478,951 blocks ago",
 * which demonstrates the countdown in its one useless state.
 *
 * Needs BUTA_ALLOW_DIRECT_AUCTION=1 on the extension: POST_RFQ over the direct
 * channel is refused by default, and should be.
 */
const BASE = process.argv[2] ?? process.env.BUTA_DEV_URL ?? "http://127.0.0.1:6675";
const RPC = process.env.CHAIN_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

const b32 = (s) => "0x" + Buffer.from(s).toString("hex").padEnd(64, "0");
const hexJson = (o) => "0x" + Buffer.from(JSON.stringify(o)).toString("hex");

async function call(command, payload) {
  const res = await fetch(`${BASE}/direct`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ opType: b32("BUTA"), opCommand: b32(command), message: hexJson(payload) }),
  });
  if (!res.ok) throw new Error(`POST /direct ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const { data } = await res.json();

  for (let i = 0; i < 20; i++) {
    const r = await (await fetch(`${BASE}/action/result/${data.id}?submissionTag=submit`)).json();
    if (r.result.status === 2) {
      await new Promise((s) => setTimeout(s, 500));
      continue;
    }
    if (r.result.status !== 1) throw new Error(`${command}: ${r.result.log}`);
    return r.result.data && r.result.data !== "0x"
      ? JSON.parse(Buffer.from(r.result.data.slice(2), "hex").toString())
      : null;
  }
  throw new Error(`${command}: no result after 10s`);
}

async function head() {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  return parseInt((await r.json()).result, 16);
}

const MAKER = "0x1111111111111111111111111111111111111111";

// Offsets in blocks from the head. Coston2 is ~1.8s a block, so +4000 is about
// two hours. The negative one matters most: without an auction past its
// deadline there is nothing to press Clear on, and clearing is a third of the
// product.
const BOOK = [
  { lot: 500_000, reserve: 120_000, offset: +4_000, note: "about two hours left" },
  { lot: 80_000, reserve: 20_000, offset: +1_200, note: "about half an hour left" },
  { lot: 1_200_000, reserve: 300_000, offset: -50, note: "past its deadline - clearable now" },
];

try {
  await fetch(`${BASE}/info`).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  });
} catch (e) {
  console.error(`no extension at ${BASE} - ${e.message}`);
  console.error("start it with:  BUTA_ALLOW_DIRECT_AUCTION=1 BUTA_DEV_PORT=6675 go run ./cmd/dev");
  process.exit(1);
}

const now = await head();
console.log(`chain head ${now.toLocaleString()}`);

for (const b of BOOK) {
  const { rfqId } = await call("POST_RFQ", {
    maker: MAKER,
    pair: "FXRP/USDT0",
    lot: b.lot,
    reserve: b.reserve,
    deadline: now + b.offset,
    invited: "",
  });
  console.log(`  RFQ ${String(rfqId).padStart(3, "0")}  lot ${b.lot.toLocaleString()}  ${b.note}`);
}

const book = await call("LIST_RFQS", {});
console.log(`\n${book.length} on the desk. Start the frontend and open /dashboard/.`);
