/**
 * The one hop between a deployed desk and the enclave under the desk.
 *
 * Until now the production bundle carried no proxy URL at all, so the deployed
 * desk always fell back to the demo book — and because the book was demo,
 * `rowIsReal()` refused every on-chain action behind it. A judge opening the
 * link could not post, seal or settle anything, while the contract and the
 * enclave were both live. The whole rail only ever ran from localhost.
 *
 * Two things stopped it, and neither is fixable in the browser:
 *
 *   1. The extension proxy sends no Access-Control-Allow-Origin at all, so a
 *      cross-origin call from the page dies before it leaves. Flare's own FTDC
 *      proxy does not send one either — checked against it, not assumed.
 *   2. /direct is gated by an API key, and a key in the bundle is a public key
 *      (that is what X8.50 was about). It has to live somewhere the browser
 *      cannot read.
 *
 * So this runs server-side: same-origin for the page, key injected here from an
 * environment variable, and a hard allowlist of what may pass. Everything that
 * MOVES MONEY — postRfq, commitBid, requestClearing, relayClearing — is a
 * contract call signed by the visitor's own wallet and never comes through
 * here. What comes through here is reading the book, the enclave's public key,
 * and a result that is already public once the auction has cleared.
 *
 * Environment (set on the Vercel project, not in this file):
 *   BUTA_ENCLAVE_URL     https://<the host published on-chain>
 *   BUTA_DIRECT_API_KEY  the key the proxy's /direct expects
 */
import { forward, headers, upstream } from "../_forward.js";

/** bytes32-hex, as the desk encodes op names, back to its string. */
function fromBytes32(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x")) return "";
  const bytes = hex.slice(2).replace(/(00)+$/, "");
  if (bytes.length % 2) return "";
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
  return out;
}

/**
 * Commands that only read.
 *
 * The enclave already refuses POST_RFQ / COMMIT_BID / CLEAR_AUCTION over the
 * direct channel unless BUTA_ALLOW_DIRECT_AUCTION is set, because that channel
 * is plain HTTP with no signature over the instruction. This list is the same
 * rule stated a second time, one hop earlier: if the enclave is ever started
 * with that flag on for a local demo, this endpoint still will not carry an
 * auction command in from the internet.
 */
const READ_ONLY = new Set(["LIST_RFQS", "GET_RFQ_STATE", "GET_MY_BIDS"]);

export default async function handler(req, res) {
  const base = upstream();
  if (!base) {
    // Not configured is not worth a 500: the desk reads any failure here as
    // "no enclave reachable" and shows the demo book, which is the honest
    // state for a deployment with no machine behind it.
    return res.status(503).json({ error: "no enclave configured for this deployment" });
  }

  // From the URL, not from req.query.
  //
  // Vercel passes a catch-all segment under the literal key "...path" — dots
  // included — so `req.query.path` is undefined and every request fell through
  // with no clue why. The path is in the URL either way, and reading it there
  // does not depend on a convention that can be renamed.
  const path = decodeURIComponent(String(req.url ?? "").split("?")[0])
    .replace(/^\/api\/tee\/?/, "")
    .replace(/\/+$/, "");

  if (req.method === "GET" && path === "info") {
    // The enclave's signed TeeInfo, carrying the public key bids are encrypted
    // to. Public by necessity: the same key hashes to the teeId the diamond
    // publishes, which is how health.mjs identifies the machine, and the desk
    // refuses to encrypt to a key the chain does not confirm anyway. It is also
    // the desk's reachability probe — without it the page decides there is no
    // enclave and shows the demo book, which is what this exists to stop.
    return forward(res, `${base}/info`, { method: "GET", headers: headers() });
  }

  if (req.method === "POST" && path === "direct") {
    const body = req.body ?? {};
    const command = fromBytes32(body.opCommand);
    if (!READ_ONLY.has(command)) {
      return res.status(403).json({
        error:
          `${command || "that command"} is not readable through this endpoint. ` +
          "Posting a block, sealing a bid and clearing are transactions — sign them with your wallet.",
      });
    }
    return forward(res, `${base}/direct`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  return res.status(404).json({ error: `not proxied: ${req.method} ${path || "/"}` });
}
