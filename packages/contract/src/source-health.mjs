/** Freshness follows successful data; a recent failed attempt never resets its age. */
export function sourceCondition(source, now = Date.now()) {
  if (!source.ready) return source.optional || source.monitored === false ? 'unknown' : 'blocked';
  const run = source.last_run;
  if (source.job?.circuit === 'open') return 'failing';
  if (!run) return 'unknown';
  if (run.outcome === 'skipped') return 'unknown';
  if (!['ok', 'empty'].includes(run.outcome)) return 'failing';
  if (Number(run.meta?.skipped_events) > 0) return 'partial';
  const at = source.last_success_at ?? run.at;
  if (!Number.isFinite(at) || !Number.isFinite(source.cadence_ms) || source.cadence_ms <= 0) return 'unknown';
  const deadAfter = Number.isFinite(source.dead_after_ms) ? source.dead_after_ms : 6 * source.cadence_ms;
  const staleAfter = Number.isFinite(source.stale_after_ms) ? source.stale_after_ms : 3 * source.cadence_ms;
  return now - at > deadAfter ? 'dead' : now - at > staleAfter ? 'stale' : 'healthy';
}

export function healthSummary(sources, now = Date.now()) {
  const monitored = sources.filter(source => source.monitored !== false && !(source.optional && !source.ready));
  const conditions = monitored.map(source => sourceCondition(source, now));
  const healthy = conditions.filter(condition => condition === 'healthy').length;
  const unchecked = conditions.filter(condition => condition === 'unknown').length;
  const issues = conditions.length - healthy - unchecked;
  const condition = issues ? 'attention' : unchecked || !monitored.length ? 'unknown' : 'healthy';
  const warning = issues ? `${issues} ${issues === 1 ? 'source needs' : 'sources need'} attention. Your dashboard may be incomplete.`
    : unchecked ? `${unchecked} ${unchecked === 1 ? 'source has' : 'sources have'} not been checked successfully.`
      : !monitored.length ? 'Source status is unavailable.' : null;
  return { condition, healthy, total: monitored.length, issues, unchecked, warning };
}
