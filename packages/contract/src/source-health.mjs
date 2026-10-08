const SUCCESS = new Set(['ok', 'empty']);

/** A successful empty check is fresh too. Failed/skipped attempts cannot renew saved data. */
export function sourceFreshness(source, now = Date.now()) {
  const at = source.last_success_at ?? (SUCCESS.has(source.last_run?.outcome) ? source.last_run.at : null);
  if (!Number.isFinite(at) || !Number.isFinite(source.cadence_ms) || source.cadence_ms <= 0) return 'unknown';
  const age = Math.max(0, now - at);
  const staleAfter = Number.isFinite(source.stale_after_ms) ? source.stale_after_ms : 3 * source.cadence_ms;
  const deadAfter = Number.isFinite(source.dead_after_ms) ? source.dead_after_ms : 6 * source.cadence_ms;
  if (age > deadAfter) return 'dead';
  if (age > staleAfter) return 'stale';
  return age > source.cadence_ms ? 'ageing' : 'live';
}

/** Preserve the original condition values for older clients; freshness is an independent axis. */
export function sourceCondition(source, now = Date.now()) {
  if (!source.ready) return source.optional || source.monitored === false ? 'unknown' : 'blocked';
  const run = source.last_run;
  if (source.job?.circuit === 'open') return 'failing';
  // Storage can fail before writing a receipt. Its fenced job result still records the attempt.
  const job = source.job;
  if (job?.last_outcome && Number.isFinite(job.last_finished_at) &&
    (!Number.isFinite(run?.at) || job.last_finished_at >= run.at)) {
    if (job.last_outcome === 'partial') return 'partial';
    if (job.last_outcome === 'skipped') return 'unknown';
    if (!SUCCESS.has(job.last_outcome)) return 'failing';
  }
  if (!run) return 'unknown';
  if (run.outcome === 'skipped') return 'unknown';
  if (!SUCCESS.has(run.outcome)) return 'failing';
  if (Number(run.meta?.skipped_events) > 0) return 'partial';
  const freshness = sourceFreshness(source, now);
  return freshness === 'live' || freshness === 'ageing' ? 'healthy' : freshness;
}

/** Explain the actual next operation, including manual runtimes and bounded retry waits. */
export function sourceRecovery(source, { now = Date.now(), runtime } = {}) {
  const automatic = ['automatic', 'scheduled'].includes(runtime?.polling);
  const recovery = (state, action, next_attempt_at, reason, enabled = automatic) =>
    ({ state, action, next_attempt_at, automatic: enabled, reason });
  if (source.monitored === false || (source.optional && !source.ready)) {
    return recovery('inactive', 'none', null, 'This source is optional or covered by another configured source.', false);
  }
  if (!source.ready) return recovery('blocked', 'configure', null, source.blocked_by || 'Configure the source before it can be checked.', false);
  const job = source.job;
  if (Number.isFinite(job?.lease_expires_at) && job.lease_expires_at > now) {
    return recovery('refreshing', 'wait', job.lease_expires_at, 'An update is running; an interrupted update can be retried after its lease expires.');
  }
  if (runtime?.polling === 'manual') {
    return recovery('manual', 'refresh', null, 'Automatic polling is disabled on this relay. Refresh manually or enable its poller.', false);
  }
  if (!automatic) return recovery('unknown', 'refresh', null, 'Automatic polling status is unavailable.', false);
  if (!Number.isFinite(job?.next_due_at)) {
    return recovery('unknown', 'wait', null,
      'The poller will rebuild this source’s schedule and honor provider retry limits before checking it.');
  }
  const due = job.next_due_at;
  const failed = sourceCondition(source, now) === 'failing' || source.last_run?.outcome === 'skipped' || Number(job?.failures) > 0;
  const partial = sourceCondition(source, now) === 'partial' || job?.last_outcome === 'partial';
  if (due <= now) {
    const reason = failed ? 'The retry is due and will run on the next poll.'
        : partial ? 'An incomplete update is due for another check.'
          : 'An update is due and will run on the next poll.';
    return recovery('due', failed || partial ? 'retry' : 'refresh', due, reason);
  }
  if (failed || job?.circuit === 'open') {
    return recovery('backoff', 'retry', due, 'The latest update failed. Automatic retries wait to avoid overloading the provider; an open circuit still retries.');
  }
  return recovery('scheduled', partial ? 'retry' : 'wait', due,
    partial ? 'Some items could not be read; an automatic recovery check is scheduled.' : 'The next automatic update is scheduled.');
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
