import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as waitzSource from '../sources/waitz/source.mjs';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { runSource } from '../apps/relay/src/runner.mjs';
import { validateRows } from '#contract/canonical.mjs';

const FIXTURE = 'fixtures/waitz-live-2026-10-21.json';
const fixtureBody = readFileSync(FIXTURE, 'utf8');
const NOW = Date.UTC(2026, 9, 21, 13, 0);

const rawResponse = (body, status = 200, contentType = 'application/json') => ({
  status,
  contentType,
  body,
  bytes: body.length,
});
const fixtureRaw = () => rawResponse(fixtureBody);
const parseFixture = () => waitzSource.parse(fixtureRaw(), { now: NOW });

test('the captured fixture has three libraries and sixteen named floors', () => {
  const { rows, meta } = parseFixture();

  assert.equal(meta.libraries, 3);
  assert.equal(meta.floors, 16);
  assert.equal(meta.rows, 19);
  assert.equal(rows.length, 19);

  const names = new Set(rows.map((row) => row.name));
  assert.ok(names.has('Dana Porter Library'), 'Dana Porter Library is present');
  assert.ok(names.has('Davis Library'), 'Davis Library is present');
  assert.ok(rows.every((row) => row.name.trim() !== ''), 'no blank location name is written');
  assert.equal(rows.filter((row) => row.parent_place_id === 'waitz:217').length, 0,
    'the blank Musagetes floor is absent');

  const library = rows.find((row) => row.external_id === 'waitz:215');
  assert.equal(library.place_id, 'waitz:215');
  assert.equal(library.parent_place_id, '');
  assert.equal(library.observed_at, NOW);
  assert.equal(library.valid_until, NOW + 6 * 60 * 1000);

  const floor = rows.find((row) => row.external_id === 'waitz:215:649');
  assert.equal(floor.place_id, 'waitz:215:649');
  assert.equal(floor.parent_place_id, 'waitz:215');
  assert.equal(floor.name, 'Main Floor Study Space');
  assert.equal(floor.is_open, false);
  assert.equal(floor.people, 13);
  assert.equal(floor.capacity, 145);
  assert.equal(floor.summary, 'Closed until 8:00am');
});

test('every parsed row satisfies the place_state contract', () => {
  const { rows } = parseFixture();
  const validated = validateRows('place_state', rows);
  assert.equal(validated.length, rows.length);
  assert.equal(validated.find((row) => row.external_id === 'waitz:215:649').summary, 'Closed until 8:00am');
});

test('plausibility rejects html, a non-200, and empty or missing data', () => {
  const cases = [
    rawResponse('<html><body>Service unavailable</body></html>', 200, 'text/html'),
    rawResponse('{}', 503),
    rawResponse('{"data":[]}'),
    rawResponse('{"data":[{}]}'),
    rawResponse('{"data":[{"name":"   "}]}'),
    rawResponse('{"nope":true}'),
  ];
  for (const response of cases) {
    const verdict = waitzSource.plausible(response);
    assert.equal(verdict.ok, false, `expected a rejection for ${response.body.slice(0, 40)}`);
    assert.ok(verdict.reason, 'a rejection carries a reason');
  }
  assert.equal(waitzSource.plausible(fixtureRaw()).ok, true);
});

test('a closed location is still a row', () => {
  const body = JSON.stringify({
    data: [{
      id: 999,
      name: 'Closed Bookstore Library',
      isOpen: false,
      people: 0,
      capacity: 40,
      hourSummary: 'Closed until 8:00am',
      subLocs: false,
    }],
  });
  const { rows, meta } = waitzSource.parse(rawResponse(body), { now: NOW });

  assert.equal(meta.libraries, 1);
  assert.equal(meta.floors, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].external_id, 'waitz:999');
  assert.equal(rows[0].is_open, false);
  assert.equal(rows[0].summary, 'Closed until 8:00am');
});

test('blank or malformed floors are skipped without losing the library', () => {
  const body = JSON.stringify({
    data: [{
      id: 217,
      name: 'Musagetes Architecture Library',
      isOpen: true,
      people: 1,
      capacity: 66,
      hourSummary: 'Open until 9:00pm',
      subLocs: [
        { id: 900, name: '   ', isOpen: true, people: 0, capacity: 10 },
        { id: null, name: 'Floor without an id', isOpen: true, people: 0, capacity: 10 },
        { id: 901, name: 'Reading Room', isOpen: true, people: 2, capacity: 20, hourSummary: 'Open until 9:00pm' },
      ],
    }],
  });
  const { rows, meta } = waitzSource.parse(rawResponse(body), { now: NOW });

  assert.equal(meta.libraries, 1);
  assert.equal(meta.floors, 1);
  assert.equal(meta.skipped_floors, 2);
  assert.deepEqual(rows.map((row) => row.name), ['Musagetes Architecture Library', 'Reading Room']);
});

test('people and capacity become non-negative integers or null', () => {
  const body = JSON.stringify({
    data: [{
      id: 1,
      name: 'Library',
      isOpen: true,
      people: '12',
      capacity: -3,
      hourSummary: 'Open until 9:00pm',
      subLocs: [
        { id: 2, name: 'Floor', isOpen: true, people: 4.9, capacity: '40' },
        { id: 3, name: 'Broken Floor', isOpen: true, people: 'many', capacity: null },
      ],
    }],
  });
  const { rows } = waitzSource.parse(rawResponse(body), { now: NOW });

  assert.equal(rows[0].people, 12);
  assert.equal(rows[0].capacity, null);
  assert.equal(rows[1].people, 4);
  assert.equal(rows[1].capacity, 40);
  assert.equal(rows[2].people, null);
  assert.equal(rows[2].capacity, null);
  validateRows('place_state', rows);
});

test('summary survives the SQLite payload round trip', () => {
  const store = new SqliteStore(':memory:');
  try {
    const { rows } = parseFixture();
    assert.equal(store.upsertRows('place_state', rows), rows.length);

    const saved = store.rows('place_state');
    assert.equal(saved.length, rows.length);
    assert.equal(saved.find((row) => row.external_id === 'waitz:215').summary, 'Closed until 8:00am');
    const floor = saved.find((row) => row.external_id === 'waitz:215:649');
    assert.equal(floor.summary, 'Closed until 8:00am');
    assert.equal(floor.people, 13);
    assert.equal(floor.capacity, 145);
    assert.equal(floor.is_open, false);
  } finally {
    store.close();
  }
});

test('the runner writes library and floor rows from a live response', async () => {
  const store = new SqliteStore(':memory:');
  const source = {
    ...waitzSource,
    async fetchRaw() {
      return fixtureRaw();
    },
  };
  try {
    const receipt = await runSource(source, store, { now: NOW });
    assert.equal(receipt.outcome, 'ok', receipt.error);
    assert.equal(receipt.rows_written, 19);

    const saved = store.rows('place_state', { where: 'source_id = ?', params: ['uw-waitz'] });
    assert.equal(saved.length, 19);
    assert.equal(saved.filter((row) => row.parent_place_id === '').length, 3);
    assert.equal(saved.find((row) => row.external_id === 'waitz:215:649').summary, 'Closed until 8:00am');
  } finally {
    store.close();
  }
});
