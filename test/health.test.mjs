import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { buildHealth } from '../apps/relay/src/health.mjs';
import { sourceCondition, healthSummary } from '../packages/contract/src/source-health.mjs';

const now = Date.parse('2026-10-07T03:00:00Z');
const cadence = 60 * 60_000;
const source = (id, overrides = {}) => ({ id, shape: 'timeline_event', cadenceMs: cadence, needsSecret: false, ...overrides });
const run = (store, id, at, outcome = 'ok', extra = {}) => store.insertRun({ source_id: id, started_at: at, finished_at: at, outcome, ...extra });

test('a failed update preserves the last successful data age', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  run(store, 'calendar', now - 4 * cadence);
  run(store, 'calendar', now, 'failed', { error: 'upstream unavailable' });
  const health = await buildHealth(store, { sources: [source('calendar')], now });
  const calendar = health.sources[0];
  assert.equal(calendar.condition, 'failing');
  assert.equal(calendar.last_run.at, now);
  assert.equal(calendar.last_success_at, now - 4 * cadence);
  assert.equal(calendar.freshness, 'stale');
  assert.equal(calendar.age_s, 4 * cadence / 1000);
  assert.equal(health.summary.healthy, 0);
});

test('configured but unchecked sources remain unknown and successful empty feeds are healthy', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  run(store, 'empty', now, 'empty');
  const health = await buildHealth(store, { sources: [source('unchecked'), source('empty')], now });
  assert.equal(health.sources[0].condition, 'unknown');
  assert.equal(health.sources[0].freshness, 'unknown');
  assert.equal(health.sources[1].condition, 'healthy');
  assert.equal(health.sources[1].freshness, 'live');
  assert.equal(health.summary.condition, 'unknown');
  assert.equal(health.summary.healthy, 1);
});

test('unused alternative schedules and duplicated Google subscriptions do not inflate issues', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const url = 'https://calendar.google.com/calendar/ical/synthetic/basic.ics';
  const sources = [source('uw-portal-ics', { needsSecret: true, url }),
    source('google-calendar-ics', { needsSecret: true, optional: true, url }),
    source('optional', { needsSecret: true, optional: true, url: '' })];
  const health = await buildHealth(store, { sources, now });
  assert.equal(health.sources[0].monitored, true);
  assert.equal(health.sources[1].monitored, false);
  assert.equal(health.sources[2].monitored, false);
  assert.equal(health.summary.total, 2, 'one calendar plus weather');
  const alternate = await buildHealth(store, { sources: [source('uw-portal-ics', { needsSecret: true, url: '' }), source('google-calendar-ics', { needsSecret: true, url })], now });
  assert.equal(alternate.sources[0].monitored, false);
  assert.equal(alternate.sources[0].condition, 'unknown');
});

test('weather reports provider failure without hiding its saved forecast or resetting freshness', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const observed = now - 61 * 60_000;
  store.setSetting('WEATHER_FORECAST_JSON', JSON.stringify({ observed_at: observed, attempted_at: now, forecast: [{ at: now, temp_c: 14 }], error: 'provider unavailable' }));
  const health = await buildHealth(store, { sources: [], now });
  assert.equal(health.sources[0].condition, 'failing');
  assert.equal(health.sources[0].last_success_at, observed);
  assert.equal(health.sources[0].freshness, 'stale');
  store.setSetting('WEATHER_FORECAST_JSON', JSON.stringify({ observed_at: observed, attempted_at: observed, forecast: [{ at: now, temp_c: 14 }] }));
  assert.equal((await buildHealth(store, { sources: [], now })).sources[0].condition, 'stale');
});

test('summary ages successfully checked sources and never calls an empty inventory healthy', () => {
  const value = { ready: true, cadence_ms: cadence, last_success_at: now, last_run: { at: now, outcome: 'ok' } };
  assert.equal(sourceCondition(value, now + 4 * cadence), 'stale');
  assert.equal(healthSummary([value], now).condition, 'healthy');
  assert.equal(healthSummary([value], now + 4 * cadence).condition, 'attention');
  assert.equal(healthSummary([], now).condition, 'unknown');
});

test('explicit freshness windows can be longer than the normal polling cadence', () => {
  const value = { ready: true, cadence_ms: cadence, last_success_at: now, last_run: { at: now, outcome: 'ok' }, stale_after_ms: 8 * cadence, dead_after_ms: 12 * cadence };
  assert.equal(sourceCondition(value, now + 7 * cadence), 'healthy');
  assert.equal(sourceCondition(value, now + 9 * cadence), 'stale');
  assert.equal(sourceCondition(value, now + 13 * cadence), 'dead');
});

test('health exposes retry and active lease metadata without leaking the claim token', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const claim = store.claimSource('calendar', { now, leaseNow: now, leaseMs: 60_000 });
  const health = await buildHealth(store, { sources: [source('calendar')], now, runtime: { polling: 'scheduled' } });
  const calendar = health.sources[0];
  assert.equal(calendar.recovery.state, 'refreshing');
  assert.equal(calendar.job.lease_expires_at, now + 60_000);
  assert.equal(JSON.stringify(health).includes(claim.token), false);
  assert.equal(Object.hasOwn(calendar.job, 'lease_token'), false);
});

test('manual relay status never promises an automatic source or weather retry', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  run(store, 'calendar', now - 7 * cadence);
  const health = await buildHealth(store, { sources: [source('calendar')], now, runtime: { polling: 'manual' } });
  assert.equal(health.sources[0].freshness, 'dead');
  for (const value of health.sources) {
    assert.equal(value.recovery.state, 'manual');
    assert.equal(value.recovery.automatic, false);
    assert.equal(value.recovery.next_attempt_at, null);
  }
});

test('weather failure retains the forecast and exposes its actual retry cooldown', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.setSetting('WEATHER_FORECAST_JSON', JSON.stringify({ observed_at: now - 2 * cadence,
    attempted_at: now, forecast: [{ at: now, temp_c: 14 }], error: 'provider unavailable' }));
  const options = { sources: [], now, runtime: { polling: 'scheduled' } };
  const weather = (await buildHealth(store, options)).sources[0];
  assert.equal(weather.recovery.state, 'backoff');
  assert.equal(weather.recovery.next_attempt_at, now + 15 * 60_000);
  assert.equal(weather.freshness, 'stale');
  assert.equal((await buildHealth(store, { ...options, now: now + 15 * 60_000 })).sources[0].recovery.state, 'due');
});

test('a fresh weather forecast explains its scheduled refresh', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.setSetting('WEATHER_FORECAST_JSON', JSON.stringify({ observed_at: now, attempted_at: now,
    forecast: [{ at: now, temp_c: 14 }] }));
  const weather = (await buildHealth(store, { sources: [], now, runtime: { polling: 'scheduled' } })).sources[0];
  assert.equal(weather.condition, 'healthy');
  assert.equal(weather.freshness, 'live');
  assert.equal(weather.recovery.state, 'scheduled');
  assert.equal(weather.recovery.next_attempt_at, now + 30 * 60_000);
});

test('missing or corrupt weather is unchecked and queued for automatic recovery', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  for (const raw of [null, '{broken json', JSON.stringify({ observed_at: now, forecast: 'invalid' })]) {
    if (raw != null) store.setSetting('WEATHER_FORECAST_JSON', raw);
    const weather = (await buildHealth(store, { sources: [], now, runtime: { polling: 'scheduled' } })).sources[0];
    assert.equal(weather.condition, 'unknown');
    assert.equal(weather.freshness, 'unknown');
    assert.equal(weather.last_success_at, null);
    assert.equal(weather.recovery.state, 'due');
  }
});

test('a storage interruption updates health even when no failure receipt could be saved', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  run(store, 'calendar', now - 60_000);
  const claim = store.claimSource('calendar', { now, leaseNow: now });
  store.releaseSource('calendar', claim.token, now);
  store.recordJobResult('calendar', { startedAt: now, finishedAt: now, outcome: 'failed', cadenceMs: cadence,
    now, claimToken: claim.token, interrupted: true });
  const health = await buildHealth(store, { sources: [source('calendar')], now, runtime: { polling: 'scheduled' } });
  assert.equal(health.sources[0].last_run.outcome, 'ok');
  assert.equal(health.sources[0].condition, 'failing');
  assert.equal(health.sources[0].freshness, 'live');
  assert.equal(health.sources[0].recovery.state, 'backoff');
  assert.equal(health.summary.condition, 'attention');
  assert.equal(health.summary.healthy, 0);
});
