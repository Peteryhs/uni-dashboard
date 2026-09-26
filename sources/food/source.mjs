/**
 * Food services daily menu adapter.
 *
 * Known and accepted: this is a scrape of a Drupal page and it will break. The raw snapshot
 * archive exists so a future parser fix can be tested against the exact bytes that broke it.
 * An empty future menu day is valid-empty, not a failure.
 *
 * Two upstream behaviours shape how this polls, both measured on 2026-09-26:
 *
 * 1. The page sits behind Drupal's page cache and a CDN with `max-age=1800, public`. Neither is
 *    invalidated when a hall publishes or edits a menu, and the cache key is the URL including its
 *    query string. On 2026-09-26 the plain URL was still serving a render built the previous
 *    afternoon (`x-drupal-cache: HIT`, `last-modified` a day old) whose own date field read
 *    2026-09-25, so a human opening it saw Friday's menus. So every poll carries a unique parameter
 *    and reads a fresh render, and `renderedDate` is the receipt that says which day the bytes
 *    describe. Without this, the same poll can return whichever day the cache happens to hold.
 * 2. The page states the date it is showing in its own `name="date"` field, including on a date
 *    with nothing posted, so a mismatch against the requested date means the bytes are a cached
 *    render of another day. That mismatch is skipped, never written: it would label one day's
 *    dishes as another's.
 */
import { parseFoodPage, toMenuItems } from './parse.mjs';
import { zonedToEpoch, DEFAULT_TZ } from '../ics/parse.mjs';

export const id = 'uw-food-daily-menu';
export const shape = 'menu_item';
/** posts around 07:15 and updates around 14:30; 12 h keeps us inside both windows */
export const cadenceMs = 12 * 60 * 60 * 1000;
export const url = 'https://uwaterloo.ca/food-services/daily-menu';
export const needsSecret = false;
/** A poll covers one service date, so tombstones must stay inside that date (see store). */
export const scopeColumn = 'service_date';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

/** No fetch in this app is unbounded: a hung socket would stall the whole poll loop. */
const FETCH_TIMEOUT_MS = 10_000;

/** The page's own words for "this date has no menu" (verified live 2026-09-21 on a future date). */
const NO_MENU_TEXT = 'No daily menu found for the requested date';

export function todayInToronto(now) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(now))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

function endOfServiceDay(serviceDate, tz = DEFAULT_TZ) {
  const [y, mo, d] = serviceDate.split('-').map(Number);
  return zonedToEpoch(y, mo, d + 1, 3, 0, 0, tz); // 03:00 the next day, covers late dinners
}

export async function fetchRaw(ctx) {
  const now = ctx?.now ?? Date.now();
  const serviceDate = ctx?.date ?? todayInToronto(now);
  const baseUrl = ctx?.url ?? url;
  // The unique parameter is not decoration: it forces a fresh origin render instead of whatever
  // day the CDN and Drupal page caches are holding (see the note at the top of this file).
  const target = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}date=${serviceDate}&_=${now}`;
  const res = await fetch(target, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    body,
    bytes: body.length,
    requestedDate: serviceDate,
    renderedDate: renderedDate(body),
  };
}

/**
 * The date the page says it is showing, read off its own exposed filter field
 * (`<input type="date" name="date" ... value="YYYY-MM-DD">`). Marker scan, no DOM, no regex: this
 * runs inside the Worker's 10 ms CPU budget. Empty string when the field is absent, which a
 * redesign would cause, so callers must treat empty as "unknown" rather than "a different day".
 */
export function renderedDate(html) {
  const at = html.indexOf('name="date"');
  if (at === -1) return '';
  const tagEnd = html.indexOf('>', at);
  const tag = html.slice(at, tagEnd === -1 ? Math.min(html.length, at + 400) : tagEnd);
  const valueAt = tag.indexOf('value="');
  if (valueAt === -1) return '';
  const close = tag.indexOf('"', valueAt + 7);
  if (close === -1) return '';
  return tag.slice(valueAt + 7, close);
}

/**
 * Semantic failure matters more than HTTP failure. A menu page that suddenly has no outlet
 * headings at all is either a redesign or an error page, and either way the run must not
 * tombstone yesterday's rows.
 */
export function plausible(raw) {
  if (raw.status !== 200) return { ok: false, reason: `http ${raw.status}` };
  if (!/text\/html/i.test(raw.contentType)) return { ok: false, reason: `content-type ${raw.contentType}` };
  if (raw.body.indexOf('daily-menu') === -1) return { ok: false, reason: 'no daily-menu markers: not the menu page' };
  // The page names the day it rendered. When that is not the day we asked for, these bytes are a
  // cached render of another date: skipped, not failed, because nothing is broken and nothing may
  // be written from them. Skipping also leaves the failure counter alone, so a cache hiccup cannot
  // open the circuit breaker on a healthy source.
  if (raw.requestedDate && raw.renderedDate && raw.renderedDate !== raw.requestedDate) {
    return {
      ok: false,
      reason: `stale render: page shows ${raw.renderedDate}, asked for ${raw.requestedDate}`,
      skipped: true,
    };
  }
  // Out of term or on a date nothing was posted, the page still renders and says so in text. That
  // is valid-empty, not failed: reading it as a failure logs five failures on a closed day and
  // trips the circuit breaker, so a quiet week looks like a broken source.
  if (raw.body.indexOf(NO_MENU_TEXT) !== -1) {
    return { ok: false, reason: 'no menu published for this date', empty: true };
  }
  if (raw.body.indexOf('food_header_title') === -1 && raw.body.indexOf('food_item') === -1) {
    return { ok: false, reason: 'no outlet headings and no dishes: redesign or error page' };
  }
  return { ok: true, reason: '' };
}

export function parse(raw, ctx) {
  const parsed = parseFoodPage(raw.body);
  const serviceDate = ctx?.date ?? todayInToronto(ctx?.now ?? Date.now());
  const rows = toMenuItems(parsed, {
    sourceId: id,
    serviceDate,
    observedAt: ctx?.now ?? Date.now(),
    validUntil: endOfServiceDay(serviceDate),
    baseUrl: url,
  });
  return {
    rows,
    meta: {
      outlets: parsed.outlets.length,
      dishes: rows.length,
      service_date: serviceDate,
      page_date: raw.renderedDate ?? '',
    },
  };
}

export default { id, shape, cadenceMs, url, needsSecret, scopeColumn, fetchRaw, plausible, parse };
