import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../apps/relay/src/worker.mjs';
import { D1Store } from '../apps/relay/src/d1-store.mjs';

function createMockD1() {
  const db = new DatabaseSync(':memory:');
  const api = {
    async exec(query) { db.exec(query); return { count: 0, duration: 0 }; },
    prepare(sql) {
      let bound = [];
      return {
        bind(...args) { bound = args; return this; },
        async run() { const result = db.prepare(sql).run(...bound); return { success: true, meta: { changes: Number(result.changes ?? 0), last_row_id: Number(result.lastInsertRowid ?? 0) } }; },
        async all() { return { success: true, results: db.prepare(sql).all(...bound) }; },
        async first(column) { const row = db.prepare(sql).get(...bound); if (!row) return null; return column ? row[column] : row; },
      };
    },
    async batch(statements) { const out = []; for (const statement of statements) out.push(await statement.run()); return out; },
  };
  return { db, api };
}

async function credentials(env, payload) {
  return worker.fetch(
    new Request('https://dash.test/v1/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    env,
    {},
  );
}

test('clearing a saved feed URL disconnects only that source and purges its cached data', async () => {
  const mock = createMockD1();
  const store = new D1Store(mock.api);
  await store.init();
  const now = Date.now();
  await store.setSetting('PORTAL_ICS_URL', 'https://synthetic.test/portal.ics', now);
  await store.setSetting('LEARN_ICS_URL', 'https://synthetic.test/learn.ics', now);
  await store.upsertRows('timeline_event', [
    { source_id: 'uw-portal-ics', external_id: 'portal-1', observed_at: now, valid_until: now + 60_000, kind: 'class', title: 'Portal class', starts_at: now, ends_at: now + 1 },
    { source_id: 'uw-learn-ics', external_id: 'learn-1', observed_at: now, valid_until: now + 60_000, kind: 'deadline', title: 'Learn deadline', starts_at: now, ends_at: now + 1 },
    { source_id: 'google-calendar-ics', external_id: 'google-1', observed_at: now, valid_until: now + 60_000, kind: 'event', title: 'Google event', starts_at: now, ends_at: now + 1 },
  ]);
  await store.scheduleJob('uw-portal-ics', now + 60_000);
  await store.scheduleJob('uw-learn-ics', now + 60_000);

  const response = await credentials({ DB: mock.api, ACCESS_DISABLED: '1' }, { PORTAL_ICS_URL: '' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.portal_configured, false, 'the cleared feed reports as disconnected');
  assert.equal(body.learn_configured, true, 'an untouched feed stays connected');
  assert.deepEqual(body.stored, [{ name: 'PORTAL_ICS_URL', cleared: true, purged_source: 'uw-portal-ics' }]);

  assert.deepEqual(
    (await store.rows('timeline_event', {})).map((row) => row.source_id).sort(),
    ['google-calendar-ics', 'uw-learn-ics'],
    'only the removed feed’s rows are gone',
  );
  assert.deepEqual((await store.jobs()).map((job) => job.source_id), ['uw-learn-ics']);
  assert.equal(await store.getSetting('PORTAL_ICS_URL'), null);
  assert.equal(await store.getSetting('LEARN_ICS_URL'), 'https://synthetic.test/learn.ics');
});

test('reconnecting a feed after removal schedules it again', async () => {
  const mock = createMockD1();
  const store = new D1Store(mock.api);
  await store.init();
  const env = { DB: mock.api, ACCESS_DISABLED: '1' };
  // Remove, then save a replacement. Saving a changed URL is what reconnects the source.
  await credentials(env, { GOOGLE_CALENDAR_ICS_URL: '' });
  assert.deepEqual((await store.jobs()).map((job) => job.source_id), [], 'removal clears the schedule');

  // The save path polls the changed feed immediately, so keep that poll off the network.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('synthetic upstream unavailable', { status: 503 });
  try {
    const response = await credentials(env, { GOOGLE_CALENDAR_ICS_URL: 'https://synthetic.test/new-google.ics' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).google_calendar_configured, true);
  } finally {
    globalThis.fetch = realFetch;
  }
  const job = (await store.jobs()).find((row) => row.source_id === 'google-calendar-ics');
  assert.ok(job, 'a reconnected feed has a schedule again');
  assert.equal(await store.getSetting('GOOGLE_CALENDAR_ICS_URL'), 'https://synthetic.test/new-google.ics');
});
