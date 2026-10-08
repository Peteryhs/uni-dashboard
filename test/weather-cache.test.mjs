import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { getCachedWeather, syncWeather } from '../apps/relay/src/weather-cache.mjs';

test('weather is fetched once for thirty minutes and stays readable during provider failure', async () => {
  const store = new SqliteStore(':memory:');
  const now = Date.parse('2026-09-23T12:00:00Z');
  let calls = 0;
  const fetchForecast = async () => { calls++; return new Map([[now, { temp_c: 18, precip_prob: 80 }]]); };
  await syncWeather(store, { now, fetchForecast });
  await syncWeather(store, { now: now + 60_000, fetchForecast });
  assert.equal(calls, 1);
  assert.equal((await getCachedWeather(store, { now })).forecast[0].precip_prob, 80);
  const broken = async () => { calls++; throw new Error('provider unavailable'); };
  assert.equal((await syncWeather(store, { now: now + 31 * 60_000, fetchForecast: broken })).status, 'failed');
  await syncWeather(store, { now: now + 32 * 60_000, fetchForecast: broken });
  assert.equal(calls, 2);
  assert.equal((await getCachedWeather(store, { now: now + 61 * 60_000 })).state, 'stale');
  store.close();
});

test('recent timestamps do not hide a missing or corrupt weather forecast', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const now = Date.parse('2026-10-07T12:00:00Z');
  let calls = 0;
  const fetchForecast = async () => { calls++; return new Map([[now, { temp_c: 18 }]]); };
  const invalid = ['{bad json', JSON.stringify({ observed_at: now }),
    JSON.stringify({ observed_at: now, forecast: [] }),
    JSON.stringify({ observed_at: now, forecast: 'invalid' }),
    JSON.stringify({ observed_at: 'invalid', forecast: [{ at: now, temp_c: 18 }] })];
  for (const [index, raw] of invalid.entries()) {
    store.setSetting('WEATHER_FORECAST_JSON', raw);
    assert.equal(await getCachedWeather(store, { now }), null);
    assert.equal((await syncWeather(store, { now, fetchForecast })).status, 'ready');
    assert.equal(calls, index + 1);
    assert.equal((await getCachedWeather(store, { now })).forecast[0].temp_c, 18);
  }
});

test('repairing an invalid forecast respects an existing provider retry cooldown', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const now = Date.parse('2026-10-07T12:00:00Z');
  store.setSetting('WEATHER_FORECAST_JSON', JSON.stringify({ observed_at: now, attempted_at: now,
    forecast: [], error: 'provider unavailable' }));
  let calls = 0;
  const fetchForecast = async () => { calls++; return new Map([[now + 15 * 60_000, { temp_c: 18 }]]); };
  assert.equal((await syncWeather(store, { now: now + 60_000, fetchForecast })).status, 'deferred');
  assert.equal(calls, 0);
  assert.equal(await getCachedWeather(store, { now }), null);
  assert.equal((await syncWeather(store, { now: now + 15 * 60_000, fetchForecast })).status, 'ready');
  assert.equal(calls, 1);
  assert.equal((await getCachedWeather(store, { now: now + 15 * 60_000 })).error, '');
});
