/**
 * The one place that talks to the enclave, shared by the routes in api/tee/.
 *
 * Kept apart from the routes because the interesting part is not the routing —
 * it is that the API key lives here, server-side, and that a caller cannot pick
 * the target. Each route names its own upstream path; nothing forwards a path
 * it was handed.
 *
 * Vercel does not treat a file starting with `_` as a route, so this is not
 * reachable from the internet.
 */

/** The host the chain publishes for our machine. */
export function upstream() {
  return process.env.BUTA_ENCLAVE_URL ?? "";
}

export function headers() {
  const h = { "ngrok-skip-browser-warning": "1" };
  const key = process.env.BUTA_DIRECT_API_KEY;
  if (key) h["X-API-Key"] = key;
  return h;
}

/**
 * Forward and relay the answer verbatim.
 *
 * The timeout is short on purpose: the machine behind this is a container on
 * somebody's desk, and when it is off the desk should fall back to its demo
 * book in seconds rather than leave a reader watching a spinner. Every failure
 * here reads to the page as "no enclave reachable", which is the honest state.
 */
export async function forward(res, target, init) {
  try {
    const r = await fetch(target, { ...init, signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    res.status(r.status);
    res.setHeader("Content-Type", r.headers.get("content-type") ?? "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.send(text);
  } catch (e) {
    return res.status(504).json({ error: `enclave unreachable: ${String(e?.message ?? e)}` });
  }
}
