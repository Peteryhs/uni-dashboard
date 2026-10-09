import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ddl, receiptLookup, RECEIPTS_PER_SOURCE, MAX_LOOKUP_SOURCES, MAX_COMPOUND_TERMS } from '../apps/relay/src/schema.mjs';

/**
 * The free tier's meter is rows read, and `source_run` holds a receipt a minute for the 60 s status
 * source, so "latest run per source" has to be an index seek per source rather than an aggregate
 * over the table. These tests assert the query plan, because the row count returned is identical in
 * both shapes and would hide the scan: a dashboard read asked for it seven times, and every cron
 * tick once, which is what spent the 5M rows/day.
 *
 * The term count is asserted for the same reason. D1 caps a compound SELECT at 5 terms (workerd
 * hardens SQLITE_LIMIT_COMPOUND_SELECT), while better-sqlite3 and node:sqlite keep SQLite's stock
 * 500 - so the six real sources passed every local test and failed in production with
 * "too many terms in compound SELECT". Nothing a local engine can run catches that, so the built
 * SQL is asserted directly.
 */

const SOURCE_IDS = ['uw-status', 'uw-learn-ics', 'uw-portal-ics', 'google-calendar-ics', 'uw-food', 'user-office-hours'];

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
  for (const id of SOURCE_IDS.slice(1)) {
    for (let i = 0; i < 20; i += 1) {
      insert.run(id, now - i * 3_600_000, now - i * 3_600_000, i === 1 ? 'failed' : 'ok', 200, 100, 0, '', '', '{}');
    }
  }
  return db;
}

function planFor(db, sql) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail).join(' | ');
}

/** Every statement of a lookup, so a split lookup is asserted the same way as a single one. */
function statements(lookup) {
  return Array.isArray(lookup) ? lookup : [lookup];
}

/** Rows a lookup answers with, which is the concatenation of its statements. */
function rowsFor(db, lookup) {
  return statements(lookup).flatMap(({ sql, params }) => db.prepare(sql).all(...params));
}

/** Compound terms in one statement: D1's ceiling is on these, not on the sources named. */
function termsIn(sql) {
  return sql.split('UNION ALL').length;
}

test('a named source list is answered by index seeks, never a scan of source_run', () => {
  const db = seededDb();
  const lookup = receiptLookup(['uw-status', 'uw-learn-ics']);
  assert.ok(lookup, 'a named list must produce an indexed lookup');
  for (const { sql } of statements(lookup)) {
    const plan = planFor(db, sql);
    assert.doesNotMatch(plan, /SCAN source_run/);
    assert.match(plan, /idx_source_run_source_id \(source_id=\?\)/);
  }
});

test('the exhaustive form is still a scan, which is why callers name their sources', () => {
  const db = seededDb();
  assert.match(planFor(db, RECEIPTS_PER_SOURCE.latest), /SCAN source_run/);
  assert.match(planFor(db, RECEIPTS_PER_SOURCE.successful), /SCAN source_run/);
});

test('no statement ever exceeds the compound SELECT terms D1 allows', () => {
  for (const size of [1, 2, 5, 6, 7, 10, MAX_LOOKUP_SOURCES]) {
    const ids = Array.from({ length: size }, (_, i) => `s${i}`);
    for (const [label, lookup] of [
      ['latest', receiptLookup(ids)],
      ['successful', receiptLookup(ids, { successful: true })],
    ]) {
      const built = statements(lookup);
      assert.equal(built.length, Math.ceil(size / MAX_COMPOUND_TERMS), `${label}: ${size} sources split into statements`);
      for (const { sql, params } of built) {
        assert.ok(termsIn(sql) <= MAX_COMPOUND_TERMS, `${label}: ${termsIn(sql)} terms for ${size} sources`);
        assert.equal(params.length, termsIn(sql), `${label}: one bound source per term`);
      }
    }
  }
});

test('a source list longer than one statement still returns every row', () => {
  const db = seededDb();
  assert.equal(SOURCE_IDS.length, 6, 'the registry names six sources, which is one statement too many');
  const lookup = receiptLookup(SOURCE_IDS);
  assert.equal(statements(lookup).length, 2);
  assert.deepEqual(
    rowsFor(db, lookup).map((r) => r.source_id).sort(),
    [...SOURCE_IDS].sort(),
  );
});

test('the lookup returns exactly the rows the exhaustive query returns', () => {
  const db = seededDb();
  for (const ids of [SOURCE_IDS, SOURCE_IDS.slice(0, 4)]) {
    for (const [sql, lookup] of [
      [RECEIPTS_PER_SOURCE.latest, receiptLookup(ids)],
      [RECEIPTS_PER_SOURCE.successful, receiptLookup(ids, { successful: true })],
    ]) {
      const expected = db.prepare(sql).all().filter((row) => ids.includes(row.source_id));
      const got = rowsFor(db, lookup);
      assert.deepEqual(
        Object.fromEntries(got.map((r) => [r.source_id, [r.id, r.outcome]])),
        Object.fromEntries(expected.map((r) => [r.source_id, [r.id, r.outcome]])),
      );
    }
  }
});

test('a source with no receipts yields no row instead of matching a null id', () => {
  const db = seededDb();
  assert.deepEqual(rowsFor(db, receiptLookup(['never-ran'])), []);
});

test('an unusable source list falls back to the exhaustive query, not to an empty answer', () => {
  assert.equal(receiptLookup(null), null);
  assert.equal(receiptLookup([]), null);
  assert.equal(receiptLookup(['', null, 42]), null);
  assert.equal(receiptLookup('uw-status'), null);
  assert.equal(receiptLookup(Array.from({ length: MAX_LOOKUP_SOURCES + 1 }, (_, i) => `s${i}`)), null);
  const collapsed = statements(receiptLookup(['a', 'a', 'b']));
  assert.equal(collapsed.flatMap(({ params }) => params).length, 2, 'duplicate ids collapse into one seek');
});
