/**
 * The one place that talks to the enclave, shared by the routes in api/tee/.
 *
 * Kept apart from the routes because the interesting part is not the routing - 
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

/**
 * Two guards, because this endpoint hands the internet a key-injected pipe to
 * one container on one laptop. There is no caller to authenticate - the desk is
 * a public bundle, so any secret it carried would be public - which leaves
 * cost: make a flood cheap for us and useless to the sender.
 *
 * A hostile probe held twelve concurrent unauthenticated reads open against the
 * live enclave, each ~2s. Nothing broke, but nothing had to: the desk polls the
 * same channel, and an enclave answering strangers is an enclave not answering
 * a judge.
 */
const buckets = new Map();

/**
 * True when this caller has spent its allowance.
 *
 * Measured, so it does not overclaim: forty sequential requests from one
 * address all came back 200. The counter lives in one instance's memory and
 * Vercel spreads requests across instances, so this catches a burst that lands
 * on a warm instance and does NOT stop a determined flood. The cache below is
 * the load-bearing half - a repeated read of the book never reaches the enclave
 * at all. A durable limit belongs in the platform's firewall, one rule on
 * /api/tee/*, which is a dashboard setting rather than code.
 */
export function throttled(req, res, { perWindow = 30, windowMs = 10_000 } = {}) {
  const ip = String(req.headers["x-forwarded-for"] ?? "unknown").split(",")[0].trim();
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now - b.start > windowMs) {
    buckets.set(ip, { start: now, n: 1 });
  } else if (++b.n > perWindow) {
    res.setHeader("Retry-After", Math.ceil((b.start + windowMs - now) / 1000));
    res.status(429).json({ error: "too many requests - this desk is one machine, please slow down" });
    return true;
  }
  // Unbounded growth is its own denial of service. Serverless instances are
  // short-lived, but not so short that a spray of forged X-Forwarded-For
  // headers cannot fill a Map.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now - v.start > windowMs) buckets.delete(k);
  }
  return false;
}

/**
 * Collapse the reads everyone makes at once.
 *
 * The book and the enclave's public key are the same answer for every visitor,
 * and every open tab asks for them on a timer. Serving them from the instance
 * for a few seconds means ten readers cost the enclave what one does - and a
 * flood of the same read costs it nothing at all. Anything per-caller
 * (GET_MY_BIDS) is deliberately not cached.
 */
const answers = new Map();

export async function cachedText(key, ttlMs, produce) {
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await produce();
  answers.set(key, { at: Date.now(), value });
  if (answers.size > 200) answers.clear();
  return value;
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
export async function fetchUpstream(target, init) {
  const r = await fetch(target, { ...init, signal: AbortSignal.timeout(8000) });
  return { status: r.status, type: r.headers.get("content-type") ?? "application/json", text: await r.text() };
}

export async function forward(res, target, init, { cacheKey, ttlMs } = {}) {
  try {
    const answer = cacheKey
      ? await cachedText(cacheKey, ttlMs, () => fetchUpstream(target, init))
      : await fetchUpstream(target, init);
    res.status(answer.status);
    res.setHeader("Content-Type", answer.type);
    res.setHeader("Cache-Control", "no-store");
    return res.send(answer.text);
  } catch (e) {
    return res.status(504).json({ error: `enclave unreachable: ${String(e?.message ?? e)}` });
  }
}
