import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { buildCalendar, calendarOptions } from '../apps/relay/src/calendar.mjs';
import { validateCalendar } from '#contract/calendar.mjs';
import { validateRow } from '#contract/canonical.mjs';

const now = Date.parse('2026-03-08T12:00:00Z');
const base = { observed_at: now, valid_until: now + 900_000, all_day: false };

function seed() {
  const store = new SqliteStore(':memory:');
  store.upsertRows('timeline_event', [
    { ...base, source_id: 'uw-portal-ics', external_id: 'class-1', kind: 'class', title: 'ECE 150 LEC 001', location: 'E7 2317', starts_at: Date.parse('2026-03-08T13:00:00Z'), ends_at: Date.parse('2026-03-08T14:00:00Z') },
    { ...base, source_id: 'uw-learn-ics', external_id: 'due-1', kind: 'deadline', title: 'ECE 150 - Assignment 3 - Due [Sec 002 Groups 1-20]', location: 'ECE 150 - Winter 2026', description: 'Upload your work.\nDropbox: https://learn.uwaterloo.ca/d2l/lms/dropbox/submit', starts_at: Date.parse('2026-03-09T03:30:00Z'), ends_at: Date.parse('2026-03-09T03:30:00Z') },
    { ...base, source_id: 'user-office-hours', external_id: 'office-1', kind: 'office_hours', title: 'ECE 150 · Professor hours', location: 'DC 1350', starts_at: Date.parse('2026-03-09T14:00:00Z'), ends_at: Date.parse('2026-03-09T15:00:00Z') },
    { ...base, source_id: 'uw-learn-ics', external_id: 'later', kind: 'deadline', title: 'Later task', starts_at: Date.parse('2026-03-10T04:00:00Z'), ends_at: Date.parse('2026-03-10T04:00:00Z') },
  ]);
  return store;
}

test('calendar combines schedule, LEARN and custom office hours into Toronto days across DST', async () => {
  const calendar = await buildCalendar(seed(), { start: '2026-03-08', days: 2, now });
  assert.deepEqual(calendar.days.map((day) => [day.date, day.events.map((event) => event.category)]), [
    ['2026-03-08', ['class', 'deadline']],
    ['2026-03-09', ['office_hours']],
  ]);
  assert.equal(calendar.end, '2026-03-10');
  assert.equal(calendar.count, 3);
  assert.equal(calendar.days[0].events[1].course, 'ECE 150');
  assert.match(calendar.days[0].events[1].url, /dropbox/);
  assert.equal(calendar.days[0].events[1].group_scope.section, 2);
  assert.equal(calendar.days[1].events[0].source_label, 'Custom');
  assert.deepEqual(validateCalendar(calendar), calendar);
});

test('calendar applies section and group scope on the backend without hiding classes or office hours', async () => {
  const calendar = await buildCalendar(seed(), { start: '2026-03-08', days: 2, section: 2, group: 25, now });
  assert.deepEqual(calendar.days.flatMap((day) => day.events.map((event) => event.category)), ['class', 'office_hours']);
});

test('calendar prefers LEARN over a subscribed schedule copy and labels personal events honestly', async () => {
  const store = seed();
  const dueStart = Date.parse('2026-03-09T03:30:00Z');
  store.upsertRows('timeline_event', [
    { ...base, source_id: 'uw-portal-ics', external_id: 'google-copy', uid: 'same-uid', kind: 'class', title: 'ECE 150 - Assignment 3', starts_at: dueStart, ends_at: dueStart },
    { ...base, source_id: 'uw-learn-ics', external_id: 'learn-copy', uid: 'same-uid', kind: 'deadline', title: 'ECE 150 - Assignment 3 - Due', starts_at: dueStart, ends_at: dueStart },
    { ...base, source_id: 'uw-portal-ics', external_id: 'personal', kind: 'class', title: 'Dentist appointment', starts_at: Date.parse('2026-03-08T15:00:00Z'), ends_at: Date.parse('2026-03-08T16:00:00Z') },
  ]);
  const calendar = await buildCalendar(store, { start: '2026-03-08', days: 1, now });
  assert.equal(calendar.days[0].events.find((event) => event.occurrence_id === 'google-copy'), undefined);
  assert.equal(calendar.days[0].events.find((event) => event.occurrence_id === 'learn-copy')?.category, 'deadline');
  assert.equal(calendar.days[0].events.find((event) => event.occurrence_id === 'personal')?.category, 'event');
});

test('legacy LEARN stream and administrative dates are normalized as events, not due items', async () => {
  const store = new SqliteStore(':memory:');
  store.upsertRows('timeline_event', [
    { ...base, source_id: 'uw-learn-ics', external_id: 'cive-stream', kind: 'deadline', title: '8 Stream CIVE, SYDE - Mandatory Résumé Review Event', location: 'Claudette Millar Hall (CMH) - Great Hall (CFE – Fall 2026)', description: 'You are required to attend the session designated for your program and stream.', starts_at: Date.parse('2026-03-08T13:00:00Z'), ends_at: Date.parse('2026-03-08T15:00:00Z') },
    { ...base, source_id: 'uw-learn-ics', external_id: 'che-stream', kind: 'deadline', title: '8 Stream CHE, NANO - Mandatory Résumé Review Event', location: 'Claudette Millar Hall (CMH) - Great Hall (CFE – Fall 2026)', starts_at: Date.parse('2026-03-08T15:00:00Z'), ends_at: Date.parse('2026-03-08T17:00:00Z') },
    { ...base, source_id: 'uw-portal-ics', external_id: 'nfa-hold', kind: 'deadline', title: 'Not Fees Arranged (NFA) holds applied', description: 'Learn more about due dates.', starts_at: Date.parse('2026-03-08T00:00:00Z'), ends_at: Date.parse('2026-03-08T23:59:00Z'), all_day: true },
    { ...base, source_id: 'uw-learn-ics', external_id: 'quiz', kind: 'deadline', title: 'Résumé Quiz - 15 minutes - Due', location: 'CFE – Fall 2026', starts_at: Date.parse('2026-03-08T23:59:00Z'), ends_at: Date.parse('2026-03-08T23:59:00Z') },
  ]);
  const calendar = await buildCalendar(store, { start: '2026-03-08', days: 1, now });
  const byId = new Map(calendar.days[0].events.map((event) => [event.occurrence_id, event]));
  for (const id of ['cive-stream', 'che-stream', 'nfa-hold']) {
    assert.equal(byId.get(id).category, 'event');
    assert.equal(byId.get(id).kind, 'event');
    assert.equal(byId.get(id).phase, null);
  }
  assert.equal(byId.get('quiz').category, 'deadline');
  assert.equal(byId.get('quiz').phase, 'due');
});

test('calendar retains source UIDs and deduplicates legacy rows after a restart', async () => {
  const store = new SqliteStore(':memory:');
  const start = Date.parse('2026-03-08T13:00:00Z');
  const suffix = '#2026-03-08T13:00:00.000Z';
  const portal = { ...base, source_id: 'uw-portal-ics', external_id: `shared${suffix}`, kind: 'class', title: 'ECE 150 - Quiz 1', starts_at: start, ends_at: start };
  const learn = { ...portal, source_id: 'uw-learn-ics', kind: 'deadline', uid: 'shared' };
  assert.equal(validateRow('timeline_event', learn).uid, 'shared');
  store.upsertRows('timeline_event', [portal, learn]);
  const calendar = await buildCalendar(store, { start: '2026-03-08', days: 1, now });
  assert.equal(calendar.count, 1);
  assert.equal(calendar.days[0].events[0].source_id, 'uw-learn-ics');
});

test('calendar carries an overnight event into each day it occupies', async () => {
  const store = new SqliteStore(':memory:');
  store.upsertRows('timeline_event', [{
    ...base, source_id: 'uw-portal-ics', external_id: 'overnight', kind: 'event', title: 'Hackathon',
    starts_at: Date.parse('2026-03-08T23:00:00Z'), ends_at: Date.parse('2026-03-09T15:00:00Z'),
  }]);
  const calendar = await buildCalendar(store, { start: '2026-03-09', days: 1, now });
  assert.equal(calendar.count, 1);
  assert.equal(calendar.days[0].events[0].continues_from_previous, true);
  assert.equal(calendar.days[0].events[0].continues_next_day, false);
});

test('calendar request options reject invalid dates and unbounded ranges', () => {
  assert.deepEqual(calendarOptions(new URLSearchParams('start=2026-03-08&days=7&section=2&group=12'), now), {
    start: '2026-03-08', days: 7, section: 2, group: 12,
  });
  for (const query of ['start=2026-02-30', 'days=32', 'days=0', 'section=-1', 'group=hello']) {
    assert.throws(() => calendarOptions(new URLSearchParams(query), now), RangeError);
  }
});
