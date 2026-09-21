/**
 * ICS feed adapter. Used twice in v1: the Portal feed (classes and exams) and the LEARN feed
 * (deadlines). One adapter, two configurations, because the shape is identical.
 *
 * The token lives in the URL, so the URL is a secret: it is read from the environment, never
 * logged, and the run records only its sha256. When it rotates the feed starts returning 401 or
 * HTML, and the plausibility check catches the HTML case, which is the dangerous one.
 */
import { parseIcs, expandRecurrence, DEFAULT_TZ } from './parse.mjs';

export const shape = 'timeline_event';
export const cadenceMs = 15 * 60 * 1000;
export const needsSecret = true;

const UA = 'uni-dashboard/0.1 (+personal dashboard)';

const DEADLINE_RE = /\b(due|deadline|submit|submission|assignment|quiz|midterm|exam|test|lab report)\b/i;
const EXAM_RE = /\b(midterm|final exam|exam)\b/i;

export function makeIcsSource({ id, role, envVar, tz = DEFAULT_TZ, windowDays = 60 }) {
  return {
    id,
    shape,
    role, // 'portal' -> class|exam, 'learn' -> deadline
    cadenceMs,
    needsSecret: true,
    envVar,
    tz,
    windowDays,
    url() {
      const v = process.env[envVar];
      if (!v) return null;
      return v;
    },
    async fetchRaw() {
      const target = this.url();
      if (!target) {
        return { status: 0, contentType: '', body: '', bytes: 0, missingSecret: true };
      }
      // file: targets exist so fixtures can exercise this path before the real tokens exist.
      // The import is dynamic and inside the branch, so the module stays runtime-neutral and a
      // Worker bundle never pulls in node:fs.
      if (target.startsWith('file:')) {
        const { readFile } = await import('node:fs/promises');
        const body = await readFile(new URL(target), 'utf8');
        return { status: 200, contentType: 'text/calendar', body, bytes: body.length };
      }
      const res = await fetch(target, { headers: { 'user-agent': UA }, redirect: 'follow' });
      const body = await res.text();
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body,
        bytes: body.length,
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
      const text = `${event.summary} ${event.description ?? ''}`;
      if (this.role === 'learn') return EXAM_RE.test(text) ? 'exam' : 'deadline';
      if (EXAM_RE.test(text)) return 'exam';
      if (DEADLINE_RE.test(text)) return 'deadline';
      return 'class';
    },
    parse(raw, ctx) {
      const now = ctx?.now ?? Date.now();
      const { events } = parseIcs(raw.body, { tz: this.tz });
      const windowStart = now - 12 * 60 * 60 * 1000;
      const windowEnd = now + this.windowDays * 86400000;
      const rows = [];
      let expanded = 0;
      for (const event of events) {
        const occurrences = expandRecurrence(event, {
          windowStart,
          windowEnd,
          tz: this.tz,
        });
        for (const occ of occurrences) {
          expanded += 1;
          const startsAt = occ.start;
          const iso = new Date(startsAt).toISOString();
          rows.push({
            source_id: this.id,
            external_id: `${event.uid}#${iso}`,
            observed_at: now,
            valid_until: now + 24 * 60 * 60 * 1000,
            kind: this.classify(event),
            title: event.summary || '(untitled)',
            subtitle: '',
            location: event.location ?? '',
            all_day: Boolean(event.allDay),
            starts_at: startsAt,
            ends_at: occ.end,
            url: event.url ?? '',
          });
        }
      }
      return {
        rows,
        meta: {
          calendar: raw.body.match(/X-WR-CALNAME:(.*)/)?.[1]?.trim() ?? '',
          events: events.length,
          expanded,
        },
      };
    },
  };
}

export const portalIcs = makeIcsSource({ id: 'uw-portal-ics', role: 'portal', envVar: 'PORTAL_ICS_URL' });
export const learnIcs = makeIcsSource({ id: 'uw-learn-ics', role: 'learn', envVar: 'LEARN_ICS_URL' });
