import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { runSource } from '../apps/relay/src/runner.mjs';

function source({ id = 'fake', rows = [], plausible = { ok: true, reason: '' }, parseThrows = null, bytes = 10, status = 200, contentType = 'text/calendar' } = {}) {
  return {
    id,
    shape: 'timeline_event',
    cadenceMs: 60_000,
    async fetchRaw() {
      return { status, contentType, body: 'x'.repeat(bytes), bytes };
    },
    plausible() {
      return plausible;
    },
    parse() {
      if (parseThrows) throw new Error(parseThrows);
      return { rows, meta: { n: rows.length } };
    },
  };
}

const row = (n, day = 21) => ({
  source_id: 'fake',
  external_id: `e${n}`,
  observed_at: Date.UTC(2026, 8, day, 12),
  valid_until: Date.UTC(2026, 8, day + 1, 12),
  kind: 'class',
  title: `Class ${n}`,
  starts_at: Date.UTC(2026, 8, day, 14),
  ends_at: Date.UTC(2026, 8, day, 15),
});

test('a good run writes rows, a receipt and a raw snapshot', async () => {
  const store = new SqliteStore(':memory:');
  const receipt = await runSource(source({ rows: [row(1), row(2)] }), store, { now: Date.UTC(2026, 8, 21, 12) });
  assert.equal(receipt.outcome, 'ok');
  assert.equal(receipt.rows_written, 2);
  assert.equal(store.rows('timeline_event').length, 2);
  assert.equal(store.recentRuns(1).length, 1);
  assert.equal(store.snapshotCount(), 1);
});

test('re-running identical data is idempotent', async () => {
  const store = new SqliteStore(':memory:');
  const s = source({ rows: [row(1), row(2)] });
  await runSource(s, store, { now: Date.UTC(2026, 8, 21, 12) });
  await runSource(s, store, { now: Date.UTC(2026, 8, 21, 12, 5) });
  assert.equal(store.rows('timeline_event').length, 2);
});

test('a partial run tombstones only what disappeared', async () => {
  const store = new SqliteStore(':memory:');
  await runSource(source({ rows: [row(1), row(2), row(3)] }), store, { now: Date.UTC(2026, 8, 21, 12) });
  const second = await runSource(source({ rows: [row(1), row(3)] }), store, { now: Date.UTC(2026, 8, 21, 13) });
  assert.equal(second.tombstones, 1);
  const live = store.rows('timeline_event').map((r) => r.external_id).sort();
  assert.deepEqual(live, ['e1', 'e3']);
});

test('an implausible run deletes nothing, which is the whole point', async () => {
  const store = new SqliteStore(':memory:');
  await runSource(source({ rows: [row(1), row(2)] }), store, { now: Date.UTC(2026, 8, 21, 12) });
  const bad = await runSource(
    source({ rows: [], plausible: { ok: false, reason: 'html body: not authenticated', credential: true } }),
    store,
    { now: Date.UTC(2026, 8, 21, 13) },
  );
  assert.equal(bad.outcome, 'implausible');
  assert.match(bad.error, /not authenticated/);
  assert.equal(store.rows('timeline_event').length, 2, 'a login page must never clear a timetable');
  assert.equal(bad.tombstones, 0);
});

test('a valid-empty run does not tombstone either', async () => {
  const store = new SqliteStore(':memory:');
  await runSource(source({ rows: [row(1)] }), store, { now: Date.UTC(2026, 8, 21, 12) });
  const empty = await runSource(source({ rows: [] }), store, { now: Date.UTC(2026, 8, 21, 13) });
  assert.equal(empty.outcome, 'empty');
  assert.equal(store.rows('timeline_event').length, 1, 'tomorrow menu not being posted must not delete today');
});

test('a row that breaks the contract fails the run instead of reaching the UI', async () => {
  const store = new SqliteStore(':memory:');
  const broken = { ...row(1) };
  delete broken.valid_until;
  const receipt = await runSource(source({ rows: [broken] }), store, { now: Date.UTC(2026, 8, 21, 12) });
  assert.equal(receipt.outcome, 'failed');
  assert.match(receipt.error, /contract rejected/);
  assert.equal(store.rows('timeline_event').length, 0);
});

test('a parse that throws is recorded, not swallowed', async () => {
  const store = new SqliteStore(':memory:');
  const receipt = await runSource(source({ parseThrows: 'unexpected markup' }), store, { now: Date.UTC(2026, 8, 21, 12) });
  assert.equal(receipt.outcome, 'failed');
  assert.match(receipt.error, /parse threw/);
  assert.equal(store.recentRuns(1)[0].error.length > 0, true);
});

test('a missing secret is skipped, and the run says which env var to set', async () => {
  const store = new SqliteStore(':memory:');
  const missing = source({ plausible: { ok: false, reason: 'missing PORTAL_ICS_URL', skipped: true } });
  const receipt = await runSource(missing, store, { now: Date.UTC(2026, 8, 21, 12) });
  assert.equal(receipt.outcome, 'skipped');
  assert.match(receipt.error, /PORTAL_ICS_URL/);
});

test('dry run touches nothing', async () => {
  const store = new SqliteStore(':memory:');
  const receipt = await runSource(source({ rows: [row(1)] }), store, { now: Date.UTC(2026, 8, 21, 12), dryRun: true });
  assert.equal(receipt.outcome, 'ok');
  assert.equal(receipt.rows_written, 1);
  assert.equal(store.rows('timeline_event').length, 0);
  assert.equal(store.recentRuns(1).length, 0);
});
