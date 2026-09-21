import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { dueSoonCard, foodCard, alertCard, nextCommitmentCard, courseOf } from '../apps/relay/src/cards.mjs';
import { config } from '../apps/relay/src/config.mjs';

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
    { source_id: 'uw-food-daily-menu', external_id: 'REV::Soup', observed_at: now - 3600_000, valid_until: now + 12 * 3600_000, outlet: 'REVelation - Residence Dining Hall', dish: 'Soup', service_date: '2026-09-21' },
    { source_id: 'uw-food-daily-menu', external_id: 'OTH::Chicken', observed_at: now - 3600_000, valid_until: now + 12 * 3600_000, outlet: 'Station 57', dish: 'Chicken', service_date: '2026-09-21' },
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

test('an expired notice stops alerting', () => {
  const store = seed(new SqliteStore(':memory:'));
  store.upsertRows('notice', [
    { source_id: 'uw-status', external_id: 'n1', observed_at: now, valid_until: now - 1000, severity: 'critical', scope: 'campus', title: 'Old outage', url: '' },
  ]);
  assert.equal(alertCard(store, { now }).data.count, 0);
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

test('next commitment folds in the walk and the leave-by time', async () => {
  const store = seed(new SqliteStore(':memory:'));
  const card = await nextCommitmentCard(store, { now, useWeather: false });
  assert.equal(card.data.kind, 'class');
  assert.equal(card.data.location, 'E7 2317');
  assert.equal(card.data.walk_minutes, config.walkMinutes['REV->E7']);
  assert.equal(card.data.leave_by, card.data.starts_at - card.data.walk_minutes * MIN, 'leave_by must be starts_at minus the walk');
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

test('a deadline with no room gets no walk time', async () => {
  const store = new SqliteStore(':memory:');
  store.upsertRows('timeline_event', [
    { source_id: 'b', external_id: 'y', observed_at: now, valid_until: now + MIN, kind: 'deadline', title: 'Submit essay', starts_at: now + 3600_000, ends_at: now + 3600_000 },
  ]);
  const card = await nextCommitmentCard(store, { now, useWeather: false });
  assert.equal(card.data.walk_minutes, null);
  assert.equal(card.data.leave_by, null);
});

test('next commitment assumes user is at their last class today for walk calculation', async () => {
  const store = new SqliteStore(':memory:');
  const pastClassTime = now - 60 * MIN;
  const nextClassTime = now + 60 * MIN;
  store.upsertRows('timeline_event', [
    {
      source_id: 'uw',
      external_id: 'c1',
      observed_at: now,
      valid_until: now + 24 * 3600_000,
      kind: 'class',
      title: 'Previous class',
      location: 'E5 2004',
      starts_at: pastClassTime,
      ends_at: pastClassTime + 50 * MIN,
    },
    {
      source_id: 'uw',
      external_id: 'c2',
      observed_at: now,
      valid_until: now + 24 * 3600_000,
      kind: 'class',
      title: 'Next class',
      location: 'E3 1001',
      starts_at: nextClassTime,
      ends_at: nextClassTime + 50 * MIN,
    },
  ]);
  const card = await nextCommitmentCard(store, { now, useWeather: false });
  assert.equal(card.data.from_building, 'E5');
  assert.equal(card.data.walk_minutes, config.walkMinutes['E5->E3']);
  assert.match(card.data.nav_url, /google\.com\/maps/);
  assert.match(card.data.nav_url, /travelmode=walking/);
});

