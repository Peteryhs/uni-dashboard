/** Shared weather snapshot: clients and recommendation reads never call the provider. */
import { hourlyForecast } from './weather.mjs';

const KEY = 'WEATHER_FORECAST_JSON';
const REFRESH_MS = 30 * 60_000;
const RETRY_MS = 15 * 60_000;

function parse(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export async function getCachedWeather(store, { now = Date.now() } = {}) {
  const saved = parse(await store.getSetting(KEY));
  if (!saved?.forecast?.length || !Number.isFinite(saved.observed_at)) return null;
  const age = now - saved.observed_at;
  return { observed_at: saved.observed_at, forecast: saved.forecast,
    state: age <= REFRESH_MS ? 'live' : age <= 2 * REFRESH_MS ? 'ageing' : age <= 6 * REFRESH_MS ? 'stale' : 'dead',
    error: saved.error || '' };
}

export async function syncWeather(store, { now = Date.now(), fetchForecast = hourlyForecast } = {}) {
  const previous = parse(await store.getSetting(KEY));
  if (previous?.observed_at && now - previous.observed_at < REFRESH_MS) return { status: 'ready', cached: true };
  if (previous?.attempted_at && now - previous.attempted_at < RETRY_MS) return { status: 'deferred', cached: true };
  // Persist the retry lease before network I/O, including failure and overlapping cron runs.
  await store.setSetting(KEY, JSON.stringify({ ...previous, attempted_at: now }));
  try {
    const hours = await fetchForecast(now);
    const forecast = [...hours].filter(([at]) => at >= now - 3600_000).slice(0, 48).map(([at, value]) => ({ at, ...value }));
    if (!forecast.length) throw new Error('Weather provider returned no forecast hours');
    await store.setSetting(KEY, JSON.stringify({ observed_at: now, attempted_at: now, forecast }));
    return { status: 'ready' };
  } catch (error) {
    await store.setSetting(KEY, JSON.stringify({ ...previous, attempted_at: now, error: error.message }));
    return { status: 'failed', error: error.message };
  }
}
