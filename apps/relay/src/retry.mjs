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
