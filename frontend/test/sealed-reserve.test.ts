/**
 * The sealed reserve the on-chain rail carries, opened by a real enclave.
 *
 * postRfq takes `bytes encryptedReserve` and the desk was sending `0x`. That
 * cost more than the floor: the PAIR travels in the same envelope, so an
 * on-chain block was recorded with no reserve and no pair name at all — and a
 * zero floor means a lone bid takes the lot for nothing.
 *
 * Encrypting is easy to get wrong in a way nothing notices, because the failure
 * is on the far side: "opening sealed reserve: ecies: invalid message" happens
 * in the enclave, not here. So this asks the enclave.
 *
 *   BUTA_ALLOW_DIRECT_AUCTION=1 BUTA_DEV_PORT=6675 go run ./cmd/dev
 *   npm test
 *
 * Skipped, not failed, when no enclave is listening: a unit suite that demands
 * a running service is a suite people stop running.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encrypt } from "ecies-geth";
import { encodeAbiParameters } from "viem";

const BASE = process.env.BUTA_DEV_URL ?? "http://127.0.0.1:6675";

const b32 = (s: string) => "0x" + Buffer.from(s).toString("hex").padEnd(64, "0");
const hexJson = (o: unknown) => "0x" + Buffer.from(JSON.stringify(o)).toString("hex");

async function up(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/info`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function call(command: string, payload: unknown) {
  const r = await fetch(`${BASE}/direct`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ opType: b32("BUTA"), opCommand: b32(command), message: hexJson(payload) }),
  });
  const { data } = (await r.json()) as { data: { id: string } };
  for (let i = 0; i < 20; i++) {
    const res = (await (await fetch(`${BASE}/action/result/${data.id}?submissionTag=submit`)).json()) as {
      result: { status: number; log: string; data: string };
    };
    if (res.result.status !== 2) return res.result;
    await new Promise((s) => setTimeout(s, 300));
  }
  throw new Error(`${command}: no result`);
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

/** The extension's own HTTP endpoint, which is where instructions are decoded.
 *  cmd/dev logs it as "extension listening on :8080 (internal)". */
const EXT = process.env.BUTA_EXT_URL ?? "http://127.0.0.1:8080";

async function instruction(command: string, originalMessage: `0x${string}`) {
  const df = {
    instructionId: "0x" + "2a".padStart(64, "0"),
    opType: b32("BUTA"),
    opCommand: b32(command),
    originalMessage,
  };
  const action = {
    data: {
      id: "0x" + "2a".padStart(64, "0"),
      type: "instruction",
      message: "0x" + Buffer.from(JSON.stringify(df)).toString("hex"),
    },
  };
  const r = await fetch(`${EXT}/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
  return { status: r.status, body: await r.text() };
}

/** The enclave's own key. cmd/dev registers nothing, so this is the only place
 *  its key exists — which is exactly why the escape hatch has to exist too. */
async function devKey(): Promise<Buffer> {
  const info = (await (await fetch(`${BASE}/info`)).json()) as {
    machineData: { publicKey: { x: string; y: string } };
  };
  const b = (h: string) => Buffer.from(h.slice(2).padStart(64, "0"), "hex");
  return Buffer.concat([Buffer.from([0x04]), b(info.machineData.publicKey.x), b(info.machineData.publicKey.y)]);
}

test("the enclave opens a reserve sealed the way the desk seals it", async (t) => {
  if (!(await up())) return t.skip(`no enclave at ${BASE}`);

  const RESERVE = 314159;
  const PAIR = "FXRP/USDT0";
  // Byte for byte what lib/buta.ts sealReserve() produces.
  const body = JSON.stringify({ reserve: RESERVE, pair: PAIR });
  const ct = await encrypt(await devKey(), Buffer.from(body));

  // Through the INSTRUCTION path, which is the only one that decrypts.
  //
  // The first version of this posted plaintext over the direct rail and then
  // asserted the plaintext survived — the envelope was never opened by anyone
  // and removing the encryption entirely would not have failed it. The direct
  // rail takes the reserve in the clear; only decodePostRfq calls the Decryptor.
  const rfqId = Date.now() % 1_000_000;
  const payload = encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }, { type: "address" }, { type: "bytes" }],
    [BigInt(rfqId), "0x2222222222222222222222222222222222222222", 5000n, 40_000_000n, ZERO_ADDR, `0x${ct.toString("hex")}`],
  );
  const res = await instruction("POST_RFQ", payload);
  assert.equal(res.status, 200, `the enclave refused the sealed reserve: ${res.body.slice(0, 160)}`);

  const ar = JSON.parse(res.body) as { status: number; log: string };
  assert.equal(ar.status, 1, ar.log);

  // What it read back out of the envelope. Getting the key or the envelope
  // wrong fails above with "opening sealed reserve: ecies: invalid message" —
  // on the enclave side, where nothing on the desk would ever see it.
  const state = await call("GET_RFQ_STATE", { rfqId });
  assert.equal(state.status, 1, state.log);
  const s = JSON.parse(Buffer.from(state.data.slice(2), "hex").toString());
  assert.equal(s.pair, PAIR, "the pair rides in the sealed envelope and must survive the round trip");

  // And it stays sealed: the reserve is the one number a public read must never
  // return, whichever rail put it there.
  assert.ok(!JSON.stringify(s).includes(String(RESERVE)), "the reserve came back in a public read");
});
