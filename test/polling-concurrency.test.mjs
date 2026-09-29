import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { D1Store } from '../apps/relay/src/d1-store.mjs';
import { runSource } from '../apps/relay/src/runner.mjs';
import { pollDue } from '../apps/relay/src/worker.mjs';

const now = Date.UTC(2026, 8, 29, 12);

function row(sourceId, marker) {
  return {
    source_id: sourceId,
    external_id: `${sourceId}:${marker}`,
    observed_at: now,
    valid_until: now + 60_000,
    kind: 'class',
    title: marker,
    starts_at: now + 1_000,
    ends_at: now + 2_000,
  };
}

function source(id, { onFetch } = {}) {
  let calls = 0;
  return {
    id,
    shape: 'timeline_event',
    cadenceMs: 60_000,
    needsSecret: false,
    get calls() { return calls; },
    async fetchRaw() {
      calls += 1;
      const marker = await onFetch?.(calls) ?? id;
      return { status: 200, contentType: 'text/plain', body: String(marker), bytes: 1 };
    },
    plausible: () => ({ ok: true }),
    parse: (raw) => ({ rows: [row(id, raw.body)], meta: {} }),
  };
}

/** A small D1 binding backed by node:sqlite, matching the methods used by D1Store. */
function mockD1({ beforeBatch = null, maxParams = Infinity } = {}) {
  const db = new DatabaseSync(':memory:');
  let armed = false;
  const api = {
    async exec(sql) { db.exec(sql); },
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async run() {
          if (args.length > maxParams) throw new Error(`too many bound parameters: ${args.length}`);
          const result = db.prepare(sql).run(...args);
          return { meta: { changes: Number(result.changes ?? 0) } };
        },
        async all() {
          if (args.length > maxParams) throw new Error(`too many bound parameters: ${args.length}`);
          return { results: db.prepare(sql).all(...args) };
        },
        async first(column) {
          if (args.length > maxParams) throw new Error(`too many bound parameters: ${args.length}`);
          const row = db.prepare(sql).get(...args);
          return row ? (column ? row[column] : row) : null;
        },
      };
    },
    async batch(statements) {
      if (armed && beforeBatch) {
        armed = false;
        await beforeBatch();
      }
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  api.arm = () => { armed = true; };
  api.rawDb = db;
  return api;
}

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

test('overlapping polls of one source run one fetch and preserve its rows', async () => {
  const store = new SqliteStore(':memory:');
  const firstFetch = gate();
  const s = source('same', { onFetch: (count) => count === 1 ? firstFetch.promise : 'B' });
  const first = runSource(s, store, { now });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await runSource(s, store, { now: now + 1 });
  firstFetch.release('A');
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.outcome, 'ok');
  assert.equal(b.outcome, 'skipped');
  assert.equal(s.calls, 1);
  assert.deepEqual(store.rows('timeline_event').map((r) => r.title), ['A']);
});

test('a failed run releases its lease so the next poll can retry', async () => {
  const store = new SqliteStore(':memory:');
  let calls = 0;
  const s = source('retry', { onFetch: () => {
    calls += 1;
    if (calls === 1) throw new Error('synthetic upstream failure');
    return 'recovered';
  } });
  const failed = await runSource(s, store, { now });
  const recovered = await runSource(s, store, { now: now + 1 });
  assert.equal(failed.outcome, 'failed');
  assert.equal(recovered.outcome, 'ok');
  assert.equal(store.rows('timeline_event')[0].title, 'recovered');
});

test('a storage exception while a scheduler holds a lease releases it immediately', async () => {
  const store = new SqliteStore(':memory:');
  const originalCommit = store.commitSourceResult.bind(store);
  store.commitSourceResult = () => { throw new Error('synthetic database outage'); };
  const s = source('db-failure');
  await assert.rejects(runSource(s, store, { now, holdLease: true }), /database outage/);
  const [job] = store.jobs();
  assert.ok(job.lease_expires_at <= Date.now(), 'failed scheduler poll must release immediately');
  store.commitSourceResult = originalCommit;
  const retry = await runSource(s, store, { now: now + 1 });
  assert.equal(retry.outcome, 'ok');
});

test('SQLite poll commit rolls back rows and snapshot when receipt insertion fails', async () => {
  const store = new SqliteStore(':memory:');
  const originalInsertRun = store.insertRun.bind(store);
  store.insertRun = () => { throw new Error('synthetic receipt failure'); };
  const s = source('sqlite-rollback');

  await assert.rejects(runSource(s, store, { now, holdLease: true }), /receipt failure/);
  assert.equal(store.rows('timeline_event').length, 0);
  assert.equal(store.snapshotCount(), 0);
  assert.equal(store.recentRuns(10).length, 0);

  store.insertRun = originalInsertRun;
  const retry = await runSource(s, store, { now: now + 1 });
  assert.equal(retry.outcome, 'ok');
  assert.equal(store.rows('timeline_event').length, 1);
  assert.equal(store.snapshotCount(), 1);
});

test('a superseded late completion cannot write rows or a receipt', async () => {
  const store = new SqliteStore(':memory:');
  const firstFetch = gate();
  const s = source('late', { onFetch: (count) => count === 1 ? firstFetch.promise : 'new' });
  const first = runSource(s, store, { now, leaseMs: 60_000 });
  await new Promise((resolve) => setImmediate(resolve));

  // Simulate the lease expiring while the first request is still waiting on the upstream.
  store.db.prepare('UPDATE job SET lease_expires_at=0 WHERE source_id=?').run('late');
  const newer = await runSource(s, store, { now: now + 1 });
  firstFetch.release('old');
  const stale = await first;

  assert.equal(newer.outcome, 'ok');
  assert.equal(stale.outcome, 'skipped');
  assert.deepEqual(store.rows('timeline_event').map((r) => r.title), ['new']);
  assert.equal(store.recentRuns(10).filter((r) => r.outcome === 'skipped').length, 0);
});

test('different sources can poll in parallel', async () => {
  const store = new SqliteStore(':memory:');
  const bothFetched = gate();
  let fetched = 0;
  const make = (id) => source(id, { onFetch: async () => {
    fetched += 1;
    if (fetched === 2) bothFetched.release();
    await bothFetched.promise;
    return id;
  } });
  const [a, b] = await Promise.all([runSource(make('a'), store, { now }), runSource(make('b'), store, { now })]);
  assert.deepEqual([a.outcome, b.outcome], ['ok', 'ok']);
  assert.deepEqual(store.rows('timeline_event').map((r) => r.source_id).sort(), ['a', 'b']);
});

test('overlapping Worker scheduler ticks claim one source only once', async () => {
  const store = new D1Store(mockD1());
  await store.init();
  const firstFetch = gate();
  const s = source('scheduled-overlap', { onFetch: (count) => count === 1 ? firstFetch.promise : 'unexpected' });
  await store.scheduleJob(s.id, now - 1);
  const first = pollDue(store, now, 1, [s]);
  await new Promise((resolve) => setImmediate(resolve));
  const second = pollDue(store, now, 1, [s]);
  firstFetch.release('scheduled-A');
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.receipts[0].outcome, b.receipts[0].outcome].sort(), ['ok', 'skipped']);
  assert.deepEqual((await store.rows('timeline_event')).map((r) => r.title), ['scheduled-A']);
  assert.ok((await store.jobs())[0].next_due_at > now, 'only the owner may reschedule the job');
});

test('the D1-backed runner also serializes overlapping source polls', async () => {
  const store = new D1Store(mockD1());
  await store.init();
  const firstFetch = gate();
  const s = source('d1-same', { onFetch: (count) => count === 1 ? firstFetch.promise : 'ignored' });
  const first = runSource(s, store, { now });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await runSource(s, store, { now: now + 1 });
  firstFetch.release('d1-A');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.outcome, 'ok');
  assert.equal(b.outcome, 'skipped');
  assert.deepEqual((await store.rows('timeline_event')).map((r) => r.title), ['d1-A']);
});

test('D1 guarded upserts leave room for lease parameters under the 100 bind limit', async () => {
  const db = mockD1({ maxParams: 100 });
  const store = new D1Store(db);
  await store.init();
  const claim = await store.claimSource('metric-bound', { now, leaseNow: Date.now() });
  const rows = Array.from({ length: 11 }, (_, index) => ({
    source_id: 'metric-bound',
    external_id: `metric-${index}`,
    observed_at: now,
    valid_until: now + 60_000,
    name: 'temperature',
    place_id: 'campus',
    at: now + index,
    value: index,
  }));
  const result = await store.commitSourceResult({
    sourceId: 'metric-bound',
    leaseToken: claim.token,
    leaseNow: Date.now(),
    shape: 'metric',
    rows,
    receipt: {
      source_id: 'metric-bound', started_at: now, finished_at: now + 1, outcome: 'ok',
      http_status: 200, bytes: 1, error: '', body_sha256: '', meta: {},
    },
  });
  assert.equal(result.applied, true);
  assert.equal((await store.rows('metric')).length, 11);
});

test('a D1 batch guarded after claim cannot apply after a newer lease steals it', async () => {
  const enteredBatch = gate();
  const resumeBatch = gate();
  const db = mockD1({ beforeBatch: async () => {
    enteredBatch.release();
    await resumeBatch.promise;
  } });
  const store = new D1Store(db);
  await store.init();
  db.arm();
  const s = source('d1-toctou', { onFetch: () => 'old' });
  const stalePromise = runSource(s, store, { now });
  await enteredBatch.promise;

  // The old invocation has already prepared its guarded batch. Expire and replace its token
  // before any statement executes, then let a newer invocation publish its snapshot.
  db.rawDb.prepare('UPDATE job SET lease_expires_at=0 WHERE source_id=?').run('d1-toctou');
  const fresh = source('d1-toctou', { onFetch: () => 'new' });
  const current = await runSource(fresh, store, { now: now + 1 });
  assert.equal(current.outcome, 'ok');
  resumeBatch.release();
  const stale = await stalePromise;

  assert.equal(stale.outcome, 'skipped');
  assert.deepEqual((await store.rows('timeline_event')).map((r) => r.title), ['new']);
  assert.equal((await store.recentRuns(10)).filter((run) => run.outcome === 'skipped').length, 0);
});

test('old SQLite job schemas gain lease columns during store migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uni-dashboard-lease-'));
  const filename = join(dir, 'relay.db');
  const old = new DatabaseSync(filename);
  old.exec(`CREATE TABLE job (
    source_id TEXT PRIMARY KEY,
    next_due_at INTEGER NOT NULL,
    last_started_at INTEGER,
    last_finished_at INTEGER,
    last_outcome TEXT NOT NULL DEFAULT '',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    circuit_state TEXT NOT NULL DEFAULT 'closed'
  )`);
  old.close();
  const store = new SqliteStore(filename);
  const columns = store.db.prepare('PRAGMA table_info(job)').all().map((column) => column.name);
  assert.ok(columns.includes('lease_token'));
  assert.ok(columns.includes('lease_expires_at'));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('old D1 job schemas gain lease columns during init migration', async () => {
  const db = mockD1();
  const seeded = new D1Store(db);
  await seeded.init();
  db.rawDb.exec('ALTER TABLE job DROP COLUMN lease_expires_at');
  db.rawDb.exec('ALTER TABLE job DROP COLUMN lease_token');
  const migrated = new D1Store(db);
  await migrated.init();
  const columns = (await db.prepare('PRAGMA table_info(job)').all()).results.map((column) => column.name);
  assert.ok(columns.includes('lease_token'));
  assert.ok(columns.includes('lease_expires_at'));
});

test('D1 migration repairs an old job table even when another schema object is missing', async () => {
  const db = mockD1();
  const seeded = new D1Store(db);
  await seeded.init();
  db.rawDb.exec('ALTER TABLE job DROP COLUMN lease_expires_at');
  db.rawDb.exec('ALTER TABLE job DROP COLUMN lease_token');
  db.rawDb.exec('DROP TABLE setting');

  const migrated = new D1Store(db);
  await migrated.init();
  const columns = (await db.prepare('PRAGMA table_info(job)').all()).results.map((column) => column.name);
  const setting = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='setting'").first();
  assert.ok(columns.includes('lease_token'));
  assert.ok(columns.includes('lease_expires_at'));
  assert.ok(setting);
});

test('concurrent cold D1 stores tolerate a duplicate lease-column migration', async () => {
  const db = mockD1();
  const seeded = new D1Store(db);
  await seeded.init();
  db.rawDb.exec('ALTER TABLE job DROP COLUMN lease_expires_at');
  db.rawDb.exec('ALTER TABLE job DROP COLUMN lease_token');

  await Promise.all([new D1Store(db).init(), new D1Store(db).init()]);
  const columns = (await db.prepare('PRAGMA table_info(job)').all()).results.map((column) => column.name);
  assert.ok(columns.includes('lease_token'));
  assert.ok(columns.includes('lease_expires_at'));
});

test('lease tokens stay hidden from job and receipt JSON', async () => {
  const sqlite = new SqliteStore(':memory:');
  const sourceA = source('json-sqlite');
  const receiptA = await runSource(sourceA, sqlite, { now });
  assert.equal(JSON.stringify(receiptA).includes('claim_token'), false);
  assert.equal(JSON.stringify(sqlite.jobs()).includes('lease_token'), false);

  const d1 = new D1Store(mockD1());
  await d1.init();
  const sourceB = source('json-d1');
  const receiptB = await runSource(sourceB, d1, { now });
  assert.equal(JSON.stringify(receiptB).includes('claim_token'), false);
  assert.equal(JSON.stringify(await d1.jobs()).includes('lease_token'), false);
});
