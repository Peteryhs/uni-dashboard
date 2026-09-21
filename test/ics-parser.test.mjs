import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unfold, parseDateValue, zonedToEpoch, parseIcs, expandRecurrence } from '../sources/ics/parse.mjs';
import { portalIcs, learnIcs } from '../sources/ics/source.mjs';
import { validateRows } from '#contract/canonical.mjs';

const portal = readFileSync('fixtures/portal-sample.ics', 'utf8');
const learn = readFileSync('fixtures/learn-sample.ics', 'utf8');
const login = readFileSync('fixtures/login-page.html', 'utf8');

test('unfolds continuation lines, dropping only the marker whitespace', () => {
  // RFC 5545: the CRLF and ONE leading space are removed. Content spaces stay.
  const lines = unfold('SUMMARY:hello \r\n world\r\nDTSTART:2026\r\n');
  assert.deepEqual(lines.slice(0, 2), ['SUMMARY:hello world', 'DTSTART:2026']);
  // the marker whitespace is a continuation marker, not content
  assert.equal(unfold('SUMMARY:Hel\r\n lo\r\n')[0], 'SUMMARY:Hello');
});

test('zoned wall-clock converts to the right instant, checked by round trip', () => {
  const tz = 'America/Toronto';
  const ms = zonedToEpoch(2026, 9, 21, 14, 30, 0, tz);
  const back = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms));
  assert.match(back, /2026-09-21, 14:30/);
});

test('handles the three DTSTART forms a UW feed uses', () => {
  assert.equal(parseDateValue('20260921T143000Z').allDay, false);
  assert.equal(parseDateValue('20260921T143000').allDay, false);
  assert.equal(parseDateValue('20260921').allDay, true);
  // the same wall clock in Toronto is 4 h later in absolute time than the same clock in UTC
  const utc = parseDateValue('20260921T143000Z').at;
  const local = parseDateValue('20260921T143000', 'America/Toronto').at;
  assert.equal(local - utc, 4 * 3600 * 1000, 'EDT is UTC-4');
});

test('parses the portal sample into events with recurrence rules', () => {
  const { events, calendarName } = parseIcs(portal);
  assert.equal(events.length, 5);
  assert.match(calendarName, /Class Schedule/);
  assert.ok(events.some((e) => e.rrule?.includes('FREQ=WEEKLY')));
});

test('expands a weekly class across the window, not just once', () => {
  const { events } = parseIcs(portal);
  const ece150 = events.find((e) => e.summary === 'ECE 150 LEC 001');
  const occ = expandRecurrence(ece150, {
    windowStart: Date.UTC(2026, 8, 14),
    windowEnd: Date.UTC(2026, 9, 15),
  });
  assert.ok(occ.length >= 8, `expected a term's worth of occurrences, got ${occ.length}`);
  for (const o of occ) {
    assert.ok(o.start >= Date.UTC(2026, 8, 14));
    assert.ok(o.start <= Date.UTC(2026, 9, 15));
    assert.equal(o.end - o.start, 50 * 60 * 1000, 'each occurrence keeps the event duration');
  }
  const localHours = new Set(
    occ.map((o) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(o.start)),
    ),
  );
  assert.equal(localHours.size, 1, `all occurrences must sit at the same local time, got ${[...localHours]}`);

  // the weekday of each occurrence must be one the rule asked for. Without this assertion an
  // off-by-one day bug passed: every MWF class was emitted as Tue/Thu/Fri.
  const weekdays = new Set(
    occ.map((o) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', weekday: 'short' }).format(new Date(o.start))),
  );
  for (const wd of weekdays) {
    assert.ok(['Mon', 'Wed', 'Fri'].includes(wd), `ECE 150 is MO,WE,FR but an occurrence landed on ${wd}`);
  }
  assert.ok(weekdays.has('Mon') && weekdays.has('Wed') && weekdays.has('Fri'), `expected all three weekdays, got ${[...weekdays]}`);
});

test('unsupported recurrence fails loudly instead of silently dropping classes', () => {
  assert.throws(
    () => expandRecurrence({ uid: 'x', start: Date.UTC(2026, 8, 14), end: Date.UTC(2026, 8, 14, 1), rrule: 'FREQ=MONTHLY;BYDAY=1MO' }, { windowStart: 0, windowEnd: 1 }),
    /unsupported RRULE/,
  );
});

test('an expired token that returns the login page is caught before parsing', () => {
  const verdict = portalIcs.plausible({ status: 200, contentType: 'text/html; charset=UTF-8', body: login, bytes: login.length });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.credential, true, 'the run must be flagged as a credential problem, not a generic failure');
});

test('401 and a missing secret are both handled without throwing', () => {
  assert.equal(portalIcs.plausible({ status: 401, contentType: '', body: '', bytes: 0 }).credential, true);
  const missing = portalIcs.plausible({ status: 0, contentType: '', body: '', bytes: 0, missingSecret: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.skipped, true);
});

test('classification separates classes, deadlines and exams', () => {
  const dl = learnIcs.classify({ summary: 'ECE 150 - Assignment 3 due', description: '' });
  assert.equal(dl, 'deadline');
  assert.equal(learnIcs.classify({ summary: 'ECE 105 Midterm Exam (in class)', description: '' }), 'exam');
  assert.equal(portalIcs.classify({ summary: 'ECE 150 LEC 001', description: '' }), 'class');
});

test('LEARN rows land as deadlines and satisfy the canonical contract', () => {
  const rows = learnIcs.parse({ status: 200, contentType: 'text/calendar', body: learn, bytes: learn.length }, { now: Date.UTC(2026, 8, 21) }).rows;
  validateRows('timeline_event', rows);
  assert.ok(rows.some((r) => r.kind === 'deadline'));
  assert.ok(rows.some((r) => r.kind === 'exam'));
  const ids = new Set(rows.map((r) => r.external_id));
  assert.equal(ids.size, rows.length);
});

test('expanded occurrences get unique external ids', () => {
  const rows = portalIcs.parse({ status: 200, contentType: 'text/calendar', body: portal, bytes: portal.length }, { now: Date.UTC(2026, 8, 14) }).rows;
  const ids = new Set(rows.map((r) => r.external_id));
  assert.equal(ids.size, rows.length, 'a repeated occurrence id would collapse rows on upsert');
});
