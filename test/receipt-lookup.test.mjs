import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ddl, receiptLookup, RECEIPTS_PER_SOURCE, MAX_LOOKUP_SOURCES } from '../apps/relay/src/schema.mjs';

/**
 * The free tier's meter is rows read, and `source_run` holds a receipt a minute for the 60 s status
 * source, so "latest run per source" has to be an index seek per source rather than an aggregate
 * over the table. These tests assert the query plan, because the row count returned is identical in
 * both shapes and would hide the scan: a dashboard read asked for it seven times, and every cron
 * tick once, which is what spent the 5M rows/day.
 */

function seededDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(ddl());
  const insert = db.prepare(`INSERT INTO source_run
    (source_id, started_at, finished_at, outcome, http_status, bytes, rows_written, error, body_sha256, meta_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  for (let i = 0; i < 5000; i += 1) {
    insert.run('uw-status', now - i * 60_000, now - i * 60_000, 'ok', 200, 100, 0, '', '', '{}');
  }
  for (const id of ['uw-learn-ics', 'uw-portal-ics', 'google-calendar-ics']) {
    for (let i = 0; i < 20; i += 1) {
      insert.run(id, now - i * 3_600_000, now - i * 3_600_000, i === 1 ? 'failed' : 'ok', 200, 100, 0, '', '', '{}');
    }
  }
  return db;
}

function planFor(db, sql) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail).join(' | ');
}

test('a named source list is answered by index seeks, never a scan of source_run', () => {
  const db = seededDb();
  const lookup = receiptLookup(['uw-status', 'uw-learn-ics']);
  assert.ok(lookup, 'a named list must produce an indexed lookup');
  const plan = planFor(db, lookup.sql);
  assert.doesNotMatch(plan, /SCAN source_run/);
  assert.match(plan, /idx_source_run_source_id \(source_id=\?\)/);
});

test('the exhaustive form is still a scan, which is why callers name their sources', () => {
  const db = seededDb();
  assert.match(planFor(db, RECEIPTS_PER_SOURCE.latest), /SCAN source_run/);
  assert.match(planFor(db, RECEIPTS_PER_SOURCE.successful), /SCAN source_run/);
});

test('the lookup returns exactly the rows the exhaustive query returns', () => {
  const db = seededDb();
  const ids = ['uw-status', 'uw-learn-ics', 'uw-portal-ics', 'google-calendar-ics'];
  for (const [sql, lookup] of [
    [RECEIPTS_PER_SOURCE.latest, receiptLookup(ids)],
    [RECEIPTS_PER_SOURCE.successful, receiptLookup(ids, { successful: true })],
  ]) {
    const expected = db.prepare(sql).all();
    const got = db.prepare(lookup.sql).all(...lookup.params);
    assert.deepEqual(
      Object.fromEntries(got.map((r) => [r.source_id, [r.id, r.outcome]])),
      Object.fromEntries(expected.map((r) => [r.source_id, [r.id, r.outcome]])),
    );
  }
});

test('a source with no receipts yields no row instead of matching a null id', () => {
  const db = seededDb();
  const lookup = receiptLookup(['never-ran']);
  assert.deepEqual(db.prepare(lookup.sql).all(...lookup.params), []);
});

test('an unusable source list falls back to the exhaustive query, not to an empty answer', () => {
  assert.equal(receiptLookup(null), null);
  assert.equal(receiptLookup([]), null);
  assert.equal(receiptLookup(['', null, 42]), null);
  assert.equal(receiptLookup('uw-status'), null);
  assert.equal(receiptLookup(Array.from({ length: MAX_LOOKUP_SOURCES + 1 }, (_, i) => `s${i}`)), null);
  assert.equal(receiptLookup(['a', 'a', 'b']).params.length, 2, 'duplicate ids collapse into one seek');
});
