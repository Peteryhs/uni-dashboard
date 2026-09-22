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

const SETTING_KEYS = ['PORTAL_ICS_URL', 'GOOGLE_CALENDAR_ICS_URL', 'LEARN_ICS_URL', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'RELAY_TOKEN'];

/** Settings land in process.env, which is shared by the whole test process, so clean up after. */
function clearEnvSettings() {
  for (const k of SETTING_KEYS) delete process.env[k];
}

test('credentials saved from the app land in D1 and configure the feeds', async (t) => {
  t.after(clearEnvSettings);
  const { api } = createMockD1();
  const env = { DB: api };

  const before = await (await worker.fetch(new Request('https://dash.test/v1/credentials'), env, {})).json();
  assert.equal(before.portal.configured, false);
  assert.equal(before.writable, true, 'the app can configure a Worker deployment now');

  const portal = 'https://calendar.google.com/calendar/ical/secret/basic.ics';
  const post = await worker.fetch(
    new Request('https://dash.test/v1/credentials', {
      method: 'POST',
      body: JSON.stringify({ PORTAL_ICS_URL: portal, LEARN_ICS_URL: 'https://learn.test/feed.ics?token=abc' }),
    }),
    env,
    {},
  );
  assert.equal(post.status, 200);
  const posted = await post.json();
  assert.equal(posted.ok, true);
  assert.equal(posted.portal_configured, true);

  const after = await worker.fetch(new Request('https://dash.test/v1/credentials'), env, {});
  const status = await after.json();
  assert.equal(status.portal.configured, true);
  assert.equal(status.portal.source, 'saved in the app');
  assert.equal(status.learn.configured, true);
  assert.ok(!JSON.stringify(status).includes(portal), 'the saved URL must never come back out of the API');
  assert.ok(!JSON.stringify(status).includes('token=abc'));
});

test('the saved feeds actually configure the sources', async (t) => {
  t.after(clearEnvSettings);
  const { api } = createMockD1();
  const env = { DB: api };

  const blocked = await (await worker.fetch(new Request('https://dash.test/v1/health/sources'), env, {})).json();
  assert.equal(blocked.sources.find((s) => s.id === 'uw-learn-ics').ready, false);

  await worker.fetch(
    new Request('https://dash.test/v1/credentials', {
      method: 'POST',
      body: JSON.stringify({ LEARN_ICS_URL: 'https://learn.test/feed.ics' }),
    }),
    env,
    {},
  );

  const ready = await (await worker.fetch(new Request('https://dash.test/v1/health/sources'), env, {})).json();
  const learn = ready.sources.find((s) => s.id === 'uw-learn-ics');
  assert.equal(learn.ready, true, 'a feed URL saved from the app must satisfy the source that needs it');
  assert.equal(learn.blocked_by, '');
});

test('a saved credential is validated before it becomes an environment variable', async (t) => {
  t.after(clearEnvSettings);
  const { api } = createMockD1();
  const env = { DB: api };

  const notHttps = await worker.fetch(
    new Request('https://dash.test/v1/credentials', { method: 'POST', body: JSON.stringify({ PORTAL_ICS_URL: 'http://portal.test/feed.ics' }) }),
    env,
    {},
  );
  assert.equal(notHttps.status, 400);

  const injection = await worker.fetch(
    new Request('https://dash.test/v1/credentials', {
      method: 'POST',
      body: JSON.stringify({ PORTAL_ICS_URL: 'https://ok.test/feed.ics\nRELAY_TOKEN=attacker' }),
    }),
    env,
    {},
  );
  assert.equal(injection.status, 400, 'whitespace would smuggle a second variable');
  assert.equal(process.env.RELAY_TOKEN, undefined);
});

test('an empty value clears a saved credential', async (t) => {
  t.after(clearEnvSettings);
  const { api } = createMockD1();
  const env = { DB: api };

  await worker.fetch(
    new Request('https://dash.test/v1/credentials', { method: 'POST', body: JSON.stringify({ LEARN_ICS_URL: 'https://learn.test/feed.ics' }) }),
    env,
    {},
  );
  const cleared = await worker.fetch(
    new Request('https://dash.test/v1/credentials', { method: 'POST', body: JSON.stringify({ LEARN_ICS_URL: '' }) }),
    env,
    {},
  );
  assert.equal(cleared.status, 200);
  const status = await (await worker.fetch(new Request('https://dash.test/v1/credentials'), env, {})).json();
  assert.equal(status.learn.configured, false);
});

test('a token saved from the app gates the very next request', async (t) => {
  t.after(clearEnvSettings);
  const { api } = createMockD1();
  const env = { DB: api };

  // no token yet, so /v1 is open and the app can set one
  const open = await worker.fetch(new Request('https://dash.test/v1/dashboard'), env, {});
  assert.equal(open.status, 200);

  const saved = await worker.fetch(
    new Request('https://dash.test/v1/credentials', { method: 'POST', body: JSON.stringify({ RELAY_TOKEN: 'app-token-123' }) }),
    env,
    {},
  );
  assert.equal(saved.status, 200);

  const blocked = await worker.fetch(new Request('https://dash.test/v1/dashboard'), env, {});
  assert.equal(blocked.status, 401, 'the token saved in the app must gate the next request');

  const allowed = await worker.fetch(
    new Request('https://dash.test/v1/dashboard', { headers: { authorization: 'Bearer app-token-123' } }),
    env,
    {},
  );
  assert.equal(allowed.status, 200);
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
