/**
 * The registry. A new source is one file, one line here, one fixture.
 * Nothing downstream changes: the API and both clients stay untouched.
 */
import food from './food/source.mjs';
import { portalIcs, learnIcs } from './ics/source.mjs';
import status from './status/source.mjs';
import userOfficeHours from './office-hours/source.mjs';

export const SOURCES = [food, portalIcs, learnIcs, status, userOfficeHours];
export { userOfficeHours };

export function enabledSources(sources = SOURCES) {
  return sources.filter((s) => !s.disabled);
}

export function sourceById(id, sources = SOURCES) {
  return sources.find((s) => s.id === id) ?? null;
}

/**
 * Google throttles by URL and IP, so two configured source entries pointing at the same private
 * Calendar subscription must share one fetch. Keep this narrow to Google Calendar: different
 * adapters can legitimately consume the same non-Google endpoint with different parsers.
 */
export function dedupeGoogleSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    const raw = typeof source.url === 'function' ? source.url() : source.url;
    if (!raw) return true;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return true;
    }
    if (!/(^|\.)calendar\.google\.com$/i.test(parsed.hostname)) return true;
    parsed.hash = '';
    parsed.searchParams.sort();
    const key = parsed.toString();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Honest reporting: which sources can actually run right now, and which are waiting on a secret. */
export function readiness(sources = SOURCES) {
  return sources.map((s) => {
    const needsUrl = typeof s.url === 'function' ? s.url() : s.url;
    const ready = !s.needsSecret || Boolean(needsUrl);
    return {
      id: s.id,
      role: s.role ?? shapeOf(s),
      shape: s.shape ?? s.shape,
      cadence_ms: s.cadenceMs,
      needs_secret: Boolean(s.needsSecret),
      env_var: s.envVar ?? null,
      ready,
      blocked_by: ready ? '' : `set ${s.envVar}`,
    };
  });
}

function shapeOf(s) {
  return s.shape ?? '';
}
