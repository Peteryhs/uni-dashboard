import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { D1Store } from '../apps/relay/src/d1-store.mjs';
import worker, { pollDue } from '../apps/relay/src/worker.mjs';

/**
 * The D1 binding, mocked over node:sqlite, counting prepared statements so a test can assert the
 * Worker stays inside the free tier's 50 queries per invocation.
 */
function createMockD1(counter = { prepares: 0 }) {
  const db = new DatabaseSync(':memory:');
  const api = {
    async exec(q) {
      db.exec(q);
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
          const res = db.prepare(sql).run(...bound);
          return { success: true, meta: { changes: Number(res.changes ?? 0) } };
        },
        async all() {
          return { success: true, results: db.prepare(sql).all(...bound) };
        },
        async first(col) {
          const row = db.prepare(sql).get(...bound);
          if (!row) return null;
          return col ? row[col] : row;
        },
      };
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
  return { api, db, counter };
}

/** A source that returns `rowCount` rows without touching the network. */
function fakeSource(id, rowCount, cadenceMs = 15 * 60 * 1000) {
  return {
    id,
    shape: 'timeline_event',
    role: id,
    cadenceMs,
    needsSecret: false,
    url: () => 'https://example.test/feed',
    async fetchRaw() {
      return { status: 200, contentType: 'text/plain', body: `body for ${id}`, bytes: 12 };
    },
    plausible: () => ({ ok: true }),
    parse: () => ({
      rows: Array.from({ length: rowCount }, (_, i) => ({
        source_id: id,
        external_id: `${id}-${i}`,
        observed_at: Date.now(),
        valid_until: Date.now() + cadenceMs,
        kind: 'class',
        title: `${id} row ${i}`,
        starts_at: Date.now() + i * 60_000,
        ends_at: Date.now() + i * 60_000 + 300_000,
      })),
      meta: {},
    }),
  };
}

const now = Date.UTC(2026, 8, 22, 12);

test('a cron tick polls at most two sources and says which ones it deferred', async () => {
  const { api, counter } = createMockD1();
  const store = new D1Store(api);
  await store.init();

  const sources = [
    fakeSource('a', 20),
    fakeSource('b', 20),
    fakeSource('c', 20),
    fakeSource('d', 20),
  ];
  for (const s of sources) await store.scheduleJob(s.id, now - 1000);

  const afterInit = counter.prepares;
  const { receipts, deferred } = await pollDue(store, now, 2, sources);

  assert.equal(receipts.length, 2, 'two sources per tick');
  assert.deepEqual(deferred, ['c', 'd'], 'the rest stay due and are reported, not silently dropped');
  const queries = counter.prepares - afterInit;
  assert.ok(queries <= 50, `a tick must stay inside the free tier budget, used ${queries}`);
});

test('a cron tick with the cap removed would not fit the free tier budget', async () => {
  const { api, counter } = createMockD1();
  const store = new D1Store(api);
  await store.init();

  // the real ICS feeds expand to about 80 rows per poll, which is the expensive case
  const sources = [
    fakeSource('portal', 80),
    fakeSource('learn', 80),
    fakeSource('food', 20),
    fakeSource('status', 1),
  ];
  for (const s of sources) await store.scheduleJob(s.id, now - 1000);

  const afterInit = counter.prepares;
  await pollDue(store, now, 4, sources);
  const queries = counter.prepares - afterInit;
  assert.ok(queries > 50, `uncapped, all four sources cost ${queries} queries: this is why the cap exists`);
});

test('the dashboard route answers with four cards and stays inside the query budget', async () => {
  const { api, counter } = createMockD1();
  const env = { DB: api };
  const res = await worker.fetch(new Request('https://dash.test/v1/dashboard'), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cards.length, 4);
  // measured 21: the schema probe, four card queries, the run receipts and the job table
  assert.ok(counter.prepares < 50, `a dashboard load used ${counter.prepares} queries, free tier allows 50`);
});

test('the health route is open and the shell falls back when there are no assets', async () => {
  const { api } = createMockD1();
  const env = { DB: api };

  const health = await worker.fetch(new Request('https://dash.test/healthz'), env, {});
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const shell = await worker.fetch(new Request('https://dash.test/'), env, {});
  assert.equal(shell.status, 404, 'no ASSETS binding in this test, so the shell route is honest about it');
});

test('a bearer token gates /v1 and leaves /healthz open', async () => {
  const { api } = createMockD1();
  const env = { DB: api, RELAY_TOKEN: 'secret-token' };

  const blocked = await worker.fetch(new Request('https://dash.test/v1/dashboard'), env, {});
  assert.equal(blocked.status, 401);

  const wrong = await worker.fetch(
    new Request('https://dash.test/v1/dashboard', { headers: { authorization: 'Bearer nope' } }),
    env,
    {},
  );
  assert.equal(wrong.status, 401);

  const allowed = await worker.fetch(
    new Request('https://dash.test/v1/dashboard', { headers: { authorization: 'Bearer secret-token' } }),
    env,
    {},
  );
  assert.equal(allowed.status, 200);
  assert.equal((await worker.fetch(new Request('https://dash.test/healthz'), env, {})).status, 200);
});

test('credentials are read-only on a Worker, and say so instead of pretending', async () => {
  const { api } = createMockD1();
  const env = { DB: api };

  const get = await worker.fetch(new Request('https://dash.test/v1/credentials'), env, {});
  assert.equal(get.status, 200);
  assert.equal((await get.json()).writable, false);

  const post = await worker.fetch(
    new Request('https://dash.test/v1/credentials', { method: 'POST', body: '{}' }),
    env,
    {},
  );
  assert.equal(post.status, 501, 'a .env write path does not exist here: wrangler secret put is the answer');
});

test('the AI route fails loudly when there is no binding and no REST credentials', async () => {
  const { api } = createMockD1();
  const store = new D1Store(api);
  await store.init();
  await store.upsertRows('menu_item', [
    { source_id: 'uw-food-daily-menu', external_id: 'd1', observed_at: now, valid_until: now + 1000, outlet: 'REV', dish: 'Soup', service_date: '2026-09-22' },
  ]);
  const env = { DB: api };

  const res = await worker.fetch(
    new Request('https://dash.test/v1/ai/rank-food', { method: 'POST', body: JSON.stringify({ date: '2026-09-22' }) }),
    env,
    {},
  );
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /credentials not configured/i);
});
