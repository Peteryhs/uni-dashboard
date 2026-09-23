import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { D1Store } from '../apps/relay/src/d1-store.mjs';
import { buildDashboard } from '../apps/relay/src/cards.mjs';

/**
 * Creates an in-memory Cloudflare D1 mock conforming to the D1 JS binding API.
 */
function createMockD1(counter = { prepares: 0 }) {
  const db = new DatabaseSync(':memory:');

  return {
    async exec(query) {
      db.exec(query);
      return { count: 0, duration: 0 };
    },
    prepare(sql) {
      counter.prepares += 1;
      let bound = [];
      return {
        bind(...args) {
          bound = args;
          return this;
        },
        async run() {
          const stmt = db.prepare(sql);
          const res = stmt.run(...bound);
          // D1 reports affected rows in meta.changes, so the mock does too: pruneRuns reads it.
          return { success: true, meta: { changes: Number(res.changes ?? 0), last_row_id: Number(res.lastInsertRowid ?? 0) } };
        },
        async all() {
          const stmt = db.prepare(sql);
          const results = stmt.all(...bound);
          return { success: true, results };
        },
        async first(col) {
          const stmt = db.prepare(sql);
          const row = stmt.get(...bound);
          if (!row) return null;
          return col ? row[col] : row;
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const s of statements) {
        results.push(await s.run());
      }
      return results;
    },
  };
}

const now = Date.UTC(2026, 8, 21, 12);
const MIN = 60_000;

test('D1Store initializes schema and performs row upserts', async () => {
  const mockD1 = createMockD1();
  const store = new D1Store(mockD1);
  await store.init();

  const written = await store.upsertRows('menu_item', [
    { source_id: 's', external_id: 'd1', observed_at: 1, valid_until: 2, outlet: 'REV', dish: 'Soup', service_date: '2026-09-21' },
  ]);
  assert.equal(written, 1);

  await store.upsertRows('menu_item', [
    { source_id: 's', external_id: 'd1', observed_at: 5, valid_until: 9, outlet: 'REV', dish: 'Stew', service_date: '2026-09-21' },
  ]);

  const rows = await store.rows('menu_item');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dish, 'Stew');
  assert.equal(rows[0].observed_at, 5);
});

test('D1Store preserves numeric and boolean types', async () => {
  const mockD1 = createMockD1();
  const store = new D1Store(mockD1);
  await store.init();

  await store.upsertRows('timeline_event', [
    { source_id: 's', external_id: 'e1', observed_at: now, valid_until: now + 1000, kind: 'class', title: 'x', starts_at: now, ends_at: now + 600000, all_day: false },
  ]);
  const [r] = await store.rows('timeline_event');
  assert.equal(typeof r.starts_at, 'number');
  assert.equal(typeof r.ends_at, 'number');
  assert.equal(typeof r.all_day, 'boolean');
});

test('D1 timeline rows are ordered before the limit is applied', async () => {
  const store = new D1Store(createMockD1());
  await store.init();
  await store.upsertRows('timeline_event', [
    { source_id: 's', external_id: 'a-later', observed_at: now, valid_until: now + 1000, kind: 'class', title: 'Later', starts_at: now + 3600_000, ends_at: now + 7200_000 },
    { source_id: 's', external_id: 'z-sooner', observed_at: now, valid_until: now + 1000, kind: 'class', title: 'Sooner', starts_at: now + 60_000, ends_at: now + 120_000 },
  ]);
  assert.equal((await store.rows('timeline_event', { orderBy: 'starts_at', limit: 1 }))[0].title, 'Sooner');
  await assert.rejects(store.rows('timeline_event', { orderBy: 'starts_at DESC' }), /invalid order column/);
});

test('D1Store handles tombstoning with partition scope', async () => {
  const mockD1 = createMockD1();
  const store = new D1Store(mockD1);
  await store.init();

  const rowA = { source_id: 'uw-food-daily-menu', external_id: 'd1', observed_at: 1, valid_until: 2, outlet: 'REV', dish: 'Soup', service_date: '2026-09-21' };
  const rowB = { source_id: 'uw-food-daily-menu', external_id: 'd2', observed_at: 1, valid_until: 2, outlet: 'REV', dish: 'Stew', service_date: '2026-09-22' };
  await store.upsertRows('menu_item', [rowA, rowB]);

  // Tombstone scoped only to 2026-09-21 where d1 disappeared
  const tombstones = await store.tombstoneMissing('menu_item', 'uw-food-daily-menu', [], {
    column: 'service_date',
    values: ['2026-09-21'],
  });
  assert.equal(tombstones, 1);

  const remaining = await store.rows('menu_item');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].external_id, 'd2');
});

test('D1Store removes a cancelled series within the query budget', async () => {
  const counter = { prepares: 0 };
  const store = new D1Store(createMockD1(counter));
  await store.init();
  await store.upsertRows('timeline_event', Array.from({ length: 80 }, (_, i) => ({
    source_id: 'uw-portal-ics',
    external_id: `class-${i}`,
    observed_at: now,
    valid_until: now + 86400_000,
    kind: 'class',
    title: 'Cancelled series',
    starts_at: now + i * 86400_000,
    ends_at: now + i * 86400_000 + MIN,
  })));
  const before = counter.prepares;
  assert.equal(await store.tombstoneMissing('timeline_event', 'uw-portal-ics', []), 80);
  assert.ok(counter.prepares - before <= 2, 'one lookup and one batched UPDATE are enough');
  assert.equal((await store.rows('timeline_event')).length, 0);
});

test('D1Store manages snapshots and gzip compression', async () => {
  const mockD1 = createMockD1();
  const store = new D1Store(mockD1);
  await store.init();

  const hash = await store.saveSnapshot({
    sourceId: 's',
    fetchedAt: now,
    contentType: 'text/html',
    body: '<html>hello cloudflare</html>',
  });
  assert.ok(hash);
  assert.equal(await store.snapshotCount(), 1);

  const snap = await store.getSnapshot(hash);
  assert.equal(snap.body, '<html>hello cloudflare</html>');
});

test('D1Store executes job scheduling and exponential backoff', async () => {
  const mockD1 = createMockD1();
  const store = new D1Store(mockD1);
  await store.init();

  await store.scheduleJob('s', now);
  for (let i = 0; i < 5; i++) {
    await store.recordJobResult('s', { startedAt: now, finishedAt: now, outcome: 'failed', cadenceMs: 60_000, now });
  }
  const [job] = await store.jobs();
  assert.equal(job.circuit_state, 'open');
  assert.equal(job.consecutive_failures, 5);
  await store.recordJobResult('s', { startedAt: now, finishedAt: now, outcome: 'failed', httpStatus: 429, cadenceMs: 15 * 60_000, now });
  assert.ok((await store.jobs())[0].next_due_at >= now + 30 * 60_000);
});

test('D1Store creates the schema with a batch, because D1 exec() truncates wrapped DDL', async () => {
  const calls = { exec: 0, batch: 0 };
  const mockD1 = createMockD1();
  const spy = {
    ...mockD1,
    exec: async (q) => {
      calls.exec += 1;
      return mockD1.exec(q);
    },
    batch: async (stmts) => {
      calls.batch += 1;
      return mockD1.batch(stmts);
    },
  };
  const store = new D1Store(spy);
  await store.init();
  assert.equal(calls.exec, 0, 'exec() runs one statement per line, so a wrapped CREATE TABLE arrives truncated');
  assert.equal(calls.batch, 1);
});

test('D1Store groups rows into multi-row statements, not one statement per row', async () => {
  const statements = [];
  const mockD1 = createMockD1();
  const spy = {
    ...mockD1,
    prepare: (sql) => {
      statements.push(sql);
      return mockD1.prepare(sql);
    },
  };
  const store = new D1Store(spy);
  await store.init();
  statements.length = 0;

  const rows = Array.from({ length: 21 }, (_, i) => ({
    source_id: 'uw-food-daily-menu',
    external_id: `2026-09-21::REV::dish-${i}`,
    observed_at: now,
    valid_until: now + 1000,
    outlet: 'REV',
    dish: `Dish ${i}`,
    service_date: '2026-09-21',
  }));
  await store.upsertRows('menu_item', rows);

  const inserts = statements.filter((s) => s.startsWith('INSERT'));
  assert.ok(inserts.length <= 4, `21 dishes must not cost 21 queries, got ${inserts.length}`);
  assert.ok(inserts[0].includes('),('), 'a multi-row VALUES statement is what saves the query budget');
  assert.equal((await store.rows('menu_item')).length, 21);
});

test('D1Store skips the gzip when the body is already archived', async () => {
  const mockD1 = createMockD1();
  const store = new D1Store(mockD1);
  await store.init();

  const first = await store.saveSnapshot({ sourceId: 's', fetchedAt: now, contentType: 'text/html', body: '<html>menu</html>' });
  assert.equal(await store.hasSnapshot(first), true, 'the second poll can see it is already stored');
  await store.saveSnapshot({ sourceId: 's', fetchedAt: now + 1000, contentType: 'text/html', body: '<html>menu</html>' });
  assert.equal(await store.snapshotCount(), 1);
});

test('D1Store prunes old run receipts', async () => {
  const mockD1 = createMockD1();
  const store = new D1Store(mockD1);
  await store.init();

  await store.insertRun({ source_id: 's', started_at: now - 30 * 86_400_000, finished_at: now - 30 * 86_400_000, outcome: 'ok' });
  await store.insertRun({ source_id: 's', started_at: now, finished_at: now, outcome: 'ok' });

  assert.equal(await store.pruneRuns(now - 7 * 86_400_000), 1);
  const kept = await store.recentRuns(10);
  assert.equal(kept.length, 1);
});

test('init() skips the DDL when every table exists, and runs it when one is missing', async () => {
  const calls = { batch: 0 };
  const mockD1 = createMockD1();
  const spy = {
    ...mockD1,
    batch: async (stmts) => {
      calls.batch += 1;
      return mockD1.batch(stmts);
    },
  };

  const first = new D1Store(spy);
  await first.init();
  assert.equal(calls.batch, 1, 'a fresh database gets the schema');

  const second = new D1Store(spy);
  await second.init();
  assert.equal(calls.batch, 1, 'a database that already has every table pays no DDL');

  // drop a table, which is what an older deployment looks like after a new table is added
  await mockD1.exec('DROP TABLE setting');
  const third = new D1Store(spy);
  await third.init();
  assert.equal(calls.batch, 2, 'a missing table means the DDL runs again, so old databases self-heal');
  await third.setSetting('LEARN_ICS_URL', 'https://learn.test/feed.ics');
  assert.equal((await third.settings()).length, 1);
});

test('D1 atomically reserves the AI daily allowance without allowing concurrent overspend', async () => {
  const db = createMockD1();
  const store = new D1Store(db);
  await store.init();
  const results = await Promise.all([store.reserveAiBudget('2026-09-23', 4000, 7000), store.reserveAiBudget('2026-09-23', 4000, 7000)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await store.aiUsage('2026-09-23')).reserved_neurons, 4000);
});

test('snapshot retention keeps bodies referenced by recent run receipts', async () => {
  const db = createMockD1();
  const store = new D1Store(db);
  await store.init();
  const old = now - 30 * 86_400_000;
  const referenced = await store.saveSnapshot({ sourceId: 's', fetchedAt: old, contentType: 'text/plain', body: 'referenced' });
  const unreferenced = await store.saveSnapshot({ sourceId: 's', fetchedAt: old, contentType: 'text/plain', body: 'unreferenced' });
  await store.insertRun({ source_id: 's', started_at: now, finished_at: now, outcome: 'ok', body_sha256: referenced });
  assert.equal(await store.pruneSnapshots(now - 7 * 86_400_000), 1);
  assert.equal(await store.hasSnapshot(referenced), true);
  assert.equal(await store.hasSnapshot(unreferenced), false);
});

test('existing D1 databases gain receipt indexes and latest runs use scheduled sources', async () => {
  const db = createMockD1();
  const store = new D1Store(db);
  await store.init();
  await store.scheduleJob('uw-status', now);
  await store.insertRun({ source_id: 'uw-status', started_at: now, finished_at: now, outcome: 'ok' });
  await store.insertRun({ source_id: 'uw-status', started_at: now + 1000, finished_at: now + 1000, outcome: 'failed' });
  assert.equal((await store.lastRunPerSource())[0].outcome, 'failed');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('idx_source_run_source_id','idx_source_run_finished')").first()).n, 2);
  await db.exec('DROP INDEX idx_source_run_finished');
  const migrated = new D1Store(db);
  await migrated.init();
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='idx_source_run_finished'").first()).n, 1);
});

test('buildDashboard works end-to-end on D1Store', async () => {
  const mockD1 = createMockD1();
  const store = new D1Store(mockD1);
  await store.init();

  const t = (h) => Date.UTC(2026, 8, 21, h);
  await store.upsertRows('timeline_event', [
    { source_id: 'uw-portal-ics', external_id: 'c1', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'class', title: 'ECE 150 LEC 001', location: 'E7 2317', starts_at: t(18), ends_at: t(19) },
    { source_id: 'uw-learn-ics', external_id: 'd1', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'deadline', title: 'ECE 150 - Assignment 3 due', starts_at: t(30), ends_at: t(30) },
  ]);
  await store.upsertRows('menu_item', [
    { source_id: 'uw-food-daily-menu', external_id: '2026-09-21::REV::Soup', observed_at: now - 3600_000, valid_until: now + 12 * 3600_000, outlet: 'REVelation - Residence Dining Hall', dish: 'Soup', service_date: '2026-09-21' },
  ]);

  const bundle = await buildDashboard(store, { now, useWeather: false });
  assert.equal(bundle.cards.length, 4);
  const next = bundle.cards.find((c) => c.type === 'next_commitment');
  const food = bundle.cards.find((c) => c.type === 'food');
  const due = bundle.cards.find((c) => c.type === 'due_soon');

  assert.equal(next.data.title, 'ECE 150 LEC 001');
  assert.equal(food.data.total_dishes, 1);
  assert.equal(due.data.count, 1);
});
