import { readiness, dedupeGoogleSources } from '#sources/registry.mjs';
import { sourceCondition, sourceFreshness, sourceRecovery, healthSummary } from '#contract/source-health.mjs';

const NAMES = {
  'uw-food-daily-menu': 'Dining menu', 'uw-portal-ics': 'Portal schedule',
  'google-calendar-ics': 'Google Calendar', 'uw-learn-ics': 'LEARN deadlines',
  'uw-status': 'Campus services', 'user-office-hours': 'Office hours',
};

function publicRun(run) {
  return run ? { at: run.finished_at, outcome: run.outcome, http_status: run.http_status ?? null,
    rows: run.rows_written ?? 0, bytes: run.bytes ?? 0, error: run.error || '', meta: run.meta ?? {} } : null;
}

function publicJob(job) {
  return job ? { next_due_at: job.next_due_at, circuit: job.circuit_state, failures: job.consecutive_failures,
    last_outcome: job.last_outcome ?? null, last_started_at: job.last_started_at ?? null,
    last_finished_at: job.last_finished_at ?? null, lease_expires_at: job.lease_expires_at ?? null } : null;
}

function withStatus(source, now, runtime) {
  return { ...source, condition: sourceCondition(source, now), freshness: sourceFreshness(source, now),
    recovery: sourceRecovery(source, { now, runtime }) };
}

/** Shared by local and Worker routes, so the clients see the same status policy. */
export async function buildHealth(store, { sources, now = Date.now(), runtime } = {}) {
  const sourceIds = (sources ?? []).map((source) => source.id);
  const [last, jobs, snapshots, successful, weatherRaw] = await Promise.all([
    store.lastRunPerSource(sourceIds), store.jobs(), store.snapshotCount(), store.lastSuccessfulRunPerSource(sourceIds),
    store.getSetting('WEATHER_FORECAST_JSON'),
  ]);
  const available = readiness(sources.filter(source => !source.disabled));
  const uniqueIds = new Set(dedupeGoogleSources(sources.filter(source => !source.disabled)).map(source => source.id));
  const alternateScheduleReady = available.some(source => ['uw-portal-ics', 'google-calendar-ics'].includes(source.id) && source.ready);
  const result = available.map(source => {
    const run = last.find(row => row.source_id === source.id);
    const success = successful.find(row => row.source_id === source.id);
    const job = jobs.find(row => row.source_id === source.id);
    const alternate = ['uw-portal-ics', 'google-calendar-ics'].includes(source.id) && !source.ready && alternateScheduleReady;
    const value = { ...source, name: NAMES[source.id] ?? source.id,
      monitored: uniqueIds.has(source.id) && !alternate && !(source.optional && !source.ready), last_run: publicRun(run),
      last_success_at: success?.finished_at ?? null,
      age_s: success ? Math.max(0, Math.round((now - success.finished_at) / 1000)) : null,
      job: publicJob(job) };
    return withStatus(value, now, runtime);
  });
  let weather;
  try { weather = weatherRaw ? JSON.parse(weatherRaw) : null; } catch { weather = null; }
  const validWeather = Array.isArray(weather?.forecast) && weather.forecast.length > 0 && Number.isFinite(weather.observed_at);
  const attempt = Number.isFinite(weather?.attempted_at) ? weather.attempted_at : null;
  // Weather uses its cache as a retry lease rather than the source job table.
  const weatherDue = Math.max(validWeather ? weather.observed_at + 30 * 60_000 : now,
    attempt == null ? 0 : attempt + 15 * 60_000);
  const weatherSource = { id: 'open-meteo', name: 'Weather', role: 'weather', shape: 'weather', cadence_ms: 30 * 60_000,
    stale_after_ms: 60 * 60_000, dead_after_ms: 180 * 60_000,
    needs_secret: false, optional: false, env_var: null, ready: true, blocked_by: '', monitored: true,
    last_success_at: validWeather ? weather.observed_at : null,
    last_run: attempt == null ? null : { at: attempt, outcome: weather.error ? 'failed' : validWeather ? 'ok' : 'skipped',
      http_status: null, rows: validWeather ? weather.forecast.length : 0, bytes: 0, error: weather.error || '', meta: {} },
    age_s: validWeather ? Math.max(0, Math.round((now - weather.observed_at) / 1000)) : null,
    job: { next_due_at: weatherDue, circuit: 'closed', failures: weather?.error ? 1 : 0,
      last_outcome: weather?.error ? 'failed' : validWeather ? 'ok' : null,
      last_started_at: attempt, last_finished_at: attempt, lease_expires_at: null } };
  result.push(withStatus(weatherSource, now, runtime));
  return { now, sources: result, snapshots, runtime, summary: healthSummary(result, now) };
}
