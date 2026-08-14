/**
 * GET /api/tee/action/result/:id?submissionTag=threshold
 *
 * The signed outcome of one instruction. This is its own file rather than a
 * branch of the catch-all next door because the catch-all did not receive
 * three-segment paths at all: `/api/tee/info` and `/api/tee/direct` reached it,
 * `/api/tee/action/result/0x…` came back as Vercel's own NOT_FOUND page, which
 * looks exactly like a missing enclave from inside the desk. An explicit route
 * cannot be wrong about its own depth.
 *
 * Read-only, and what it returns is public by the time anyone can ask: the
 * winner and the clearing price are what settlement writes on-chain, and the
 * losing amounts were zeroed inside the enclave before this ever existed.
 */
import { forward, headers, throttled, upstream } from "../../../_forward.js";

export default async function handler(req, res) {
  const base = upstream();
  if (!base) return res.status(503).json({ error: "no enclave configured for this deployment" });
  if (req.method !== "GET") return res.status(405).json({ error: "read only" });
  if (throttled(req, res)) return;

  const id = String(req.query.id ?? "");
  const tag = String(req.query.submissionTag ?? "threshold");
  if (!/^0x[0-9a-fA-F]{64}$/.test(id) || !/^[a-z]+$/.test(tag)) {
    return res.status(400).json({ error: "bad instruction id or tag" });
  }

  return forward(res, `${base}/action/result/${id}?submissionTag=${tag}`, { method: "GET", headers: headers() });
}
