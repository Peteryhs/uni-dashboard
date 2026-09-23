import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { dueSoonCard, foodCard, alertCard, nextCommitmentCard, courseOf, significant } from '../apps/relay/src/cards.mjs';
import { config } from '../apps/relay/src/config.mjs';
import statusSource from '../sources/status/source.mjs';
import { runSource } from '../apps/relay/src/runner.mjs';

const now = Date.UTC(2026, 8, 21, 12); // 2026-09-21 08:00 in Toronto
const MIN = 60_000;

function seed(store) {
  const t = (h) => Date.UTC(2026, 8, 21, h);
  store.upsertRows('timeline_event', [
    { source_id: 'uw-portal-ics', external_id: 'c1', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'class', title: 'ECE 150 LEC 001', location: 'E7 2317', starts_at: t(18), ends_at: t(19) },
    { source_id: 'uw-learn-ics', external_id: 'd1', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'deadline', title: 'ECE 150 - Assignment 3 due', starts_at: t(30), ends_at: t(30) },
    { source_id: 'uw-learn-ics', external_id: 'd2', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'deadline', title: 'MATH 115 - Quiz 2', starts_at: t(50), ends_at: t(50) },
    { source_id: 'uw-learn-ics', external_id: 'd3', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'deadline', title: 'Far future thing', starts_at: now + 30 * 24 * 3600_000, ends_at: now + 30 * 24 * 3600_000 },
  ]);
  store.upsertRows('menu_item', [
    { source_id: 'uw-food-daily-menu', external_id: '2026-09-21::REV::Soup', observed_at: now - 3600_000, valid_until: now + 12 * 3600_000, outlet: 'REVelation - Residence Dining Hall', dish: 'Soup', service_date: '2026-09-21' },
    { source_id: 'uw-food-daily-menu', external_id: '2026-09-21::OTH::Chicken', observed_at: now - 3600_000, valid_until: now + 12 * 3600_000, outlet: 'Station 57', dish: 'Chicken', service_date: '2026-09-21' },
  ]);
  return store;
}

test('food card keeps pinned outlets even when they are not serving', () => {
  const store = seed(new SqliteStore(':memory:'));
  const card = foodCard(store, { now });
  const rev = card.data.pinned.find((p) => p.outlet.includes('REVelation'));
  const mudies = card.data.pinned.find((p) => p.outlet.includes("Mudie's"));
  assert.equal(rev.serving, true);
  assert.equal(rev.dish_count, 1);
  assert.equal(mudies.serving, false, 'a pinned outlet that posts nothing today still renders');
  assert.equal(mudies.dish_count, 0);
  assert.deepEqual(card.data.others.map((o) => o.outlet), ['Station 57'], 'unpinned outlets still appear when serving');
});

test('food card is empty, not broken, when nothing is posted', () => {
  const store = new SqliteStore(':memory:');
  const card = foodCard(store, { now, date: '2026-09-22' });
  assert.equal(card.state, 'empty');
  assert.equal(card.data.total_dishes, 0);
  assert.equal(card.data.pinned.length, config.pinnedOutlets.length);
});

test('food freshness is judged against its own 12 hour cadence', () => {
  const store = seed(new SqliteStore(':memory:'));
  assert.equal(foodCard(store, { now }).state, 'live');
  // the card is scoped to a service date, so ask for the same date and let the clock move
  assert.equal(foodCard(store, { now: now + 14 * 3600_000, date: '2026-09-21' }).state, 'ageing');
  assert.equal(foodCard(store, { now: now + 40 * 3600_000, date: '2026-09-21' }).state, 'stale');
  assert.equal(foodCard(store, { now: now + 100 * 3600_000, date: '2026-09-21' }).state, 'dead');
});

test('the alert card is invisible when nothing is wrong', () => {
  const store = seed(new SqliteStore(':memory:'));
  const card = alertCard(store, { now });
  assert.equal(card.state, 'empty');
  assert.equal(card.data.count, 0);
});

test('the alert card surfaces a real incident and sorts by severity', () => {
  const store = seed(new SqliteStore(':memory:'));
  store.upsertRows('notice', [
    { source_id: 'uw-status', external_id: 'n1', observed_at: now, valid_until: now + 5 * MIN, severity: 'minor', scope: 'campus', title: 'Degraded', url: '' },
    { source_id: 'uw-status', external_id: 'n2', observed_at: now, valid_until: now + 5 * MIN, severity: 'major', scope: 'campus', title: 'Partial System Outage', url: '' },
    { source_id: 'uw-status', external_id: 'n3', observed_at: now, valid_until: now + 5 * MIN, severity: 'info', scope: 'campus', title: 'All good', url: '' },
  ]);
  const card = alertCard(store, { now });
  assert.equal(card.data.count, 2, 'info is not worth an alert');
  assert.equal(card.data.notices[0].severity, 'major');
});

test('an expired notice remains visible as the last known incident, marked dead', () => {
  const store = seed(new SqliteStore(':memory:'));
  store.upsertRows('notice', [
    { source_id: 'uw-status', external_id: 'n1', observed_at: now - 10 * MIN, valid_until: now - 5 * MIN, severity: 'critical', scope: 'campus', title: 'Old outage', url: '' },
  ]);
  const card = alertCard(store, { now });
  assert.equal(card.data.count, 1);
  assert.equal(card.state, 'dead');
});

test('a successful all clear removes a previously active incident immediately', async () => {
  const store = new SqliteStore(':memory:');
  const source = {
    ...statusSource,
    async fetchRaw() {
      const body = JSON.stringify({ status: { indicator: 'major', description: 'Partial outage' }, page: { updated_at: '2026-09-21T12:00:00Z' } });
      return { status: 200, contentType: 'application/json', body, bytes: body.length };
    },
  };
  await runSource(source, store, { now });
  assert.equal(alertCard(store, { now }).data.count, 1);

  source.fetchRaw = async () => {
    const body = JSON.stringify({ status: { indicator: 'none' } });
    return { status: 200, contentType: 'application/json', body, bytes: body.length };
  };
  const receipt = await runSource(source, store, { now: now + MIN });
  assert.equal(receipt.outcome, 'empty');
  assert.equal(receipt.tombstones, 1);
  assert.equal(alertCard(store, { now: now + MIN }).data.count, 0);
  store.close();
});

test('an all clear is only an all clear when it is recent', () => {
  const store = seed(new SqliteStore(':memory:'));
  // a status check that came back clean 20 seconds ago
  store.insertRun({ source_id: 'uw-status', started_at: now - 30_000, finished_at: now - 20_000, outcome: 'empty', http_status: 200, bytes: 243 });

  const fresh = alertCard(store, { now });
  assert.equal(fresh.data.count, 0);
  assert.equal(fresh.state, 'live');
  assert.equal(fresh.data.checked_at, now - 20_000);

  // the relay has not polled for three hours: the last known state is 'major' as far as we know,
  // so the card must not read as good news (this is what it did before)
  const old = alertCard(store, { now: now + 3 * 3600_000 });
  assert.equal(old.data.count, 0);
  assert.equal(old.state, 'dead', 'silence hours after the last check is not an all clear');
  assert.equal(old.data.checked_at, now - 20_000);
});

test('the hero card keeps the schedule feed even when a deadline is sooner', () => {
  const store = new SqliteStore(':memory:');
  const t = (h) => Date.UTC(2026, 8, 21, h);
  store.upsertRows('timeline_event', [
    { source_id: 'uw-portal-ics', external_id: 'c1', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'class', title: 'ECE 150 LEC 001', location: 'E7 2317', starts_at: t(20), ends_at: t(21) },
    // a LEARN task due an hour before that class
    { source_id: 'uw-learn-ics', external_id: 'd1', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'deadline', title: 'ECE 150 - Assignment 3 due', starts_at: t(19), ends_at: t(19) },
  ]);
  return nextCommitmentCard(store, { now, useWeather: false }).then((card) => {
    assert.equal(card.data.title, 'ECE 150 LEC 001', 'LEARN must not override the countdown to the next class');
    assert.equal(card.data.kind, 'class');
  });
});

test('a deadline takes the hero slot only when nothing is scheduled ahead', () => {
  const store = new SqliteStore(':memory:');
  store.upsertRows('timeline_event', [
    { source_id: 'uw-learn-ics', external_id: 'd1', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'deadline', title: 'MATH 115 - Quiz 2 opens', starts_at: now + 3600_000, ends_at: now + 3600_000 },
  ]);
  return nextCommitmentCard(store, { now, useWeather: false }).then((card) => {
    assert.equal(card.data.title, 'MATH 115 - Quiz 2 opens', 'with no class ahead, the deadline is the honest hero');
  });
});

test('next commitment card carries the following commitment in following field', async () => {
  const store = new SqliteStore(':memory:');
  const t = (h) => Date.UTC(2026, 8, 21, h);
  store.upsertRows('timeline_event', [
    { source_id: 'uw-portal-ics', external_id: 'c1', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'class', title: 'ECE 150 LEC 001', location: 'E7 2317', starts_at: t(10), ends_at: t(11) },
    { source_id: 'uw-portal-ics', external_id: 'c2', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'class', title: 'ECE 198 LAB 001', location: 'E7 2400', starts_at: t(14), ends_at: t(17) },
  ]);
  const card = await nextCommitmentCard(store, { now: t(9), useWeather: false });
  assert.equal(card.data.title, 'ECE 150 LEC 001');
  assert.ok(card.data.following);
  assert.equal(card.data.following.title, 'ECE 198 LAB 001');
  assert.equal(card.data.following.location, 'E7 2400');
  assert.equal(card.data.following.starts_at, t(14));
});

test('the deadlines card sends a flat list in time order, not one list per course', () => {
  const store = seed(new SqliteStore(':memory:'));
  const card = dueSoonCard(store, { now });
  const items = card.data.items;
  assert.equal(items.length, 2, 'both items are in the window');
  assert.deepEqual(
    items.map((i) => i.title),
    ['ECE 150 - Assignment 3 due', 'MATH 115 - Quiz 2'],
    'soonest first, regardless of course',
  );
  for (const i of items) assert.ok(i.course, 'every item still says which course it belongs to');
  assert.ok(!items.some((i) => i.url === null), 'a null url fails the contract, so it must never be sent');
});

test('due soon counts only the seven day window and groups by course', () => {
  const store = seed(new SqliteStore(':memory:'));
  const card = dueSoonCard(store, { now });
  assert.equal(card.data.count, 2, 'the thing 30 days out is not "due soon"');
  assert.deepEqual(card.data.courses.map((c) => c.course).sort(), ['ECE 150', 'MATH 115']);
});

test('due soon ignores expired deadlines from yesterday or earlier today', () => {
  const store = seed(new SqliteStore(':memory:'));
  store.upsertRows('timeline_event', [
    { source_id: 'uw-learn-ics', external_id: 'd_past', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'deadline', title: 'MATH 115 - Expired homework', starts_at: now - 3600_000, ends_at: now - 3600_000 },
  ]);
  const card = dueSoonCard(store, { now });
  assert.equal(card.data.count, 2, 'expired deadline must not be counted');
  assert.equal(card.data.courses.some((c) => c.items.some((i) => i.title.includes('Expired'))), false);
  assert.ok(card.data.nearest_at >= now, 'nearest deadline must be in the future');
});

test('course codes are extracted from several title shapes', () => {
  assert.equal(courseOf('ECE 150 - Assignment 3 due'), 'ECE 150');
  assert.equal(courseOf('MATH115 Quiz'), 'MATH115');
  assert.equal(courseOf('Some announcement'), 'Other');
});

test('significant identifies exams and major milestones without including standard assignments', () => {
  assert.equal(significant({ kind: 'exam', title: 'Calculus Final' }), true);
  assert.equal(significant({ kind: 'deadline', title: 'ECE190 midterm test' }), true);
  assert.equal(significant({ kind: 'deadline', title: 'Group Deliverable 1 (Part 1) submission [Sec 002 Groups 1-20] - Due' }), true);
  assert.equal(significant({ kind: 'deadline', title: 'Major Assignment 1: Memo Report' }), true);
  assert.equal(significant({ kind: 'deadline', title: 'Process Task: Progress Report' }), true);
  assert.equal(significant({ kind: 'deadline', title: 'Project 1 - Grade calculator - Due' }), true);
  assert.equal(significant({ kind: 'deadline', title: 'Quiz #2' }), false);
  assert.equal(significant({ kind: 'deadline', title: 'Assignment #2 due' }), false);
});

test('dueSoonCard separates Opens, Due, Ahead and ignores portal admin deadlines', () => {
  const store = new SqliteStore(':memory:');
  const DAY = 24 * 3600_000;
  store.upsertRows('timeline_event', [
    // Portal admin event that had deadline kind
    { source_id: 'uw-portal-ics', external_id: 'p1', observed_at: now, valid_until: now + DAY, kind: 'deadline', title: 'Not Fees Arranged (NFA) holds applied', starts_at: now + 2 * DAY, ends_at: now + 2 * DAY },
    // Learn event: due within 7 days
    { source_id: 'uw-learn-ics', external_id: 'l1#2026-09-23', uid: 'l1', observed_at: now, valid_until: now + DAY, kind: 'deadline', title: 'Prework 2 Quiz - Due', starts_at: now + 2 * DAY, ends_at: now + 2 * DAY },
    // Learn event: opens within 7 days
    { source_id: 'uw-learn-ics', external_id: 'l2#2026-09-24', uid: 'l2', observed_at: now, valid_until: now + DAY, kind: 'deadline', title: 'MATH 117 Tutorial 4 - Available', starts_at: now + 3 * DAY, ends_at: now + 3 * DAY },
    // Learn event: significant ahead event in 29 days
    { source_id: 'uw-learn-ics', external_id: 'l3#2026-10-20', uid: 'l3', observed_at: now, valid_until: now + DAY, kind: 'deadline', title: 'ECE190 midterm test', starts_at: now + 29 * DAY, ends_at: now + 29 * DAY },
    // Learn event: regular non-significant assignment in 35 days (should NOT appear in ahead)
    { source_id: 'uw-learn-ics', external_id: 'l4#2026-10-26', uid: 'l4', observed_at: now, valid_until: now + DAY, kind: 'deadline', title: 'Assignment #5 due', starts_at: now + 35 * DAY, ends_at: now + 35 * DAY },
  ]);

  const card = dueSoonCard(store, { now });
  // 1. Portal event is excluded
  assert.equal(card.data.due.some((d) => d.title.includes('Fees Arranged')), false);
  assert.equal(card.data.items.some((d) => d.title.includes('Fees Arranged')), false);

  // 2. Opens contains the '- Available' event and minimal fields (no links/description)
  assert.equal(card.data.opens.length, 1);
  assert.equal(card.data.opens[0].title, 'MATH 117 Tutorial 4 - Available');
  assert.equal(card.data.opens[0].phase, 'opens');
  assert.equal(card.data.opens[0].description, undefined);

  // 3. Due contains the '- Due' event
  assert.equal(card.data.due.length, 1);
  assert.equal(card.data.due[0].title, 'Prework 2 Quiz - Due');
  assert.equal(card.data.due[0].phase, 'due');

  // 4. Ahead contains ECE190 midterm grouped by week, and excludes Assignment #5 due
  assert.ok(card.data.ahead.length >= 1);
  const allAheadItems = card.data.ahead.flatMap((g) => g.items);
  assert.ok(allAheadItems.some((i) => i.title === 'ECE190 midterm test'));
  assert.equal(allAheadItems.some((i) => i.title.includes('Assignment #5')), false);

  // 5. next_major points to ECE190 midterm
  assert.ok(card.data.next_major);
  assert.equal(card.data.next_major.title, 'ECE190 midterm test');
});

test('next commitment prefers the sooner of class and deadline', async () => {
  const store = new SqliteStore(':memory:');
  store.upsertRows('timeline_event', [
    { source_id: 'a', external_id: 'x', observed_at: now, valid_until: now + MIN, kind: 'class', title: 'Later class', starts_at: now + 5 * 3600_000, ends_at: now + 6 * 3600_000 },
    { source_id: 'b', external_id: 'y', observed_at: now, valid_until: now + MIN, kind: 'deadline', title: 'Sooner deadline', starts_at: now + 3600_000, ends_at: now + 3600_000 },
  ]);
  const card = await nextCommitmentCard(store, { now, useWeather: false });
  assert.equal(card.data.title, 'Sooner deadline');
});

test('an empty timetable is a fact, not a failure', async () => {
  const store = new SqliteStore(':memory:');
  const card = await nextCommitmentCard(store, { now, useWeather: false });
  assert.equal(card.state, 'empty');
  assert.match(card.data.title, /Nothing scheduled/);
});

test('the card carries what, where and when, and nothing about leaving', async () => {
  const store = new SqliteStore(':memory:');
  store.upsertRows('timeline_event', [
    { source_id: 'b', external_id: 'y', observed_at: now, valid_until: now + MIN, kind: 'deadline', title: 'Submit essay', starts_at: now + 3600_000, ends_at: now + 3600_000 },
  ]);
  const card = await nextCommitmentCard(store, { now, useWeather: false });
  assert.equal(card.data.title, 'Submit essay');
  assert.equal(card.data.starts_at, now + 3600_000);
  for (const gone of ['walk_minutes', 'leave_by', 'nav_url', 'from_building', 'from_source']) {
    assert.equal(gone in card.data, false, `${gone} was removed with the walk feature`);
  }
});

test('when a schedule feed failed and has no recent success, card reports failed state instead of fake nothing scheduled', async () => {
  const store = new SqliteStore(':memory:');
  store.insertRun({
    source_id: 'uw-portal-ics',
    started_at: now - 60_000,
    finished_at: now - 50_000,
    outcome: 'failed',
    error: 'HTTP 500 Internal Server Error',
  });

  const card = await nextCommitmentCard(store, { now, useWeather: false });
  assert.equal(card.state, 'failed', 'failed fetch must produce failed card state');
  assert.equal(card.data.title, 'Unable to fetch schedule');
  assert.match(card.data.subtitle, /HTTP 500/);
});

test('when a schedule feed is unconfigured, card reports degraded state instead of fake nothing scheduled', async () => {
  const store = new SqliteStore(':memory:');
  store.insertRun({
    source_id: 'uw-portal-ics',
    started_at: now - 60_000,
    finished_at: now - 50_000,
    outcome: 'skipped',
    error: 'missing PORTAL_ICS_URL',
  });

  const card = await nextCommitmentCard(store, { now, useWeather: false });
  assert.equal(card.state, 'degraded', 'unconfigured feed must produce degraded state');
  assert.equal(card.data.title, 'Schedule feed not configured');
});

test('when learn feed failed and has no recent success, due soon card reports failed state', () => {
  const store = new SqliteStore(':memory:');
  store.insertRun({
    source_id: 'uw-learn-ics',
    started_at: now - 60_000,
    finished_at: now - 50_000,
    outcome: 'failed',
    error: 'Network timeout',
  });

  const card = dueSoonCard(store, { now });
  assert.equal(card.state, 'failed');
  assert.equal(card.data.count, 0);
  assert.match(card.data.error, /Network timeout/);
});

test('when food feed failed and has no recent success, food card reports failed state', () => {
  const store = new SqliteStore(':memory:');
  store.insertRun({
    source_id: 'uw-food-daily-menu',
    started_at: now - 60_000,
    finished_at: now - 50_000,
    outcome: 'failed',
    error: 'Downstream DNS error',
  });

  const card = foodCard(store, { now, date: '2026-09-21' });
  assert.equal(card.state, 'failed');
  assert.match(card.data.error, /Downstream DNS error/);
});


