/**
 * Food services daily menu adapter.
 *
 * Known and accepted: this is a scrape of a Drupal page and it will break. The raw snapshot
 * archive exists so a future parser fix can be tested against the exact bytes that broke it.
 * An empty future menu day is valid-empty, not a failure.
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
  const target = ctx?.date ? `${url}?date=${ctx.date}` : url;
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
  };
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
  return { rows, meta: { outlets: parsed.outlets.length, dishes: rows.length, service_date: serviceDate } };
}

export default { id, shape, cadenceMs, url, needsSecret, scopeColumn, fetchRaw, plausible, parse };
