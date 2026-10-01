import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { getSetupStatus, SETUP_STARTED_AT, SETUP_SCHEDULE_CHANGED_AT } from '../apps/relay/src/setup-status.mjs';
import { createServer } from '../apps/relay/src/server.mjs';

const sources = ({ schedule = null, learn = null } = {}) => [
  { id: 'uw-portal-ics', url: () => schedule },
  { id: 'uw-learn-ics', url: () => learn },
];

function run(source_id, outcome, rows_written = 0) {
  return { source_id, started_at: 1, finished_at: 2, outcome, rows_written };
}

test('a fresh empty database is marked once and reports first_run', async () => {
  const store = new SqliteStore(':memory:');
  try {
    const status = await getSetupStatus(store, { sources: sources(), now: 1234 });
    assert.deepEqual(status, {
      data_empty: true, first_run: true,
      schedule_configured: false, learn_configured: false,
      schedule_synced: false, learn_synced: false, setup_needed: true,
    });
    assert.equal(store.getSetting(SETUP_STARTED_AT), '1234');
    assert.equal((await getSetupStatus(store, { sources: sources(), now: 5678 })).first_run, false);
  } finally { store.close(); }
});

test('any live canonical row means data is not empty, even outside the current window', async () => {
  const store = new SqliteStore(':memory:');
  try {
    store.upsertRows('notice', [{ source_id: 'uw-status', external_id: 'old', observed_at: 1, valid_until: 2, title: 'old' }]);
    const status = await getSetupStatus(store, { sources: sources(), now: Date.now() });
    assert.equal(status.data_empty, false);
    assert.equal(status.first_run, false);
  } finally { store.close(); }
});

test('configured feeds remain unsynced until their latest run succeeds', async () => {
  const store = new SqliteStore(':memory:');
  try {
    const configured = sources({ schedule: 'https://schedule.test/feed', learn: 'https://learn.test/feed' });
    let status = await getSetupStatus(store, { sources: configured, now: 1 });
    assert.equal(status.schedule_configured, true);
    assert.equal(status.learn_configured, true);
    assert.equal(status.schedule_synced, false);
    store.insertRun(run('uw-portal-ics', 'empty'));
    store.insertRun(run('uw-learn-ics', 'failed'));
    status = await getSetupStatus(store, { sources: configured, now: 2 });
    assert.equal(status.schedule_synced, true, 'empty is a valid successful feed result');
    assert.equal(status.learn_synced, false, 'a failed latest run is not synced');
    store.insertRun(run('uw-learn-ics', 'empty'));
    assert.equal((await getSetupStatus(store, { sources: configured, now: 3 })).setup_needed, false);
  } finally { store.close(); }
});

test('public cron data after fresh detection keeps onboarding actionable until both core feeds sync', async () => {
  const store = new SqliteStore(':memory:');
  try {
    const configured = sources({ schedule: 'https://schedule.test/feed', learn: 'https://learn.test/feed' });
    assert.equal((await getSetupStatus(store, { sources: configured, now: 1 })).first_run, true);
    store.upsertRows('notice', [{ source_id: 'uw-status', external_id: 'notice', observed_at: 1, valid_until: 2, title: 'All clear' }]);
    assert.equal((await getSetupStatus(store, { sources: configured, now: 2 })).setup_needed, true);
    store.insertRun(run('uw-portal-ics', 'ok', 1));
    store.insertRun(run('uw-learn-ics', 'empty'));
    assert.equal((await getSetupStatus(store, { sources: configured, now: 3 })).setup_needed, false);
  } finally { store.close(); }
});

test('a previously initialized database whose live rows were cleared is not first_run', async () => {
  const store = new SqliteStore(':memory:');
  try {
    store.insertRun(run('uw-portal-ics', 'ok', 4));
    const status = await getSetupStatus(store, { sources: sources(), now: 1 });
    assert.equal(status.data_empty, true);
    assert.equal(status.first_run, false);
    assert.equal(store.getSetting(SETUP_STARTED_AT), null);
  } finally { store.close(); }
});

test('a populated database missing feeds does not need onboarding', async () => {
  const store = new SqliteStore(':memory:');
  try {
    store.upsertRows('notice', [{ source_id: 'uw-status', external_id: 'old', observed_at: 1, valid_until: 2, title: 'old' }]);
    const status = await getSetupStatus(store, { sources: sources(), now: 1 });
    assert.equal(status.first_run, false);
    assert.equal(status.setup_needed, false);
  } finally { store.close(); }
});

test('durable user settings also distinguish an initialized empty database', async () => {
  const store = new SqliteStore(':memory:');
  try {
    store.setSetting('COURSE_LIBRARY_JSON', '{}', 1);
    const status = await getSetupStatus(store, { sources: sources(), now: 2 });
    assert.equal(status.data_empty, true);
    assert.equal(status.first_run, false);
    assert.equal(store.getSetting(SETUP_STARTED_AT), null);
  } finally { store.close(); }
});

test('replacing a feed invalidates older successes until a run starts after the change', async () => {
  const store = new SqliteStore(':memory:');
  try {
    const configured = sources({ schedule: 'https://new.test/feed', learn: 'https://learn.test/feed' });
    store.setSetting(SETUP_SCHEDULE_CHANGED_AT, '100', 100);
    store.insertRun({ ...run('uw-portal-ics', 'ok', 2), started_at: 90, finished_at: 200 });
    store.insertRun({ ...run('uw-learn-ics', 'empty'), started_at: 101, finished_at: 102 });
    assert.equal((await getSetupStatus(store, { sources: configured, now: 201 })).schedule_synced, false);
    store.insertRun({ ...run('uw-portal-ics', 'empty'), started_at: 101, finished_at: 202 });
    assert.equal((await getSetupStatus(store, { sources: configured, now: 203 })).schedule_synced, true);
  } finally { store.close(); }
});

test('local GET /v1/setup exposes only the setup contract', async () => {
  const store = new SqliteStore(':memory:');
  const server = createServer({ store, sources: sources(), serveWeb: false, automaticPolling: false, log: () => {} }).server;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/setup`);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(await response.json()).sort(), [
      'data_empty', 'first_run', 'learn_configured', 'learn_synced',
      'schedule_configured', 'schedule_synced', 'setup_needed',
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
