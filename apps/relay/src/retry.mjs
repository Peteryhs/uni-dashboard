/** Parse an HTTP Retry-After value into a delay in milliseconds.
 *
 * Retry-After may be either a delta in seconds or an HTTP date. Invalid and past values are
 * ignored; callers still apply their own safe minimum for the upstream they are polling.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

/** One retry policy for both databases. Incomplete responses are recoverable, not successes. */
export function nextJobResult(previous, {
  outcome, meta = {}, httpStatus = null, retryAfterMs = 0, cadenceMs = 60_000,
  minimumRefreshMs = 0, rateLimitMinMs = 30 * 60_000, rateLimitMaxMs = 48 * 60 * 60_000,
  now = Date.now(), jitter = () => Math.floor(Math.random() * 1000),
}) {
  const partial = Number(meta.skipped_events) > 0 || meta.partial === true;
  const complete = ['ok', 'empty'].includes(outcome) && !partial;
  const failures = complete ? 0 : (previous?.consecutive_failures ?? 0) + 1;
  const circuit = failures >= 5 ? 'open' : 'closed';
  const multiplier = 2 ** Math.min(20, Math.max(0, failures - 1));
  let delay = cadenceMs;
  if (!complete) {
    // A circuit still probes, but persistent failures get a quiet, bounded recovery window.
    delay = Math.min(15 * 60_000, 30_000 * multiplier);
    if (circuit === 'open') delay = Math.max(delay, 15 * 60_000);
    if (outcome === 'implausible' || [401, 403, 404, 410].includes(httpStatus)) {
      delay = Math.max(delay, Math.min(cadenceMs, 6 * 60 * 60_000));
    }
    if (httpStatus === 429) {
      delay = Math.max(delay, Math.min(rateLimitMaxMs, Math.max(cadenceMs, rateLimitMinMs) * multiplier));
    }
  }
  delay = Math.max(delay, minimumRefreshMs, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
  // Jitter stays inside the ordinary retry cap and never shortens provider instructions.
  const extra = complete ? 0 : Math.min(jitter(), Math.max(0, 15 * 60_000 - delay));
  return { failures, circuit, next_due_at: now + delay + extra, outcome: partial ? 'partial' : outcome };
}
