import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { D1Store } from '../apps/relay/src/d1-store.mjs';
import { runSource } from '../apps/relay/src/runner.mjs';
import { makeIcsSource } from '../sources/ics/source.mjs';
import { buildCalendar } from '../apps/relay/src/calendar.mjs';
import { buildRecommendations, recommendationsFromData, saveRecommendationAction } from '../apps/relay/src/recommendations.mjs';
import { detectCalendarChanges, calendarChangeAlerts, tutorialInstructions, tutorialAttendanceAlerts } from '../apps/relay/src/calendar-changes.mjs';
import { nextCommitmentCard } from '../apps/relay/src/cards.mjs';

const DAY = 86400000, now = Date.parse('2026-09-29T12:00:00Z');
function row(extra = {}) {
  return { source_id: 'uw-portal-ics', external_id: 'lecture#2026-09-29T13:00:00.000Z', uid: 'lecture',
    observed_at: now, valid_until: now + DAY, kind: 'class', title: 'ECE 198 Lecture 001', location: 'E7 2409',
    starts_at: now + 3600000, ends_at: now + 7200000, all_day: false, ...extra };
}
function event(extra = {}) {
  const value = row(extra);
  return { ...value, id: `${value.source_id}:${value.external_id}`, occurrence_id: value.external_id, category: value.kind, course: 'ECE 198',
    group_scope: { section: null, groups: null }, source_label: 'Schedule', description: '', url: null, links: [], state: 'live', ...extra };
}
function alerts(events, changes = [], extra = {}) {
  return calendarChangeAlerts({ events, changes, now, from: now - 3600000, until: now + 14 * DAY, ...extra });
}
function d1Binding() {
  const db = new DatabaseSync(':memory:');
  const api = { db, calls: 0, beforeBatch: null,
    prepare(sql) {
      api.calls++;
      let args = [];
      return { bind(...values) { assert.ok(values.length <= 100); args = values; return this; },
        async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async first() { return db.prepare(sql).get(...args) || null; } };
    },
    async batch(statements) {
      const callback = api.beforeBatch; api.beforeBatch = null; await callback?.();
      db.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  return api;
}
function fixtureSource(role = 'portal') {
  const id = role === 'portal' ? 'uw-portal-ics' : 'uw-learn-ics';
  const source = makeIcsSource({ id, role, envVar: 'TEST_CALENDAR' });
  source.body = ''; source.status = 200;
  source.fetchRaw = async () => ({ status: source.status, contentType: 'text/calendar', body: source.body, bytes: source.body.length });
  return source;
}
function feed(...events) { return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('\r\n')}\r\nEND:VCALENDAR`; }
function ics(uid, properties = '') { return `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:20260929T130000Z\r\nDTEND:20260929T140000Z\r\nSUMMARY:ECE 198 Lecture 001\r\nLOCATION:E7 2409\r\n${properties}\r\nEND:VEVENT`; }

test('diffs ignore first loads, formatting, old events and unrelated personal calendars', () => {
  assert.deepEqual(detectCalendarChanges([], [row()], { sourceId: 'uw-portal-ics', now, complete: true }), []);
  assert.deepEqual(detectCalendarChanges([row()], [row({ location: 'e7 - Room 2409' })], { sourceId: 'uw-portal-ics', now }), []);
  assert.deepEqual(detectCalendarChanges([row({ ends_at: now - 1 })], [], { sourceId: 'uw-portal-ics', now, complete: true }), []);
  assert.deepEqual(detectCalendarChanges([row({ title: 'Dentist' })], [], { sourceId: 'uw-portal-ics', now, complete: true }), []);
});

test('room and time changes preserve evidence and resolve after a reversion', () => {
  const next = row({ location: 'RCH 101', starts_at: now + 2 * 3600000 });
  const changes = detectCalendarChanges([row()], [next], { sourceId: 'uw-portal-ics', now, complete: true });
  assert.deepEqual(changes[0].kinds, ['room', 'time']);
  const result = alerts([event(next)], changes);
  assert.equal(result[0].kind, 'room');
  assert.match(result[0].body, /E7 2409 → RCH 101/);
  assert.match(result[0].body, /Sep/);
  assert.equal(result[0].confidence, 'confirmed');
  assert.deepEqual(alerts([event()], changes), []);
});

test('missing is qualified, explicit cancellations are confirmed, and partial feeds cannot cancel', () => {
  const removed = detectCalendarChanges([row()], [], { sourceId: 'uw-portal-ics', now, complete: true });
  assert.equal(alerts([], removed)[0].confidence, 'check');
  assert.match(alerts([], removed)[0].body, /Confirm/);
  const cancelled = detectCalendarChanges([row()], [], { sourceId: 'uw-portal-ics', now, complete: true, cancelledUids: ['lecture'] });
  assert.equal(alerts([], cancelled)[0].kind, 'cancelled');
  assert.deepEqual(detectCalendarChanges([row()], [], { sourceId: 'uw-portal-ics', now, complete: false, cancelledUids: ['lecture'] }), []);
  assert.deepEqual(alerts([event()], cancelled), [], 'reappearance resolves cancellation');
});

test('a changed DTSTART retains an unambiguous UID match despite a new occurrence ID', () => {
  const next = row({ external_id: 'lecture#2026-09-29T14:00:00.000Z', starts_at: now + 7200000, ends_at: now + 10800000 });
  const changes = detectCalendarChanges([row()], [next], { sourceId: 'uw-portal-ics', now, complete: true });
  assert.deepEqual(changes[0].kinds, ['time']);
  assert.equal(alerts([event(next)], changes)[0].kind, 'time');
  assert.equal(changes[0].event_id, event(next).id);
});

test('a later time change does not erase a still-current room change', () => {
  const moved = row({ location: 'RCH 101' });
  const room = detectCalendarChanges([row()], [moved], { sourceId: 'uw-portal-ics', now });
  const later = { ...moved, starts_at: moved.starts_at + 600000, ends_at: moved.ends_at + 600000 };
  const time = detectCalendarChanges([moved], [later], { sourceId: 'uw-portal-ics', now: now + 1000 });
  const result = alerts([event(later)], [...room, ...time]);
  assert.deepEqual(result.map(item => item.kind).sort(), ['room', 'time']);
});

test('unusual rooms use recurring sessions, not another tutorial, and require a strong baseline', () => {
  const peers = Array.from({ length: 4 }, (_, i) => event({ external_id: `peer${i}`, starts_at: now + (i + 1) * DAY, ends_at: now + (i + 1) * DAY + 3600000 }));
  const special = event({ location: 'RCH 101' });
  const tutorial = event({ uid: 'tutorial', external_id: 'tutorial', title: 'ECE 198 Tutorial 001', location: 'DWE 1501' });
  const result = alerts([special, ...peers, tutorial]);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'unusual_room');
  assert.match(result[0].body, /usually E7 2409/);
  assert.deepEqual(alerts([special, ...peers.slice(0, 2)]), []);
  assert.equal(alerts([special, ...peers.map((peer, index) => ({ ...peer, uid: `individual-${index}` }))])[0].kind, 'unusual_room', 'exact lecture title supports separately exported occurrences');
  assert.deepEqual(alerts([special, ...peers.map((peer, i) => ({ ...peer, location: i % 2 ? 'RCH 101' : 'E7 2409' }))]), []);
});

test('tutorial assignments require explicit cancellation language, and stable IDs survive refresh', () => {
  const work = event({ source_id: 'uw-learn-ics', category: 'deadline', kind: 'deadline', title: 'Tutorial Assignment 3', location: '',
    description: 'Complete the worksheet on Crowdmark.', links: [{ kind: 'crowdmark', url: 'https://app.crowdmark.com/student/assignment-3' }] });
  assert.equal(tutorialInstructions(work).confirmed, false);
  const possible = alerts([work])[0];
  assert.equal(possible.confidence, 'check');
  assert.match(possible.body, /cancellation is not confirmed/);
  assert.equal(possible.url, work.links[0].url);
  assert.equal(alerts([{ ...work, observed_at: now + 60000 }])[0].id, possible.id);
  const confirmed = { ...work, description: 'The tutorial is cancelled. Complete Tutorial Assignment 3 on Crowdmark instead.' };
  assert.equal(alerts([confirmed])[0].confidence, 'confirmed');
  for (const text of ['The tutorial is not cancelled. Do the assignment on Crowdmark.', 'If the tutorial is cancelled, complete the Crowdmark assignment.', 'The tutorial may be cancelled; see the Crowdmark assignment.']) {
    assert.equal(tutorialInstructions({ ...work, description: text }).confirmed, false, text);
  }
});

test('scope, stale sources and changed deadlines are reflected in alerts', () => {
  const previous = row({ source_id: 'uw-learn-ics', kind: 'deadline', title: 'ECE 198 Assignment 3 [Sec 002 Groups 1 - 20]', location: 'ECE 198 - Fall 2026' });
  const next = { ...previous, starts_at: previous.starts_at + DAY, ends_at: previous.ends_at + DAY };
  const changes = detectCalendarChanges([previous], [next], { sourceId: 'uw-learn-ics', now });
  const current = event({ ...next, location: '', group_scope: { section: 2, groups: [1, 20] } });
  assert.equal(alerts([current], changes, { section: 2, group: 4 })[0].kind, 'deadline');
  assert.deepEqual(alerts([current], changes, { section: 1, group: 4 }), []);
  assert.equal(alerts([current], changes, { failedSources: new Set(['uw-learn-ics']) })[0].state, 'stale');
});

test('LEARN resolves the course from LOCATION even when the assignment title has no course code', () => {
  const old = row({ source_id: 'uw-learn-ics', title: 'Tutorial Assignment 3 - Due', kind: 'deadline', location: 'ECE 198 - Fall 2026' });
  const next = { ...old, starts_at: old.starts_at + DAY, ends_at: old.ends_at + DAY };
  const result = detectCalendarChanges([old], [next], { sourceId: 'uw-learn-ics', now });
  assert.equal(result[0].after.course, 'ECE 198');
  assert.deepEqual(result[0].kinds, ['deadline']);
});

test('changed due times inside instructions are meaningful, and removed due text stays qualified', () => {
  const before = row({ source_id: 'uw-learn-ics', kind: 'event', title: 'Tutorial Assignment 3 - Available', location: 'ECE 198 - Fall 2026',
    starts_at: now - 3600000, ends_at: now - 3600000, description: 'Submit to Crowdmark. Due September 30 at 11:59 PM.' });
  const after = { ...before, description: before.description.replace('September 30', 'October 1') };
  const changes = detectCalendarChanges([before], [after], { sourceId: 'uw-learn-ics', now });
  assert.deepEqual(changes[0].kinds, ['deadline']);
  const result = alerts([event({ ...after, category: 'opens' })], changes);
  assert.match(result[0].body, /Sep 30.*Oct 1/);
  const noDue = { ...before, description: 'Submit to Crowdmark; check instructions.' };
  const removed = detectCalendarChanges([before], [noDue], { sourceId: 'uw-learn-ics', now });
  assert.equal(alerts([event({ ...noDue, category: 'opens' })], removed)[0].confidence, 'check');
});

test('an old opening remains available until its stated due date and keeps changed deadline alerts', async () => {
  const source = fixtureSource('learn'), store = new SqliteStore();
  source.body = feed(ics('old-opening').replace('20260929T130000Z', '20260801T130000Z').replace('20260929T140000Z', '20260801T140000Z')
    .replace('ECE 198 Lecture 001', 'Tutorial Assignment 3 - Available').replace('LOCATION:E7 2409', 'LOCATION:ECE 198 - Fall 2026')
    .replace('END:VEVENT', 'DESCRIPTION:Complete the worksheet on Crowdmark. Due September 30 at 11:59 PM.\r\nEND:VEVENT'));
  const first = await runSource(source, store, { now });
  assert.equal(first.outcome, 'ok');
  assert.equal(store.rows('timeline_event').length, 1);
  source.body = source.body.replace('September 30', 'October 1');
  await runSource(source, store, { now: now + 60000 });
  const calendar = await buildCalendar(store, { start: '2026-09-29', days: 7, now: now + 60000 });
  assert.ok(calendar.days.flatMap(day => day.events).some(event => event.category === 'deadline' && /Tutorial Assignment 3/.test(event.title)), JSON.stringify(store.rows('timeline_event')));
  const deadline = calendar.alerts.find(alert => alert.kind === 'deadline');
  assert.ok(deadline);
  assert.ok(deadline.event_id.endsWith(':due'));
  assert.equal(calendar.alerts.filter(alert => alert.kind === 'tutorial_work').length, 1);
  store.close();
});

test('untrusted calendar links never become executable alert links', () => {
  const changes = detectCalendarChanges([row({ url: 'javascript:alert(1)' })], [], { sourceId: 'uw-portal-ics', now, complete: true });
  assert.equal(alerts([], changes)[0].url, null);
});

test('only an explicitly dated tutorial replacement removes attendance; unclear dates warn instead', async () => {
  const tutorial = event({ title: 'ECE 198 TUT 101' });
  const work = event({ source_id: 'uw-learn-ics', external_id: 'work', category: 'deadline', kind: 'deadline', title: 'Tutorial Assignment 3',
    description: 'The September 29 tutorial is cancelled. Complete the assignment on Crowdmark.', location: '', starts_at: now + DAY, ends_at: now + DAY });
  assert.equal(tutorialAttendanceAlerts([tutorial, work], { now })[0].attendance, 'replaced');
  const unclear = { ...work, description: 'The tutorial is cancelled. Complete the assignment on Crowdmark.' };
  assert.equal(tutorialAttendanceAlerts([tutorial, unclear], { now })[0].attendance, 'check_instructions');
  assert.equal(tutorialAttendanceAlerts([tutorial, { ...work, description: work.description.replace('September 29', 'October 1') }], { now })[0].attendance, 'check_instructions');
  assert.equal(tutorialAttendanceAlerts([tutorial, { ...work, description: 'The tutorial is cancelled; the Crowdmark assignment is due September 29.' }], { now })[0].attendance, 'check_instructions', 'an assignment due date is not a tutorial cancellation date');
  assert.deepEqual(tutorialAttendanceAlerts([tutorial, { ...work, state: 'stale' }], { now }), []);
  const store = new SqliteStore();
  store.upsertRows('timeline_event', [row({ title: 'ECE 198 TUT 101' }), row({ source_id: 'uw-learn-ics', external_id: 'work', kind: 'deadline', title: 'Tutorial Assignment 3',
    description: work.description, location: 'ECE 198 - Fall 2026', starts_at: work.starts_at, ends_at: work.ends_at })]);
  const calendar = await buildCalendar(store, { start: '2026-09-29', now });
  assert.equal(calendar.days[0].events[0].attendance, 'replaced');
  const recs = await buildRecommendations(store, { now });
  assert.ok(!recs.items.some(item => item.kind === 'class'));
  assert.equal((await nextCommitmentCard(store, { now, useWeather: false })).data.title, 'Tutorial Assignment 3');
  store.close();
});

for (const adapter of ['SQLite', 'D1']) {
  test(`${adapter}: changes persist with a poll, unchanged/failed polls stay quiet, cancellation removes the class`, async () => {
    const binding = adapter === 'D1' ? d1Binding() : null;
    const store = binding ? new D1Store(binding) : new SqliteStore();
    if (binding) await store.init();
    const source = fixtureSource();
    source.body = feed(ics('lecture'));
    await runSource(source, store, { now });
    assert.deepEqual(await store.calendarChanges(0), []);
    source.body = source.body.replace('LOCATION:E7 2409', 'LOCATION:RCH 101');
    await runSource(source, store, { now: now + 60000 });
    assert.equal((await store.calendarChanges(0)).length, 1);
    const calendar = await buildCalendar(store, { start: '2026-09-29', now: now + 60000 });
    assert.equal(calendar.alerts[0].kind, 'room');
    await runSource(source, store, { now: now + 120000 });
    assert.equal((await store.calendarChanges(0)).length, 1);
    source.status = 500;
    await runSource(source, store, { now: now + 180000 });
    assert.equal((await store.calendarChanges(0)).length, 1);
    source.status = 200; source.body = feed(ics('lecture', 'STATUS:CANCELLED'));
    await runSource(source, store, { now: now + 240000 });
    const cancelled = await buildCalendar(store, { start: '2026-09-29', now: now + 240000 });
    assert.equal(cancelled.days[0].events.length, 0);
    assert.equal(cancelled.alerts[0].kind, 'cancelled');
    const recs = await buildRecommendations(store, { now: now + 240000 });
    assert.equal(recs.items[0].kind, 'change');
    assert.match(recs.items[0].title, /cancelled/);
    assert.ok(!recs.items.some(item => item.kind === 'class'));
    if (binding) binding.db.close(); else store.close();
  });
}

test('a cancelled recurrence and EXDATE produce cancellation evidence for just that occurrence', async () => {
  const source = fixtureSource();
  const store = new SqliteStore();
  source.body = feed(ics('tutorial', 'RRULE:FREQ=DAILY;COUNT=4'));
  await runSource(source, store, { now });
  source.body = feed(ics('tutorial', 'RRULE:FREQ=DAILY;COUNT=4\r\nEXDATE:20260930T130000Z'), ics('tutorial', 'RECURRENCE-ID:20261001T130000Z\r\nSTATUS:CANCELLED'));
  await runSource(source, store, { now: now + 60000 });
  const changes = await store.calendarChanges(0);
  assert.equal(changes.length, 2);
  assert.ok(changes.every(change => change.kinds.includes('cancelled')));
  assert.equal(store.rows('timeline_event').length, 2);
  store.close();
});

test('an EXDATE excluding every remaining occurrence is trusted, without trusting an unrelated omission', async () => {
  const source = fixtureSource(), store = new SqliteStore();
  source.body = feed(ics('tutorial', 'RRULE:FREQ=DAILY;COUNT=1'));
  await runSource(source, store, { now });
  source.body = feed(ics('tutorial', 'RRULE:FREQ=DAILY;COUNT=1\r\nEXDATE:20260929T130000Z'));
  assert.equal((await runSource(source, store, { now: now + 60000 })).outcome, 'empty');
  assert.equal(store.rows('timeline_event').length, 0);
  assert.deepEqual(store.calendarChanges(0)[0].kinds, ['cancelled']);
  store.upsertRows('timeline_event', [row({ external_id: 'unrelated', uid: 'unrelated' })]);
  assert.equal((await runSource(source, store, { now: now + 120000 })).outcome, 'failed');
  assert.equal(store.rows('timeline_event').length, 1);
  store.close();
});

test('D1 journal is fenced when ownership changes before the atomic batch', async () => {
  const binding = d1Binding(); const store = new D1Store(binding); await store.init();
  const claim = await store.claimSource('uw-portal-ics');
  const changes = detectCalendarChanges([row()], [row({ location: 'RCH 101' })], { sourceId: 'uw-portal-ics', now });
  binding.beforeBatch = async () => binding.db.prepare('UPDATE job SET lease_token = ?').run('new-owner');
  const result = await store.commitSourceResult({ sourceId: 'uw-portal-ics', leaseToken: claim.token, shape: 'timeline_event', calendarChanges: changes,
    receipt: { source_id: 'uw-portal-ics', started_at: now, finished_at: now, outcome: 'ok' } });
  assert.equal(result.applied, false);
  assert.deepEqual(await store.calendarChanges(0), []);
  binding.db.close();
});

test('SQLite journal rolls back when a poll receipt cannot commit', async () => {
  const store = new SqliteStore(); const source = fixtureSource(); source.body = feed(ics('lecture'));
  await runSource(source, store, { now });
  const original = store.insertRun.bind(store);
  store.insertRun = () => { throw new Error('receipt failed'); };
  source.body = source.body.replace('E7 2409', 'RCH 101');
  await assert.rejects(runSource(source, store, { now: now + 60000 }), /receipt failed/);
  assert.deepEqual(store.calendarChanges(0), []);
  assert.equal(store.rows('timeline_event')[0].location, 'E7 2409');
  store.insertRun = original; store.close();
});

test('the change journal survives a SQLite restart and prunes old entries on a successful poll', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uni-change-journal-'));
  let store = new SqliteStore(join(directory, 'relay.db'));
  try {
    const source = fixtureSource(); source.body = feed(ics('lecture'));
    await runSource(source, store, { now });
    source.body = source.body.replace('E7 2409', 'RCH 101');
    await runSource(source, store, { now: now + 60000 });
    const id = store.calendarChanges(0)[0].id;
    store.close(); store = new SqliteStore(join(directory, 'relay.db'));
    assert.equal(store.calendarChanges(0)[0].id, id);
    store.db.prepare('INSERT INTO calendar_change (id, source_id, observed_at, payload_json) VALUES (?,?,?,?)')
      .run('old', source.id, now - 15 * DAY, JSON.stringify({ id: 'old' }));
    await runSource(source, store, { now: now + 120000 });
    assert.deepEqual(store.calendarChanges(0).map(change => change.id), [id]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Crowdmark tutorial work feeds the task engine with an actual due time and direct link', async () => {
  const store = new SqliteStore(); const source = fixtureSource('learn');
  source.body = feed(ics('work').replace('ECE 198 Lecture 001', 'Tutorial Assignment 3 - Available').replace('LOCATION:E7 2409', 'LOCATION:ECE 198 - Fall 2026')
    .replace('END:VEVENT', 'DESCRIPTION:The tutorial is cancelled. Complete Tutorial Assignment 3 on Crowdmark instead. Due September 30 at 11:59 PM.\\nhttps://app.crowdmark.com/student/assignment-3\r\nEND:VEVENT'));
  await runSource(source, store, { now });
  const result = await buildRecommendations(store, { now: now + 2 * 3600000 });
  assert.ok(result.items.some(item => item.kind === 'change' && /replaced/.test(item.title)));
  const task = result.tasks.large.find(item => /Tutorial Assignment 3/.test(item.title));
  assert.equal(task.action.label, 'Open Crowdmark');
  assert.equal(task.due_at, Date.parse('2026-10-01T03:59:00Z'));
  assert.ok(!task.evidence.includes('direct submission link was not supplied'));
  store.close();
});

test('personalization ranks nearby changes above lunch, and snoozes keep a stable identity', async () => {
  const change = alerts([event({ category: 'deadline', kind: 'deadline', title: 'Tutorial Assignment 3', description: 'The tutorial is cancelled. Complete the assignment on Crowdmark.' })])[0];
  const calendar = { days: [], courses: [], sources: [], alerts: [change] };
  const feed = recommendationsFromData({ calendar, now });
  assert.equal(feed.items[0].kind, 'change');
  const store = new SqliteStore();
  await saveRecommendationAction(store, { id: feed.items[0].id, action: 'snooze' }, { now });
  const actions = JSON.parse(store.getSetting('RECOMMENDATION_ACTIONS_JSON'));
  assert.equal(recommendationsFromData({ calendar, actions, now: now + 60000 }).items.length, 0);
  assert.equal(recommendationsFromData({ calendar, actions, now: now + 3600001 }).items[0]?.id, feed.items[0].id);
  store.close();
});

test('updates can be dismissed permanently instead of pushing back an hour, and undo works', async () => {
  const change = alerts([event({ category: 'deadline', kind: 'deadline', title: 'Tutorial Assignment 3', description: 'The tutorial is cancelled. Complete the assignment on Crowdmark.' })])[0];
  const calendar = { days: [], courses: [], sources: [], alerts: [change] };
  const feed = recommendationsFromData({ calendar, now });
  assert.equal(feed.items[0].kind, 'change');
  const store = new SqliteStore();
  await saveRecommendationAction(store, { id: feed.items[0].id, action: 'dismiss' }, { now });
  let actions = JSON.parse(store.getSetting('RECOMMENDATION_ACTIONS_JSON'));
  assert.equal(recommendationsFromData({ calendar, actions, now: now + 60000 }).items.length, 0);
  // Unlike snooze, dismiss does NOT push back an hour to reappear later
  assert.equal(recommendationsFromData({ calendar, actions, now: now + 3600001 }).items.length, 0);
  assert.equal(recommendationsFromData({ calendar, actions, now: now + 86400000 }).items.length, 0);

  // Undo restores the update
  await saveRecommendationAction(store, { id: feed.items[0].id, action: 'undo' }, { now });
  actions = JSON.parse(store.getSetting('RECOMMENDATION_ACTIONS_JSON'));
  assert.equal(recommendationsFromData({ calendar, actions, now: now + 3600001 }).items[0]?.id, feed.items[0].id);
  store.close();
});

