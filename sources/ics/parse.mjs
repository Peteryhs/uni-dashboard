/**
 * ICS (RFC 5545) reader: line unfolding, VEVENT extraction, DTSTART/DTEND in the three forms a
 * UW feed actually uses, and the two recurrence rules that matter for a class schedule.
 *
 * Design rules it takes from the spec:
 *  - A 200 with text/html means "not authenticated" on these paths. plausible() is what stops
 *    a login page from being parsed as data and, worse, from tombstoning a real timetable.
 *  - Recurrence is expanded server-side so clients need no RRULE engine and can work offline.
 *  - No dependency, no DOM, no tz database: Intl does the zone arithmetic (full ICU in Node
 *    and available in Workers).
 */

export const DEFAULT_TZ = 'America/Toronto';

/** RFC 5545 line unfolding: CRLF followed by a space or tab continues the previous line. */
export function unfold(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const raw = normalized.split('\n');
  const out = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Convert a wall-clock time in a named IANA zone to epoch ms, using Intl for the offset. */
export function zonedToEpoch(y, mo, d, h, mi, s, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes converge: guess offset at the naive instant, then at the corrected instant.
  let guess = naive;
  for (let pass = 0; pass < 2; pass++) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const asZone = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    const offset = asZone - guess;
    guess = naive - offset;
  }
  return guess;
}

/** Parse one DTSTART/DTEND value. Returns {at, allDay}. */
export function parseDateValue(value, tz = DEFAULT_TZ) {
  const v = value.trim();
  if (/^\d{8}$/.test(v)) {
    // VALUE=DATE, floating date
    const y = Number(v.slice(0, 4));
    const mo = Number(v.slice(4, 6));
    const d = Number(v.slice(6, 8));
    return { at: zonedToEpoch(y, mo, d, 0, 0, 0, tz), allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return { at: NaN, allDay: false };
  const [, y, mo, d, h, mi, s, z] = m;
  if (z === 'Z') {
    return { at: Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)), allDay: false };
  }
  return {
    at: zonedToEpoch(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s), tz),
    allDay: false,
  };
}

/** Unescape the values ICS escapes (\n, \, \; , \,) */
export function unescapeText(s) {
  return s.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function parseProp(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  let value = line.slice(colon + 1);
  const segments = head.split(';');
  const name = segments[0].toUpperCase();
  const params = {};
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq !== -1) params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }
  if (params.VALUE === 'DATE') {
    // keep as-is; parseDateValue handles both forms
  }
  value = unescapeText(value);
  return { name, params, value };
}

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/**
 * Expand a recurrence for a bounded window. Supports FREQ=DAILY and FREQ=WEEKLY with
 * INTERVAL / COUNT / UNTIL / BYDAY, which is what a class timetable uses. Anything more exotic
 * throws, loudly, rather than silently dropping classes.
 *
 * The subtlety that bit this once: BYDAY is a set within a week. Stepping the cursor a week at a
 * time and testing its single weekday emits only the first weekday of each week (a MWF class
 * produced 5 occurrences per term instead of 14). So the cursor walks day by day and a day is
 * included when its week index matches INTERVAL and its weekday is in BYDAY.
 */
export function expandRecurrence(event, { windowStart, windowEnd, tz = DEFAULT_TZ, maxPerEvent = 400 }) {
  const rule = event.rrule;
  if (!rule) return [{ start: event.start, end: event.end }];

  const parts = Object.fromEntries(
    rule.split(';').map((kv) => {
      const [k, v] = kv.split('=');
      return [k.toUpperCase(), (v ?? '').toUpperCase()];
    }),
  );
  const supportedParts = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY']);
  const unsupportedPart = Object.keys(parts).find((part) => !supportedParts.has(part));
  if (unsupportedPart) {
    throw new Error(`unsupported RRULE ${unsupportedPart} on ${event.uid}`);
  }
  const freq = parts.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY') {
    throw new Error(`unsupported RRULE FREQ=${freq} on ${event.uid}`);
  }
  const interval = Math.max(1, Number(parts.INTERVAL ?? 1) || 1);
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  const until = parts.UNTIL ? parseDateValue(parts.UNTIL, tz).at : null;
  const byDayValues = parts.BYDAY?.split(',') ?? [];
  if (byDayValues.some((day) => !Object.hasOwn(WEEKDAYS, day))) {
    throw new Error(`unsupported RRULE BYDAY=${parts.BYDAY} on ${event.uid}`);
  }
  const byDay = parts.BYDAY
    ? new Set(
        byDayValues
          .map((k) => WEEKDAYS[k])
      )
    : null;

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const hms = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(event.start));
  const [hh, mm, ss] = hms.split(':').map(Number);

  const localDate = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { y: Number(p.year), mo: Number(p.month), d: Number(p.day) };
  };

  const startLocal = localDate(event.start);
  const startCursor = Date.UTC(startLocal.y, startLocal.mo - 1, startLocal.d);
  const duration = event.end - event.start;
  const DAY = 86400000;

  const out = [];
  let matched = 0;
  for (let dayIndex = 0; dayIndex <= 4000; dayIndex++) {
    const cursor = startCursor + dayIndex * DAY;
    // startCursor is a UTC-naive date standing in for a local calendar date, so the day's
    // year/month/day/weekday must be read back as UTC. Reading it through the zone shifts it a day
    // backwards (UTC midnight is the previous evening in Toronto), which silently moved every
    // Monday/Wednesday/Friday class to Tuesday/Thursday/Friday.
    const cursorDate = new Date(cursor);
    const dow = cursorDate.getUTCDay();
    const weekIndex = Math.floor(dayIndex / 7);
    const matches =
      freq === 'DAILY'
        ? dayIndex % interval === 0
        : weekIndex % interval === 0 && (byDay ? byDay.has(dow) : dow === new Date(startCursor).getUTCDay());

    if (!matches) continue;

    const y = cursorDate.getUTCFullYear();
    const mo = cursorDate.getUTCMonth() + 1;
    const d = cursorDate.getUTCDate();
    const at = zonedToEpoch(y, mo, d, hh, mm, ss, tz);
    if (at > windowEnd) break;
    if (until != null && at > until) break;
    if (at < event.start) continue;
    matched += 1;
    if (count != null && matched > count) break;
    if (at < windowStart) continue;

    out.push({ start: at, end: at + duration });
    if (out.length >= maxPerEvent) break;
  }
  return out;
}

/**
 * Parse a whole feed.
 * @returns {{calendarName: string, events: Array<object>, vtimezone: string}}
 */
export function parseIcs(text, { tz = DEFAULT_TZ } = {}) {
  if (!text || text.indexOf('BEGIN:VCALENDAR') === -1) {
    throw new Error('not an ICS document: missing BEGIN:VCALENDAR');
  }
  const lines = unfold(text);
  const events = [];
  let calendarName = '';
  let vtimezone = '';
  let inEvent = false;
  let cur = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      cur = { uid: '', summary: '', location: '', description: '', status: '', url: '', rrule: null, recurrenceId: null, exdates: [], tz: tz };
      continue;
    }
    if (line === 'END:VEVENT') {
      inEvent = false;
      if (cur) {
        if (!cur.uid) cur.uid = `${cur.summary}|${cur.start ?? 0}`;
        events.push(cur);
      }
      cur = null;
      continue;
    }
    if (line === 'BEGIN:VTIMEZONE') {
      vtimezone = 'present';
      continue;
    }
    const prop = parseProp(line);
    if (!prop) continue;

    if (!inEvent) {
      if (prop.name === 'X-WR-CALNAME') calendarName = prop.value;
      continue;
    }
    switch (prop.name) {
      case 'UID':
        cur.uid = prop.value;
        break;
      case 'SUMMARY':
        cur.summary = prop.value;
        break;
      case 'LOCATION':
        cur.location = prop.value;
        break;
      case 'DESCRIPTION':
        cur.description = prop.value;
        break;
      case 'STATUS':
        cur.status = prop.value;
        break;
      case 'URL':
        cur.url = prop.value;
        break;
      case 'RRULE':
        cur.rrule = prop.value;
        break;
      case 'RDATE':
      case 'EXRULE':
        throw new Error(`unsupported ${prop.name} on ${cur.uid}`);
      case 'EXDATE': {
        const zone = prop.params.TZID || tz;
        for (const value of prop.value.split(',')) {
          const at = parseDateValue(value, zone).at;
          if (!Number.isFinite(at)) throw new Error(`invalid EXDATE on ${cur.uid}`);
          cur.exdates.push(at);
        }
        break;
      }
      case 'RECURRENCE-ID': {
        if (prop.params.RANGE) throw new Error(`unsupported RECURRENCE-ID RANGE on ${cur.uid}`);
        const zone = prop.params.TZID || tz;
        cur.recurrenceId = parseDateValue(prop.value, zone).at;
        if (!Number.isFinite(cur.recurrenceId)) throw new Error(`invalid RECURRENCE-ID on ${cur.uid}`);
        break;
      }
      case 'DTSTART': {
        const zone = prop.params.TZID || tz;
        const { at, allDay } = parseDateValue(prop.value, zone);
        cur.start = at;
        cur.allDay = allDay;
        cur.tz = zone;
        break;
      }
      case 'DTEND': {
        const zone = prop.params.TZID || tz;
        cur.end = parseDateValue(prop.value, zone).at;
        break;
      }
      case 'DURATION': {
        const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(prop.value);
        if (m) {
          const ms = (Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60) * 1000;
          cur.durationMs = ms;
          cur.end = (cur.start ?? 0) + ms;
        }
        break;
      }
      default:
        break;
    }
  }

  for (const e of events) {
    if (e.start == null) e.start = NaN;
    if (e.end == null || Number.isNaN(e.end)) e.end = e.start + (e.allDay ? 86400000 : 3600000);
  }
  return { calendarName, events, vtimezone };
}
