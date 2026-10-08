import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { D1Store } from '../apps/relay/src/d1-store.mjs';
import { pollDue } from '../apps/relay/src/worker.mjs';
import { pollSource, reconcilePolling, sourcePollingPolicy } from '../apps/relay/src/polling.mjs';
import { createServer } from '../apps/relay/src/server.mjs';
import http from 'node:http';

function binding() {
  const db = new DatabaseSync(':memory:');
  return { raw: db, async exec(sql) { db.exec(sql); }, prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async first() { return db.prepare(sql).get(...args) ?? null; } };
  }, async batch(statements) { return Promise.all(statements.map(statement => statement.run())); } };
}

function source(id, overrides = {}) {
  let calls = 0;
  return { id, shape: 'notice', cadenceMs: 12 * 3600_000, needsSecret: false,
    get calls() { return calls; },
    async fetchRaw() { calls++; return { status: 200, contentType: 'text/plain', body: 'trusted', bytes: 7 }; },
    plausible() { return { ok: true }; },
    parse() { return { rows: [{ source_id: id, external_id: id, observed_at: Date.now(),
      valid_until: Date.now() + 60_000, severity: 'info', title: id }], meta: {} }; }, ...overrides };
}

test('manual local relay reads stay offline until an explicit source refresh', async t => {
  const store = new SqliteStore(':memory:');
  const s = source('manual-only');
  const { server } = createServer({ store, sources: [s], automaticPolling: false, serveWeb: false, token: '', log: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const request = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method }, res => {
      let body = '';
      res.on('data', value => { body += value; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
  for (const path of ['/v1/health/sources', '/v1/dashboard', '/v1/calendar']) assert.equal((await request(path)).status, 200);
  assert.equal(s.calls, 0);
  assert.equal(store.jobs().length, 0, 'read-only local mode never creates poll jobs');
  const refreshed = await request('/v1/poll?source=manual-only', 'POST');
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.receipts[0].outcome, 'ok');
  assert.equal(s.calls, 1);
});

for (const kind of ['SQLite', 'D1']) {
  async function open(t) {
    const api = kind === 'D1' ? binding() : null;
    const store = api ? new D1Store(api) : new SqliteStore(':memory:');
    if (api) await store.init();
    t.after(() => api ? api.raw.close() : store.close());
    return { store, db: api?.raw ?? store.db };
  }

  test(`${kind}: missing jobs run in their first tick and disabled/unconfigured jobs stay idle`, async t => {
    const { store } = await open(t);
    const enabled = source('enabled');
    const disabled = source('disabled', { disabled: true });
    const blocked = source('blocked', { needsSecret: true, url: () => null });
    await store.scheduleJob(disabled.id, 1);
    await store.scheduleJob(blocked.id, 1);
    const result = await pollDue(store, Date.now(), 2, [enabled, disabled, blocked]);
    assert.deepEqual(result.receipts.map(row => row.source_id), ['enabled']);
    assert.equal(enabled.calls, 1);
    assert.equal(disabled.calls + blocked.calls, 0);
    assert.equal(result.repairs[0].reason, 'missing_job');
  });

  test(`${kind}: stale data repairs a future orphaned cadence but preserves explicit failure backoff`, async t => {
    const { store } = await open(t);
    const now = Date.now();
    const healthy = source('stale', { cadenceMs: 60_000 });
    const limited = source('limited', { cadenceMs: 60_000 });
    await store.insertRun({ source_id: healthy.id, started_at: now - 240_000, finished_at: now - 240_000, outcome: 'ok' });
    await store.scheduleJob(healthy.id, now + 8 * 3600_000);
    await store.insertRun({ source_id: limited.id, started_at: now, finished_at: now, outcome: 'failed', http_status: 503 });
    await store.recordJobResult(limited.id, { startedAt: now, finishedAt: now, outcome: 'failed',
      httpStatus: 503, retryAfterMs: 2 * 3600_000, cadenceMs: 60_000, now });
    const result = await reconcilePolling(store, [healthy, limited], now);
    assert.deepEqual(result.ready.map(row => row.id), ['stale']);
    assert.equal(result.repairs[0].reason, 'stale');
    assert.ok((await store.jobs()).find(row => row.source_id === limited.id).next_due_at >= now + 2 * 3600_000);
  });

  test(`${kind}: partial and skipped stale responses back off, then complete success resets failures`, async t => {
    const { store } = await open(t);
    const s = source('partial', { parse() { return { rows: [], meta: { skipped_events: 2 } }; } });
    await pollDue(store, Date.now(), 2, [s]);
    const partial = (await store.jobs())[0];
    assert.equal(partial.last_outcome, 'partial');
    assert.equal(partial.consecutive_failures, 1);
    assert.ok(partial.next_due_at - partial.last_finished_at >= 30_000);
    assert.ok(partial.next_due_at - partial.last_finished_at < 60_000);
    const now = Date.now();
    await store.recordJobResult(s.id, { startedAt: now, finishedAt: now, outcome: 'skipped', cadenceMs: s.cadenceMs, now });
    assert.equal((await store.jobs())[0].consecutive_failures, 2);
    await store.recordJobResult(s.id, { startedAt: now, finishedAt: now, outcome: 'empty', cadenceMs: s.cadenceMs, now });
    assert.equal((await store.jobs())[0].consecutive_failures, 0);
    assert.equal((await store.jobs())[0].next_due_at, now + s.cadenceMs, 'valid empty calendar respects its slow cadence');
  });

  test(`${kind}: expired interrupted jobs recover, while an active claim is preserved`, async t => {
    const { store } = await open(t);
    const now = Date.now();
    const expired = source('expired');
    const active = source('active');
    for (const s of [expired, active]) await store.scheduleJob(s.id, now + 3600_000);
    await store.claimSource(expired.id, { now: now - 60_000, leaseNow: now - 60_000, leaseMs: 1000 });
    await store.claimSource(active.id, { now, leaseMs: 60_000 });
    const result = await reconcilePolling(store, [expired, active], now);
    assert.deepEqual(result.ready.map(row => row.id), ['expired']);
    assert.equal(result.repairs[0].reason, 'interrupted');
    assert.equal((await store.jobs()).find(row => row.source_id === active.id).next_due_at, now + 3600_000);
  });

  test(`${kind}: interrupted recovery cannot overwrite a new lease generation`, async t => {
    const { store } = await open(t);
    const now = Date.now();
    const old = await store.claimSource('fenced', { now });
    await store.releaseSource('fenced', old.token, now + 1);
    const newer = await store.claimSource('fenced', { now: now + 2 });
    const result = await store.recordJobResult('fenced', { startedAt: now, finishedAt: now + 3,
      outcome: 'failed', cadenceMs: 60_000, now: now + 3, claimToken: old.token, interrupted: true });
    assert.equal(result.applied, false);
    assert.equal(await store.sourceLeaseOwned('fenced', newer.token, now + 3), true);
    assert.equal((await store.jobs())[0].consecutive_failures, 0);
  });

  test(`${kind}: a storage failure backs off its source without aborting the remaining sources`, async t => {
    const { store } = await open(t);
    const bad = source('broken');
    const good = source('good');
    const commit = store.commitSourceResult.bind(store);
    store.commitSourceResult = input => {
      if (input.sourceId === bad.id) throw new Error('synthetic write failure');
      return commit(input);
    };
    const result = await pollDue(store, Date.now(), 2, [bad, good]);
    assert.deepEqual(result.receipts.map(row => row.outcome), ['failed', 'ok']);
    assert.equal(good.calls, 1);
    const job = (await store.jobs()).find(row => row.source_id === bad.id);
    assert.equal(job.consecutive_failures, 1);
    assert.ok(job.next_due_at >= job.last_finished_at + 30_000);
  });

  test(`${kind}: manual refresh and legacy scheduler recovery respect Google minimums and Retry-After`, async t => {
    const { store } = await open(t);
    const s = source('google', { url: () => 'https://calendar.google.com/calendar/ical/private/basic.ics', cadenceMs: 6 * 3600_000 });
    const now = Date.now();
    await store.recordJobResult(s.id, { startedAt: now, finishedAt: now, outcome: 'failed', cadenceMs: s.cadenceMs, now });
    const repaired = await reconcilePolling(store, [s], now);
    assert.equal(repaired.ready.length, 0);
    assert.ok((await store.jobs())[0].next_due_at >= now + 6 * 3600_000);
    const receipt = await pollSource(store, s, { manual: true });
    assert.equal(receipt.meta.poll_claim, 'deferred');
    assert.ok(receipt.meta.next_due_at >= now + 6 * 3600_000);
    assert.equal(s.calls, 0);
    await store.recordJobResult(s.id, { startedAt: now, finishedAt: now, outcome: 'failed', httpStatus: 503,
      retryAfterMs: 24 * 3600_000, ...sourcePollingPolicy(s), now });
    assert.ok((await pollSource(store, s, { manual: true })).meta.next_due_at >= now + 24 * 3600_000);
  });

  test(`${kind}: reconstructed missing jobs retain provider Retry-After from durable receipts`, async t => {
    const { store } = await open(t);
    const s = source('missing-limited');
    const now = Date.now();
    await store.insertRun({ source_id: s.id, started_at: now, finished_at: now,
      outcome: 'failed', http_status: 503, retry_after_ms: 24 * 3600_000 });
    const result = await reconcilePolling(store, [s], now);
    assert.equal(result.ready.length, 0);
    assert.ok((await store.jobs())[0].next_due_at >= now + 24 * 3600_000);
  });

  test(`${kind}: shared Google aliases keep one lease and inherit the subscription backoff`, async t => {
    const { store } = await open(t);
    const url = 'https://calendar.google.com/calendar/ical/shared/private.ics';
    const first = source('first', { url: () => url });
    const alias = source('alias', { url: () => url });
    const now = Date.now();
    await store.recordJobResult(alias.id, { startedAt: now, finishedAt: now, outcome: 'failed',
      httpStatus: 429, retryAfterMs: 24 * 3600_000, cadenceMs: alias.cadenceMs, now });
    const result = await reconcilePolling(store, [first, alias], now);
    assert.equal(result.ready.length, 0, 'a missing canonical job cannot bypass an alias rate limit');
    const refresh = await pollSource(store, alias, { manual: true, sources: [first, alias] });
    assert.equal(refresh.source_id, first.id, 'the shared feed always uses one canonical lease');
    assert.equal(refresh.meta.poll_claim, 'deferred');
    assert.equal(first.calls + alias.calls, 0);
  });

  test(`${kind}: schedule repair cannot overwrite a completed newer generation with the same due time`, async t => {
    const { store } = await open(t);
    const now = Date.now();
    await store.scheduleJob('generation', now);
    const old = (await store.jobs())[0];
    const claim = await store.claimSource('generation', { now });
    await store.releaseSource('generation', claim.token, now + 1);
    const applied = await store.repairJob('generation', now - 1, {
      expectedNextDueAt: old.next_due_at, expectedStartedAt: old.last_started_at,
      expectedFinishedAt: old.last_finished_at, now: now + 2 });
    assert.equal(applied, false);
    assert.equal((await store.jobs())[0].next_due_at, now);
  });

  for (const manual of [false, true]) {
    test(`${kind}: stale ${manual ? 'manual refresh' : 'scheduler'} selection cannot fetch after another poll completes`, async t => {
      const { store } = await open(t);
      const s = source('google-race', { cadenceMs: 6 * 3600_000,
        url: () => 'https://calendar.google.com/calendar/ical/race/private.ics' });
      const now = Date.now();
      await store.scheduleJob(s.id, now - 1);
      const selected = await reconcilePolling(store, [s], now);
      assert.equal(selected.ready.length, 1);
      const first = await pollSource(store, s, { jobs: selected.jobs, sources: [s] });
      assert.equal(first.outcome, 'ok');
      const completed = (await store.jobs())[0];
      assert.ok(completed.next_due_at >= completed.last_finished_at + 6 * 3600_000);
      // This caller resumes after its snapshot was taken but after the winner completed and
      // released its claim. A mere active-lease check would allow another immediate fetch.
      const resumed = await pollSource(store, s, { manual, jobs: selected.jobs, sources: [s] });
      assert.equal(resumed.outcome, 'skipped');
      assert.equal(s.calls, 1, 'atomic generation guard prevents the stale caller reaching Google');
      const retained = (await store.jobs())[0];
      assert.equal(retained.next_due_at, completed.next_due_at);
      assert.equal(retained.lease_token, completed.lease_token);
      assert.equal(retained.consecutive_failures, 0);
    });
  }
}
