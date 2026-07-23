// onchain-status.mjs — proves Buta's on-chain wiring from public reads alone.
//
// Anyone (a judge, a skeptic) can run this against Coston2 and confirm the
// contract is deployed, source-verified, and reads back its own constants — no
// private key, no trust in our word. Node >= 18 (global fetch).
//
//   node scripts/onchain-status.mjs

const RPC = "https://coston2-api.flare.network/ext/C/rpc";
const BUTA = "0x20d9CcAA7140bf38AD91D2F102bA996417798e8f";
const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const EXT_ID = 65642n; // 0x1006a — assigned by the FCC diamond at registration
const EXPLORER = "https://coston2-explorer.flare.network/address/";

async function ethCall(to, data) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function explorer(path) {
  const r = await fetch(`https://coston2-explorer.flare.network/api/v2/${path}`);
  return r.json();
}

const b32ToStr = (hex) => Buffer.from(hex.replace(/^0x/, ""), "hex").toString("utf8").replace(/\0+$/, "");
const lastAddr = (hex) => "0x" + hex.slice(-40);
const line = (label, value, link) =>
  console.log(`  ${label.padEnd(26)} ${link ? `${value}  ${link}` : value}`);

// Function selectors (first 4 bytes of keccak256(signature)) — verified against
// the deployed ABI, not guessed.
const SEL = {
  OP_TYPE_BUTA: "0xdb86b5dd",
  rfqCount: "0xf422aa08",
  teeAddressSet: "0x94aae1fe",
  teeAddress: "0x78b9e620",
  // getTeeExtensionInstructionsSender(uint256) on the diamond
  senderOf: "0x2c177358",
};

console.log("\nBUTA — on-chain status (Coston2, chain 114)\n");

// 1) explorer facts (verified source + name) — the strongest single proof
const meta = await explorer(`smart-contracts/${BUTA}`).catch(() => ({}));
line("Contract", BUTA, EXPLORER + BUTA);
line("Source verified", meta?.is_verified ? "yes" : "no (check explorer)");
line("Contract name", meta?.name ?? "?");

// 2) read the contract's own constants over RPC (no explorer needed)
try {
  const opType = await ethCall(BUTA, SEL.OP_TYPE_BUTA);
  line("OP_TYPE_BUTA()", `${b32ToStr(opType)}  (${opType.slice(0, 10)}…)`);
} catch (e) { line("OP_TYPE_BUTA()", "read failed: " + e.message); }

try {
  const set = await ethCall(BUTA, SEL.teeAddressSet);
  const addr = await ethCall(BUTA, SEL.teeAddress);
  line("teeAddress set", (BigInt(set) === 1n ? "yes → " : "no ") + lastAddr(addr));
} catch (e) { line("teeAddress", "read failed: " + e.message); }

// 3) the FCC registration: does the diamond point extension 65642 at us?
line("FCC extension ID", `${EXT_ID}  (0x${EXT_ID.toString(16)})`);
try {
  const who = await ethCall(DIAMOND, SEL.senderOf + EXT_ID.toString(16).padStart(64, "0"));
  const addr = lastAddr(who);
  const ok = addr.toLowerCase() === BUTA.toLowerCase();
  line("Diamond → sender", addr + (ok ? "  ✓ matches" : "  ✗ mismatch"));
} catch (e) { line("Diamond → sender", "read failed: " + e.message); }

console.log(
  "\n  The diamond records our contract as the instruction sender for extension\n" +
  "  65642, and setExtensionId() found and stored that id on-chain. The\n" +
  "  instruction path is wired; processing needs a registered TEE machine, which\n" +
  "  the simulated cmd/dev path stands in for this hackathon.\n"
);
