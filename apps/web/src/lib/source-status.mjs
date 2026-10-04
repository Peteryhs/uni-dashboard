import { ageState } from '../../../../packages/contract/src/cards.mjs';

/**
 * A status badge must reflect the source's data, not just the latest recorded attempt. In
 * particular, skipped attempts do not prove the cached rows were refreshed, and partial calendar
 * parses may leave old rows in place.
 */
export function sourceCondition(source, now = Date.now()) {
  if (!source.ready) return 'blocked';
  const run = source.last_run;
  if (!run) return 'unknown';
  if (source.job?.circuit === 'open') return 'failing';
  if (run.outcome === 'skipped') return 'unknown';
  if (!['ok', 'empty'].includes(run.outcome)) return 'failing';
  if (Number(run.meta?.skipped_events) > 0) return 'partial';

  const age = ageState(run.at, source.cadence_ms, now);
  if (age === 'dead') return 'dead';
  if (age === 'stale') return 'stale';
  return 'healthy';
}
