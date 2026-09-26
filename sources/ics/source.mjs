/**
 * ICS feed adapter. Used twice in v1: the Portal feed (classes and exams) and the LEARN feed
 * (deadlines). One adapter, two configurations, because the shape is identical.
 *
 * The token lives in the URL, so the URL is a secret: it is read from the environment, never
 * logged, and the run records only its sha256. When it rotates the feed starts returning 401 or
 * HTML, and the plausibility check catches the HTML case, which is the dangerous one.
 */
import { parseIcs, expandRecurrence, DEFAULT_TZ } from './parse.mjs';
import { classifyLearnEvent } from './learn-classification.mjs';
import { parseRetryAfter } from '../../apps/relay/src/retry.mjs';

export const shape = 'timeline_event';
export const cadenceMs = 15 * 60 * 1000;
export const needsSecret = true;

const UA = 'uni-dashboard/0.1 (+personal dashboard)';

/**
 * Node module names are assembled at runtime so a bundler cannot fold the concatenation back into
 * a static specifier and pull the module into a Worker bundle.
 */
function nodeSpecifier(name) {
  return 'node:' + name;
}

/** No fetch in this app is unbounded: a hung socket would stall the whole poll loop. */
const FETCH_TIMEOUT_MS = 10_000;

const DEADLINE_RE = /\b(due|deadline|submit|submission|assignment|quiz|midterm|exam|test|lab report)\b/i;
const EXAM_RE = /\b(midterm|final exam|exam)\b/i;

export function makeIcsSource({
  id,
  role,
  envVar,
  fallbackEnvVars = [],
  tz = DEFAULT_TZ,
  windowDays = 60,
  cadenceMs: sourceCadenceMs = cadenceMs,
  rateLimitMinMs = 30 * 60 * 1000,
  rateLimitMaxMs = 48 * 60 * 60 * 1000,
}) {
  return {
    id,
    shape,
    role, // 'portal' -> class|exam, 'learn' -> deadline
    cadenceMs: sourceCadenceMs,
    rateLimitMinMs,
    rateLimitMaxMs,
    needsSecret: true,
    envVar,
    tz,
    windowDays,
    // A calendar with no upcoming rows is normal after a term ends. It is a failed/implausible
    // response when rows saved from an earlier good fetch still lie in the future, though.
    failOnEmptyWhenFutureRows: true,
    // A nonempty feed that resolves to no upcoming rows may contain explicit cancellations.
    // A suddenly empty feed is less trustworthy, so keep the last good rows in that case.
    tombstoneOnEmpty: (parsed) => parsed.meta.events > 0,
    url() {
      const v = process.env[envVar] || fallbackEnvVars.map((k) => process.env[k]).find(Boolean);
      if (!v) return null;
      return v;
    },
    async fetchRaw() {
      const target = this.url();
      if (!target) {
        return { status: 0, contentType: '', body: '', bytes: 0, missingSecret: true };
      }
      // file: targets exist so fixtures can exercise this path before the real tokens exist.
      // The specifier is built at runtime on purpose: a literal import('node:fs/promises') is
      // resolved by the bundler at build time, which is how a Worker bundle ends up carrying a
      // node:fs it can never call. Only the fixture path on Node ever reaches this branch.
      if (target.startsWith('file:')) {
        const { readFile } = await import(nodeSpecifier('fs/promises'));
        const body = await readFile(new URL(target), 'utf8');
        return { status: 200, contentType: 'text/calendar', body, bytes: body.length };
      }
      const res = await fetch(target, {
        headers: { 'user-agent': UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const body = await res.text();
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body,
        bytes: body.length,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      };
    },
    plausible(raw) {
      if (raw.missingSecret) return { ok: false, reason: `missing ${envVar}`, skipped: true };
      if (raw.status === 401 || raw.status === 403) return { ok: false, reason: `credential rejected (http ${raw.status})`, credential: true };
      if (raw.status !== 200) return { ok: false, reason: `http ${raw.status}` };
      if (/text\/html/i.test(raw.contentType) || raw.body.slice(0, 400).indexOf('<!DOCTYPE') !== -1 || raw.body.slice(0, 400).indexOf('<html') !== -1) {
        return { ok: false, reason: 'html body: not authenticated', credential: true };
      }
      if (raw.body.indexOf('BEGIN:VCALENDAR') === -1) return { ok: false, reason: 'no BEGIN:VCALENDAR' };
      return { ok: true, reason: '' };
    },
    classify(event) {
      const title = String(event.summary ?? '');
      if (this.role === 'learn') return classifyLearnEvent(title);
      // The Portal description often contains unrelated links (such as a university "due dates"
      // page). Classify the calendar title only, or those words turn administrative dates into tasks.
      const text = title;
      if (EXAM_RE.test(text)) return 'exam';
      if (DEADLINE_RE.test(text)) return 'deadline';
      return 'class';
    },
    parse(raw, ctx) {
      const now = ctx?.now ?? Date.now();
      const { events } = parseIcs(raw.body, { tz: this.tz });
      const windowStart = now - 12 * 60 * 60 * 1000;
      const windowEnd = now + this.windowDays * 86400000;
      const rowsById = new Map();
      const masters = events.filter((event) => event.recurrenceId == null);
      const overrides = events.filter((event) => event.recurrenceId != null);
      const cancelledSeries = new Set(masters.filter((event) => event.status.toUpperCase() === 'CANCELLED').map((event) => event.uid));
      const overridden = new Set(overrides.map((event) => `${event.uid}#${event.recurrenceId}`));

      const addOccurrence = (event, occ, originalStart) => {
        if (!Number.isFinite(occ.start) || !Number.isFinite(occ.end)) {
          throw new Error(`invalid occurrence date on ${event.uid}`);
        }
        if (occ.end < windowStart || occ.start > windowEnd) return;
        const externalId = `${event.uid}#${new Date(originalStart).toISOString()}`;
        rowsById.set(externalId, {
          source_id: this.id,
          external_id: externalId,
          uid: event.uid,
          observed_at: now,
          valid_until: now + 24 * 60 * 60 * 1000,
          kind: this.classify(event),
          title: event.summary || '(untitled)',
          // Portal puts the course name in DESCRIPTION ("Fundamentals of Programming") and the room
          // in LOCATION. LEARN is the other way round: LOCATION holds the course and DESCRIPTION
          // holds instructions plus the links, which the card builder parses out of `description`.
          subtitle: this.role === 'portal' ? (event.description ?? '').trim().slice(0, 120) : '',
          location: event.location ?? '',
          all_day: Boolean(event.allDay),
          starts_at: occ.start,
          ends_at: occ.end,
          url: event.url ?? '',
          description: event.description ?? '',
        });
      };

      for (const event of masters) {
        if (cancelledSeries.has(event.uid)) continue;
        const excluded = new Set(event.exdates);
        const occurrences = expandRecurrence(event, {
          windowStart,
          windowEnd,
          tz: this.tz,
        });
        for (const occ of occurrences) {
          if (excluded.has(occ.start) || overridden.has(`${event.uid}#${occ.start}`)) continue;
          addOccurrence(event, occ, occ.start);
        }
      }
      for (const event of overrides) {
        if (cancelledSeries.has(event.uid) || event.status.toUpperCase() === 'CANCELLED') continue;
        addOccurrence(event, { start: event.start, end: event.end }, event.recurrenceId);
      }
      const rows = [...rowsById.values()];
      return {
        rows,
        meta: {
          calendar: raw.body.match(/X-WR-CALNAME:(.*)/)?.[1]?.trim() ?? '',
          events: events.length,
          cancelled: events.filter((event) => event.status.toUpperCase() === 'CANCELLED').length,
          expanded: rows.length,
        },
      };
    },
  };
}

export const portalIcs = makeIcsSource({
  id: 'uw-portal-ics',
  role: 'portal',
  envVar: 'PORTAL_ICS_URL',
  fallbackEnvVars: ['GOOGLE_CALENDAR_ICS_URL', 'SCHEDULE_ICS_URL'],
  // Google Calendar subscriptions change slowly. Polling every 15 minutes triggered Google's
  // per-IP throttle during normal use, so the Worker now checks this source at most four times a
  // day and gives repeated 429s progressively longer quiet periods.
  cadenceMs: 6 * 60 * 60 * 1000,
  rateLimitMinMs: 12 * 60 * 60 * 1000,
  rateLimitMaxMs: 7 * 24 * 60 * 60 * 1000,
});
export const learnIcs = makeIcsSource({ id: 'uw-learn-ics', role: 'learn', envVar: 'LEARN_ICS_URL' });
