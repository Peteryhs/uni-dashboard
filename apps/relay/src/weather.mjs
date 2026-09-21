/**
 * Weather for the next class hour. Open-Meteo, no key, CORS `*`, so in the shipped build the
 * *client* fetches this and the server does nothing. It is here because the server needs it for
 * the same card, and because proving the join is worth more than asserting it.
 *
 * Only hourly fields that exist are requested (verified 2026-09-21): temperature_2m,
 * apparent_temperature, precipitation_probability, precipitation, wind_speed_10m.
 */
export const id = 'open-meteo';
export const cadenceMs = 15 * 60 * 1000;

const LAT = 43.4692; // REV / north campus
const LON = -80.5424;
const TZ = 'America/Toronto';

const cache = { at: 0, byHour: new Map(), raw: null };

/** No fetch in this app is unbounded: a hung socket would stall the whole poll loop. */
const FETCH_TIMEOUT_MS = 10_000;

export async function hourlyForecast(now = Date.now(), { force = false } = {}) {
  if (!force && now - cache.at < cadenceMs && cache.byHour.size) return cache.byHour;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m` +
    `&forecast_days=2&timezone=${encodeURIComponent(TZ)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`open-meteo http ${res.status}`);
  const j = await res.json();
  const byHour = new Map();
  const h = j.hourly ?? {};
  for (let i = 0; i < (h.time?.length ?? 0); i += 1) {
    // hourly.time is local wall-clock "2026-09-21T14:00"; convert to epoch using the feed's own tz
    const key = localHourToEpoch(h.time[i], j.timezone ?? TZ);
    byHour.set(key, {
      temp_c: h.temperature_2m?.[i] ?? null,
      feels_c: h.apparent_temperature?.[i] ?? null,
      precip_prob: h.precipitation_probability?.[i] ?? null,
      precip_mm: h.precipitation?.[i] ?? null,
      wind_kmh: h.wind_speed_10m?.[i] ?? null,
    });
  }
  cache.at = now;
  cache.byHour = byHour;
  cache.raw = j;
  return byHour;
}

function localHourToEpoch(s, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return NaN;
  const [, y, mo, d, hh, mi] = m.map(Number);
  const naive = Date.UTC(y, mo - 1, d, hh, mi);
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, p.value]),
    );
    const asZone = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
    );
    guess = naive - (asZone - guess);
  }
  return guess;
}

/** Nearest hour at or before `at`, so a 13:37 walk uses the 13:00 forecast row. */
export function at(byHour, when) {
  if (!byHour?.size) return null;
  const hour = Math.floor(when / 3600000) * 3600000;
  for (let i = 0; i < 4; i++) {
    const row = byHour.get(hour - i * 3600000);
    if (row) return { hour: hour - i * 3600000, ...row };
  }
  return null;
}

/** Worth showing or not: a card that always says "18 C" is noise. */
export function worthShowing(w) {
  if (!w) return { show: false, reason: 'no forecast' };
  if ((w.precip_prob ?? 0) >= 30) return { show: true, reason: 'rain risk' };
  if ((w.feels_c ?? 20) <= 5) return { show: true, reason: 'cold' };
  if ((w.feels_c ?? 20) >= 27) return { show: true, reason: 'heat' };
  if ((w.wind_kmh ?? 0) >= 40) return { show: true, reason: 'wind' };
  return { show: false, reason: 'nothing notable' };
}

export default { id, cadenceMs, hourlyForecast, at, worthShowing };
