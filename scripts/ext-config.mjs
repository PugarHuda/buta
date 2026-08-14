/**
 * The two identifiers a redeploy changes, read from the file that deploy writes.
 *
 *   import { EXT_ID, SENDER } from "./ext-config.mjs";
 *
 * Every script here used to pin both as constants. That is fine until the day a
 * contract is redeployed - and then nothing fails loudly. A stale sender is a
 * live contract that answers every call about auctions nobody is looking at, and
 * a stale extension id reads the active set of an extension nobody serves. Both
 * report confidently, and both are wrong.
 *
 * config/extension.env is written by pre-build.sh, which is what deploys.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../config/extension.env", import.meta.url));
const text = fs.readFileSync(path, "utf8");

function value(key) {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} missing from config/extension.env - run scripts/pre-build.sh`);
  return line.slice(key.length + 1).trim();
}

/** The FCC extension id, as a bigint. Stored in the file as a bytes32 word. */
export const EXT_ID = BigInt(value("EXTENSION_ID"));

/** ButaInstructionSender, the contract the diamond routes this extension to. */
export const SENDER = value("INSTRUCTION_SENDER");
