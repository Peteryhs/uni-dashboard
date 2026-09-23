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
