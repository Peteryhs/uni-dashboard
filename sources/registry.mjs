/**
 * The registry. A new source is one file, one line here, one fixture.
 * Nothing downstream changes: the API and both clients stay untouched.
 */
import food from './food/source.mjs';
import { portalIcs, learnIcs } from './ics/source.mjs';
import status from './status/source.mjs';

export const SOURCES = [food, portalIcs, learnIcs, status];

export function enabledSources(sources = SOURCES) {
  return sources.filter((s) => !s.disabled);
}

export function sourceById(id, sources = SOURCES) {
  return sources.find((s) => s.id === id) ?? null;
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
