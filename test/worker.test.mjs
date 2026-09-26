import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { D1Store } from '../apps/relay/src/d1-store.mjs';
import worker, { pollDue } from '../apps/relay/src/worker.mjs';
import { syncAlertSummary } from '../apps/relay/src/alert-summary.mjs';
import { saveFoodProfile, syncFoodRecommendation } from '../apps/relay/src/food-recommendation.mjs';
import { clearAiCache } from '../apps/relay/src/ai.mjs';
import { syncWeather } from '../apps/relay/src/weather-cache.mjs';

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

test('a poll preserves future due times instead of rescheduling healthy feeds every minute', async () => {
  const { api } = createMockD1();
  const store = new D1Store(api);
  await store.init();
  const sources = [fakeSource('slow', 1, 12 * 3600_000), fakeSource('fast', 1, 60_000)];
  const slowDue = now + 12 * 3600_000;
  await store.scheduleJob('slow', slowDue);
  await store.scheduleJob('fast', now - 1);
  const result = await pollDue(store, now, 2, sources);
  assert.deepEqual(result.receipts.map((receipt) => receipt.source_id), ['fast']);
  assert.equal((await store.jobs()).find((job) => job.source_id === 'slow').next_due_at, slowDue);
});

test('one large source poll plus new AI and weather work fits the 50-query Worker limit', async () => {
  const { api, counter } = createMockD1();
  const store = new D1Store(api);
  await store.init();
  await store.scheduleJob('large', now - 1);
  await store.upsertRows('notice', [{ source_id: 'uw-status', external_id: 'incident-1', observed_at: now, valid_until: now + 60_000,
    severity: 'major', title: 'Network outage', body: 'Campus wired network is affected.' }]);
  await store.upsertRows('menu_item', [{ source_id: 'uw-food-daily-menu', external_id: 'dish-1', observed_at: now, valid_until: now + 43_200_000,
    service_date: '2026-09-22', outlet: 'Cafe', dish: 'Noodles' }]);
  const env = { AI: { run: async (_model, payload) => {
    if (payload.messages[0].content.includes('Summarize university service incidents')) return { response: '{"summary":"The campus wired network is affected."}' };
    return { response: '{"headline":"Try noodles.","top_outlet":"Cafe","ranked_outlets":[{"outlet":"Cafe","rank":1,"match_score":80,"verdict":"A good option.","highlights":[]}],"tip":""}' };
  } } };
  const before = counter.prepares;
  await pollDue(store, now, 2, [fakeSource('large', 80)]);
  await syncAlertSummary(store, { cfEnv: env, now });
  await syncFoodRecommendation(store, { cfEnv: env, now });
  await syncWeather(store, { now, fetchForecast: async () => new Map([[now, { temp_c: 18, precip_prob: 10 }]]) });
  assert.ok(counter.prepares - before + 2 <= 50, `a light cron with AI/weather used ${counter.prepares - before} queries plus schema/settings probes`);
});

test('scheduled Worker completes a light tick and checks background food AI', async () => {
  const { api } = createMockD1();
  const store = new D1Store(api);
  await store.init();
  await store.setSetting('WEATHER_FORECAST_JSON', JSON.stringify({ observed_at: Date.now(), forecast: [{ at: Date.now(), temp_c: 18 }] }));
  const env = { DB: api, AI: { run: async () => { throw new Error('no menu should call AI'); } } };
  await assert.doesNotReject(worker.scheduled({ cron: '* * * * *' }, env, {}));
});

test('the calendar route serves validated days and rejects invalid ranges', async () => {
  const { api, counter } = createMockD1();
  const env = { DB: api };
  const seeded = new D1Store(api);
  await seeded.init();
  await seeded.upsertRows('timeline_event', [{
    source_id: 'uw-portal-ics', external_id: 'class-1', observed_at: now,
    valid_until: now + 900_000, kind: 'class', title: 'ECE 150 LEC 001',
    starts_at: Date.parse('2026-09-22T14:00:00Z'), ends_at: Date.parse('2026-09-22T15:00:00Z'),
  }]);
  const before = counter.prepares;
  const response = await worker.fetch(new Request('https://dash.test/v1/calendar?start=2026-09-22&days=2'), env, {});
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.days.map((day) => day.events.length), [1, 0]);
  assert.equal(data.days[0].events[0].category, 'class');
  assert.ok(counter.prepares - before < 50);
  const invalid = await worker.fetch(new Request('https://dash.test/v1/calendar?days=90'), env, {});
  assert.equal(invalid.status, 400);
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

  const tasks = [];
  const res = await worker.fetch(
    new Request('https://dash.test/v1/ai/rank-food', { method: 'POST', body: JSON.stringify({ date: '2026-09-22' }) }),
    env,
    { waitUntil: (task) => tasks.push(task) },
  );
  assert.equal(res.status, 202);
  await Promise.all(tasks);
  const job = await (await worker.fetch(new Request('https://dash.test/v1/ai/jobs?kind=food&scope=2026-09-22'), env, {})).json();
  assert.equal(job.status, 'failed');
  assert.match(job.error, /credentials not configured/i);
});

test('Worker manual food ranking persists matching results for the automatic recommendation reader', async () => {
  clearAiCache();
  const { api } = createMockD1();
  const store = new D1Store(api);
  await store.init();
  const serviceDate = '2026-09-22';
  await store.upsertRows('menu_item', [{
    source_id: 'uw-food-daily-menu', external_id: 'manual-dish', observed_at: now,
    valid_until: now + 43_200_000, service_date: serviceDate, outlet: 'REV', dish: 'Soup', diet: [], allergens: [],
  }]);
  const profile = await saveFoodProfile(store, { bio: 'soup fan' });
  let aiCalls = 0;
  let releaseAi;
  const aiGate = new Promise((resolve) => { releaseAi = resolve; });
  const env = { DB: api, AI: { run: async () => {
    aiCalls++;
    await aiGate;
    return { response: JSON.stringify({
      headline: 'Manual soup pick.',
      top_outlet: 'REV',
      ranked_outlets: [{ outlet: 'REV', rank: 1, match_score: 86, verdict: 'Soup fits your profile.', highlights: [] }],
      tip: '',
    }) };
  } } };

  const tasks = [];
  const context = { waitUntil: (task) => tasks.push(task) };
  const response = await worker.fetch(new Request('https://dash.test/v1/ai/rank-food', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasteProfile: { bio: 'ignored client input' }, model: profile.selectedAiModel, date: serviceDate, force: true }),
  }), env, context);
  assert.equal(response.status, 202);
  const queued = await response.json();
  assert.equal(queued.status, 'processing');

  // A fresh request after a page reload reads the job; a second click does not spend AI twice.
  const during = await (await worker.fetch(new Request(`https://dash.test/v1/food/recommendation?date=${serviceDate}`), env, {})).json();
  assert.equal(during.ranking_job.status, 'processing');
  assert.equal((await syncFoodRecommendation(store, { cfEnv: env, now: Date.now() })).cached, true, 'cron leaves a manual ranking in progress alone');
  const duplicate = await worker.fetch(new Request('https://dash.test/v1/ai/rank-food', {
    method: 'POST', body: JSON.stringify({ date: serviceDate }),
  }), env, context);
  assert.equal((await duplicate.json()).id, queued.id);
  assert.equal(tasks.length, 1);

  releaseAi();
  await Promise.all(tasks);

  const savedResponse = await worker.fetch(new Request(`https://dash.test/v1/food/recommendation?date=${serviceDate}`), env, {});
  const saved = await savedResponse.json();
  assert.equal(saved.status, 'ready');
  assert.equal(saved.ranking_job.status, 'ready');
  assert.equal(saved.recommendation.headline, 'Manual soup pick.');
  assert.equal((await syncFoodRecommendation(store, { cfEnv: env, now })).cached, true);
  assert.equal(aiCalls, 1, 'background ranking reuses the manual result under the shared signature');
});

test('AI syllabus review continues after its request and is readable on a fresh page', async () => {
  const { api } = createMockD1();
  let releaseAi;
  const aiGate = new Promise((resolve) => { releaseAi = resolve; });
  const env = { DB: api, AI: { run: async () => {
    await aiGate;
    return { response: JSON.stringify({ entries: [] }) };
  } } };
  const tasks = [];
  const response = await worker.fetch(new Request('https://dash.test/v1/courses/ECE%20150/syllabus/preview', {
    method: 'POST', body: JSON.stringify({ text: 'Sep 24, 2026: Quiz 1 covers loops', use_ai: true }),
  }), env, { waitUntil: (task) => tasks.push(task) });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  assert.equal(accepted.status, 'processing');
  const jobUrl = 'https://dash.test/v1/ai/jobs?kind=syllabus&scope=ECE%20150';
  assert.equal((await (await worker.fetch(new Request(jobUrl), env, {})).json()).status, 'processing');
  releaseAi();
  await Promise.all(tasks);
  const completed = await (await worker.fetch(new Request(jobUrl), env, {})).json();
  assert.equal(completed.status, 'ready');
  assert.equal(completed.result.method, 'ai');
  assert.equal(completed.result.syllabus.entries.length, 1);
});

test('raw HTML snapshots download as text rather than execute on the dashboard origin', async () => {
  const { api } = createMockD1();
  const store = new D1Store(api);
  await store.init();
  const sha = await store.saveSnapshot({ sourceId: 's', fetchedAt: now, contentType: 'text/html', body: '<script>alert(1)</script>' });
  const response = await worker.fetch(new Request(`https://dash.test/v1/snapshot/${sha}`), { DB: api }, {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  assert.match(response.headers.get('content-disposition'), /^attachment/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('Worker previews and saves a syllabus, serves guidance within query budget, and persists done and undo', async (t) => {
  t.after(clearEnvSettings);
  const { api, counter } = createMockD1();
  const env = { DB: api };
  const store = new D1Store(api);
  await store.init();
  const due = Date.now() + 4 * 3600_000;
  await store.upsertRows('timeline_event', [{ source_id: 'uw-learn-ics', external_id: 'quiz-two',
    observed_at: Date.now(), valid_until: Date.now() + 900_000, kind: 'deadline',
    title: 'ECE 150 - Quiz 2 - Due', location: 'ECE 150 - Fall 2026', starts_at: due, ends_at: due }]);
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(due);
  const preview = await worker.fetch(new Request('https://dash.test/v1/courses/ECE%20150/syllabus/preview', {
    method: 'POST', body: JSON.stringify({ text: `${localDate} | Topic: Recursion`, use_ai: false }) }), env, {});
  assert.equal(preview.status, 200);
  const parsed = await preview.json();
  assert.equal(parsed.syllabus.entries.length, 1);
  const saved = await worker.fetch(new Request('https://dash.test/v1/courses/ECE%20150/syllabus', {
    method: 'PUT', body: JSON.stringify(parsed.syllabus) }), env, {});
  assert.equal(saved.status, 200);
  const before = counter.prepares;
  const response = await worker.fetch(new Request('https://dash.test/v1/recommendations'), env, {});
  assert.equal(response.status, 200);
  assert.ok(counter.prepares - before < 50, `guidance used ${counter.prepares - before} D1 queries`);
  const feed = await response.json();
  assert.equal(feed.schema_version, 1);
  const task = feed.tasks.small.find((item) => item.title.includes('Quiz 2'));
  assert.ok(task);
  assert.equal(task.course, 'ECE 150');
  const actionUrl = 'https://dash.test/v1/recommendations/actions';
  const done = await worker.fetch(new Request(actionUrl, { method: 'POST', body: JSON.stringify({ id: task.id, action: 'done' }) }), env, {});
  assert.equal(done.status, 200);
  assert.equal((await (await worker.fetch(new Request('https://dash.test/v1/recommendations'), env, {})).json()).tasks.small.some((item) => item.id === task.id), false);
  const undo = await worker.fetch(new Request(actionUrl, { method: 'POST', body: JSON.stringify({ id: task.id, action: 'undo' }) }), env, {});
  assert.equal(undo.status, 200);
  assert.equal((await (await worker.fetch(new Request('https://dash.test/v1/recommendations'), env, {})).json()).tasks.small.some((item) => item.id === task.id), true);
});

test('syllabus import bounds request size before parsing or calling AI', async (t) => {
  t.after(clearEnvSettings);
  const { api } = createMockD1();
  let aiCalls = 0;
  const env = { DB: api, AI: { run: async () => { aiCalls++; throw new Error('should not run'); } } };
  const huge = await worker.fetch(new Request('https://dash.test/v1/courses/ECE%20150/syllabus/preview', {
    method: 'POST', body: JSON.stringify({ text: 'x'.repeat(300_001), use_ai: true }) }), env, {});
  assert.equal(huge.status, 413);
  assert.equal(aiCalls, 0);
});
