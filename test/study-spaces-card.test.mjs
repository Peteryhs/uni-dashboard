import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { studySpacesCard } from '../apps/relay/src/study-spaces.mjs';
import { buildDashboard } from '../apps/relay/src/cards.mjs';
import { validateCardData } from '#contract/card-data.mjs';

const now = Date.UTC(2026, 9, 21, 16);
const MIN = 60_000;

function seedPlaces(store, places, { observedAt = now - MIN, validUntil = observedAt + 6 * MIN } = {}) {
  store.upsertRows('place_state', places.map((p) => ({
    source_id: 'uw-waitz',
    external_id: p.id,
    observed_at: observedAt,
    valid_until: validUntil,
    place_id: p.id,
    name: p.name,
    parent_place_id: p.parent ?? '',
    is_open: p.open,
    people: p.people ?? null,
    capacity: p.capacity ?? null,
    summary: p.summary ?? '',
  })));
}

test('the emptiest open floor that qualifies is the pick, and closed floors are ignored', async () => {
  const store = new SqliteStore(':memory:');
  seedPlaces(store, [
    { id: 'waitz:1', name: 'Dana Porter Library', parent: '', open: true, people: 60, capacity: 600 },
    { id: 'waitz:1:main', name: 'Main Floor Study Space', parent: 'waitz:1', open: true, people: 20, capacity: 200 },
    { id: 'waitz:1:adaptive', name: 'Adaptive Technology Centre', parent: 'waitz:1', open: true, people: 1, capacity: 100 },
    { id: 'waitz:1:small', name: 'Small Room', parent: 'waitz:1', open: true, people: 1, capacity: 10 },
    { id: 'waitz:1:basement', name: 'Basement Study Space', parent: 'waitz:1', open: false, people: 0, capacity: 100 },
    { id: 'waitz:2', name: 'Davis Centre Library', parent: '', open: false, people: 0, capacity: 500 },
    { id: 'waitz:2:lower', name: 'Lower Floor', parent: 'waitz:2', open: false, people: 0, capacity: 200 },
  ]);

  const card = await studySpacesCard(store, { now });

  assert.equal(card.state, 'live');
  assert.equal(card.data.best.space_id, 'waitz:1:main', 'the closed 0 percent floor and the excluded rooms must not win');
  assert.equal(card.data.best.library_id, 'waitz:1');
  assert.equal(card.data.best.library_name, 'Dana Porter Library');
  assert.equal(card.data.best.space_name, 'Main Floor Study Space');
  assert.equal(card.data.best.percent, 10);
  assert.equal(card.data.best.people, 20);
  assert.equal(card.data.best.capacity, 200);

  assert.deepEqual(
    card.data.libraries.map((library) => library.name),
    ['Dana Porter Library', 'Davis Centre Library'],
    'open libraries sort before closed ones',
  );
  assert.deepEqual(
    card.data.libraries[0].floors.map((floor) => floor.name),
    ['Adaptive Technology Centre', 'Main Floor Study Space', 'Small Room', 'Basement Study Space'],
    'floors sort open first, then by percent, and closed floors still ship',
  );
  assert.equal(card.data.libraries[1].floors.length, 1, 'a closed library still carries its floors');
  assert.equal(card.data.open_count, 1);
  assert.equal(card.data.total_count, 2);
});

test('when every library is closed the pick is null but the libraries remain', async () => {
  const store = new SqliteStore(':memory:');
  seedPlaces(store, [
    { id: 'waitz:1', name: 'Dana Porter Library', parent: '', open: false, people: 5, capacity: 100 },
    { id: 'waitz:1:main', name: 'Main Floor Study Space', parent: 'waitz:1', open: false, people: 0, capacity: 100 },
    { id: 'waitz:2', name: 'Davis Centre Library', parent: '', open: false, people: 0, capacity: 100 },
    { id: 'waitz:2:lower', name: 'Lower Floor', parent: 'waitz:2', open: false, people: 0, capacity: 100 },
  ]);

  const card = await studySpacesCard(store, { now });

  assert.equal(card.data.best, null);
  assert.equal(card.data.open_count, 0);
  assert.equal(card.data.libraries.length, 2, 'closed is a fact, not an empty response');
  assert.equal(card.data.total_count, 2);
  assert.equal(card.data.libraries[0].floors.length, 1);
});

test('percent is rounded and clamped, and null when the inputs cannot support it', async () => {
  const store = new SqliteStore(':memory:');
  seedPlaces(store, [
    { id: 'waitz:1', name: 'Library', parent: '', open: true, people: 10, capacity: 100 },
    { id: 'waitz:1:over', name: 'Over capacity', parent: 'waitz:1', open: true, people: 250, capacity: 200 },
    { id: 'waitz:1:negative', name: 'Negative people', parent: 'waitz:1', open: true, people: -5, capacity: 100 },
    { id: 'waitz:1:third', name: 'One third', parent: 'waitz:1', open: true, people: 1, capacity: 3 },
    { id: 'waitz:1:zero', name: 'Zero capacity', parent: 'waitz:1', open: true, people: 5, capacity: 0 },
    { id: 'waitz:1:no-people', name: 'No people', parent: 'waitz:1', open: true, people: null, capacity: 100 },
    { id: 'waitz:1:no-capacity', name: 'No capacity', parent: 'waitz:1', open: true, people: 5, capacity: null },
  ]);

  const card = await studySpacesCard(store, { now });
  const floors = new Map(card.data.libraries[0].floors.map((floor) => [floor.name, floor]));

  assert.equal(floors.get('Over capacity').percent, 100);
  assert.equal(floors.get('Negative people').percent, null, 'a negative count is treated as unknown, not empty');
  assert.equal(floors.get('One third').percent, 33);
  assert.equal(floors.get('Zero capacity').percent, null);
  assert.equal(floors.get('No people').percent, null);
  assert.equal(floors.get('No capacity').percent, null);
});

test('freshness follows the five minute cadence', async () => {
  const store = new SqliteStore(':memory:');
  const places = [
    { id: 'waitz:1', name: 'Library', parent: '', open: true, people: 10, capacity: 100 },
    { id: 'waitz:1:main', name: 'Main Floor Study Space', parent: 'waitz:1', open: true, people: 10, capacity: 100 },
  ];
  const states = [];
  for (const ageMs of [2 * MIN, 10 * MIN, 20 * MIN, 45 * MIN]) {
    seedPlaces(store, places, { observedAt: now - ageMs, validUntil: now - ageMs + 6 * MIN });
    states.push((await studySpacesCard(store, { now })).state);
  }
  assert.deepEqual(states, ['live', 'ageing', 'stale', 'dead']);
});

test('no rows and a failed run reports the error without inventing libraries', async () => {
  const store = new SqliteStore(':memory:');
  store.insertRun({
    source_id: 'uw-waitz',
    started_at: now - 60_000,
    finished_at: now - 50_000,
    outcome: 'failed',
    http_status: 500,
    error: 'HTTP 500 Internal Server Error',
  });

  const card = await studySpacesCard(store, { now });

  assert.equal(card.state, 'failed');
  assert.match(card.data.error, /HTTP 500/);
  assert.deepEqual(card.data.libraries, []);
  assert.equal(card.data.best, null);
  assert.equal(card.data.open_count, 0);
  assert.equal(card.data.total_count, 0);
});

test('no rows and no failed run is an empty card, not an error', async () => {
  const store = new SqliteStore(':memory:');
  const card = await studySpacesCard(store, { now });

  assert.equal(card.state, 'empty');
  assert.deepEqual(card.data.libraries, []);
  assert.equal(card.data.error, undefined);
});

test('study spaces data passes the card contract', async () => {
  const populated = new SqliteStore(':memory:');
  seedPlaces(populated, [
    { id: 'waitz:1', name: 'Dana Porter Library', parent: '', open: true, people: 13, capacity: 145, summary: 'Open until 9:00pm' },
    { id: 'waitz:1:main', name: 'Main Floor Study Space', parent: 'waitz:1', open: true, people: 13, capacity: 145, summary: 'Open until 9:00pm' },
  ]);
  const card = await studySpacesCard(populated, { now });
  const parsed = validateCardData('study_spaces', card.data);
  assert.equal(parsed.libraries[0].floors[0].percent, 9);
  assert.equal(parsed.libraries[0].summary, 'Open until 9:00pm');

  const failed = new SqliteStore(':memory:');
  failed.insertRun({
    source_id: 'uw-waitz',
    started_at: now - 60_000,
    finished_at: now - 50_000,
    outcome: 'failed',
    error: 'Network timeout',
  });
  const unavailable = await studySpacesCard(failed, { now });
  assert.doesNotThrow(() => validateCardData('study_spaces', unavailable.data));
});

test('buildDashboard includes the study spaces card', async () => {
  const store = new SqliteStore(':memory:');
  seedPlaces(store, [
    { id: 'waitz:1', name: 'Dana Porter Library', parent: '', open: true, people: 13, capacity: 145 },
    { id: 'waitz:1:main', name: 'Main Floor Study Space', parent: 'waitz:1', open: true, people: 13, capacity: 145 },
  ]);

  const bundle = await buildDashboard(store, { now, useWeather: false });
  const card = bundle.cards.find((entry) => entry.type === 'study_spaces');

  assert.ok(card, 'the card must always be sent');
  assert.equal(card.id, 'study_spaces');
  assert.equal(card.priority, 70);
  assert.equal(card.source_id, 'uw-waitz');
});
