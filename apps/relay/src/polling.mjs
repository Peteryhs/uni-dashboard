import { SOURCES, enabledSources, dedupeGoogleSources } from '#sources/registry.mjs';
import { runSource } from './runner.mjs';
import { nextJobResult } from './retry.mjs';

export function sourcePollingPolicy(source) {
  let google = false;
  try {
    const url = typeof source.url === 'function' ? source.url() : source.url;
    google = /(^|\.)calendar\.google\.com$/i.test(new URL(url).hostname);
  } catch {}
  return { cadenceMs: source.cadenceMs,
    minimumRefreshMs: Math.max(source.minimumRefreshMs ?? 0, google ? 6 * 60 * 60_000 : 0),
    rateLimitMinMs: google ? Math.max(source.rateLimitMinMs ?? 0, 12 * 60 * 60_000) : source.rateLimitMinMs,
    rateLimitMaxMs: source.rateLimitMaxMs };
}

export function runnableSources(sources) {
  return dedupeGoogleSources(enabledSources(sources).filter(source =>
    !source.needsSecret || Boolean(typeof source.url === 'function' ? source.url() : source.url)));
}

function sharesGoogleFeed(a, b) {
  return sourcePollingPolicy(a).minimumRefreshMs > 0 && dedupeGoogleSources([a, b]).length === 1;
}

/** Repair legacy/missing scheduling without overriding provider backoff or an active claim. */
export async function reconcilePolling(store, sources, now = Date.now()) {
  const [jobs, runs] = await Promise.all([store.jobs(), store.lastRunPerSource((sources ?? []).map(source => source.id))]);
  const active = runnableSources(sources);
  const ready = [];
  const repairs = [];
  for (const source of active) {
    let job = jobs.find(row => row.source_id === source.id);
    const run = runs.find(row => row.source_id === source.id);
    const policy = sourcePollingPolicy(source);
    const leaseActive = (job?.lease_expires_at ?? 0) > now;
    let due = job?.next_due_at ?? now;
    let reason = null;
    // Previous versions could poll either alias of a shared Google subscription. Carry its
    // provider quiet period forward even if the canonical alias is missing its own job.
    const sharedJobs = jobs.filter(row => sources.some(candidate => candidate.id === row.source_id && sharesGoogleFeed(source, candidate)));
    const sharedDue = Math.max(0, ...sharedJobs.map(row => Math.max(
      row.last_started_at == null ? 0 : row.last_started_at + policy.minimumRefreshMs,
      row.consecutive_failures > 0 ? row.next_due_at : 0)));
    if (!job) {
      reason = 'missing_job';
      if (run) due = nextJobResult(null, { ...policy, outcome: run.outcome, meta: run.meta,
        httpStatus: run.http_status, retryAfterMs: run.meta?.retry_after_ms, now: run.finished_at, jitter: () => 0 }).next_due_at;
    } else if (!leaseActive && job.last_started_at != null &&
      (job.last_finished_at == null || job.last_started_at > job.last_finished_at)) {
      reason = 'interrupted';
      due = Math.max(job.lease_expires_at ?? 0, job.last_started_at + policy.minimumRefreshMs);
    } else if (!leaseActive && run && ['ok', 'empty', 'skipped'].includes(run.outcome)) {
      const incomplete = run.outcome === 'skipped' || Number(run.meta?.skipped_events) > 0 || run.meta?.partial === true;
      const stale = now - run.finished_at > 3 * source.cadenceMs;
      // Repair old "successful" partial/skipped jobs once. New failures already carry a backoff.
      if ((incomplete && !(job.consecutive_failures > 0)) || (stale && !incomplete && !(job.consecutive_failures > 0))) {
        const expected = nextJobResult(null, { ...policy, outcome: run.outcome, meta: run.meta,
          httpStatus: run.http_status, retryAfterMs: run.meta?.retry_after_ms, now: run.finished_at, jitter: () => 0 }).next_due_at;
        if (expected < due) { due = expected; reason = incomplete ? 'incomplete' : 'stale'; }
      }
    }
    // Repair legacy retry jobs that used one-second backoff on a Google Calendar URL.
    if (job?.last_started_at != null && !leaseActive && due < job.last_started_at + policy.minimumRefreshMs) {
      due = job.last_started_at + policy.minimumRefreshMs;
      reason = 'provider_interval';
    }
    if (!leaseActive && due < sharedDue) { due = sharedDue; reason = 'provider_interval'; }
    if (reason && !leaseActive) {
      const applied = await store.repairJob(source.id, due, { expectedNextDueAt: job?.next_due_at ?? null,
        expectedStartedAt: job?.last_started_at ?? null, expectedFinishedAt: job?.last_finished_at ?? null, now });
      if (applied) {
        repairs.push({ source_id: source.id, reason, next_due_at: due });
        // Keep the non-enumerable lease generation for the atomic claim handoff.
        job = Object.assign(job ?? {}, { source_id: source.id, next_due_at: due });
        const index = jobs.findIndex(row => row.source_id === source.id);
        if (index < 0) jobs.push(job);
        else jobs[index] = job;
      } else continue; // Another invocation changed this job; its claim wins.
    }
    if (job && job.next_due_at <= now) ready.push({ source, due: job.next_due_at });
  }
  ready.sort((a, b) => a.due - b.due);
  return { ready: ready.map(item => item.source), jobs, repairs };
}

export function deferredReceipt(source, reason, nextDueAt = null) {
  const now = Date.now();
  return { source_id: source.id, started_at: now, finished_at: now, outcome: 'skipped',
    http_status: null, bytes: 0, rows_written: 0, error: reason,
    meta: { poll_claim: 'deferred', next_due_at: nextDueAt }, tombstones: 0, retry_after_ms: 0 };
}

/** Manual refresh may retry now, except during a provider quiet period or existing backoff. */
export async function pollSource(store, source, { manual = false, jobs = null, sources = SOURCES, log = () => {} } = {}) {
  if (manual) {
    // All entry points claim the same source generation for a duplicated private feed.
    source = runnableSources(sources).find(candidate => sharesGoogleFeed(source, candidate)) ?? source;
  }
  const policy = sourcePollingPolicy(source);
  const allJobs = jobs ?? await store.jobs();
  const job = allJobs.find(row => row.source_id === source.id) ?? null;
  if (manual) {
    const now = Date.now();
    if (!runnableSources([source]).length) return deferredReceipt(source, 'source is disabled or needs configuration');
    const providerDue = job?.last_started_at == null ? 0 : job.last_started_at + policy.minimumRefreshMs;
    const protectedDue = job?.consecutive_failures > 0 || ['failed', 'implausible', 'partial', 'skipped'].includes(job?.last_outcome)
      ? job?.next_due_at ?? 0 : 0;
    const sharedJobs = allJobs.filter(row => sources.some(candidate => candidate.id === row.source_id && sharesGoogleFeed(source, candidate)));
    const nextDue = Math.max(providerDue, protectedDue, ...sharedJobs.map(row => Math.max(
      row.last_started_at == null ? 0 : row.last_started_at + policy.minimumRefreshMs,
      row.consecutive_failures > 0 ? row.next_due_at : 0)));
    if (nextDue > now) return deferredReceipt(source, 'waiting for the scheduled retry or provider refresh interval', nextDue);
  }
  let receipt;
  try {
    receipt = await runSource(source, store, { now: Date.now(), holdLease: true, expectedJob: job });
    if (receipt.claim_token) {
      try {
        await store.recordJobResult(source.id, { ...policy,
          startedAt: receipt.started_at, finishedAt: receipt.finished_at, outcome: receipt.outcome,
          meta: receipt.meta, httpStatus: receipt.http_status, retryAfterMs: receipt.retry_after_ms,
          now: Date.now(), claimToken: receipt.claim_token });
      } finally {
        await store.releaseSource(source.id, receipt.claim_token, Date.now());
      }
    }
  } catch (error) {
    // Preserve trusted rows; a broken adapter or storage operation cannot abort the next source.
    const now = Date.now();
    receipt = { source_id: source.id, started_at: error.poll_started_at ?? now, finished_at: now, outcome: 'failed',
      http_status: null, bytes: 0, rows_written: 0, error: `poll interrupted: ${error.message}`,
      meta: { recovery: 'interrupted' }, tombstones: 0, retry_after_ms: 0 };
    try {
      if (error.poll_claim_token) await store.recordJobResult(source.id, { ...policy,
        startedAt: error.poll_started_at, finishedAt: now, outcome: 'failed', now,
        claimToken: error.poll_claim_token, interrupted: true });
    } catch (scheduleError) { log(`[poll] ${source.id} recovery deferred: ${scheduleError.message}`); }
  }
  log(`[poll] ${source.id} -> ${receipt.outcome} rows=${receipt.rows_written}`);
  return receipt;
}
