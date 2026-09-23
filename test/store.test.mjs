import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../apps/relay/src/store.mjs';

const now = Date.UTC(2026, 8, 21, 12);

test('upsert updates in place on the primary key', () => {
  const store = new SqliteStore(':memory:');
  store.upsertRows('menu_item', [
    { source_id: 's', external_id: 'd1', observed_at: 1, valid_until: 2, outlet: 'REV', dish: 'Soup', service_date: '2026-09-21' },
  ]);
  store.upsertRows('menu_item', [
    { source_id: 's', external_id: 'd1', observed_at: 5, valid_until: 9, outlet: 'REV', dish: 'Stew', service_date: '2026-09-21' },
  ]);
  const rows = store.rows('menu_item');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dish, 'Stew');
  assert.equal(rows[0].observed_at, 5);
});

test('numeric columns stay numbers through a round trip', () => {
  const store = new SqliteStore(':memory:');
  store.upsertRows('timeline_event', [
    { source_id: 's', external_id: 'e1', observed_at: now, valid_until: now + 1000, kind: 'class', title: 'x', starts_at: now, ends_at: now + 600000, all_day: false },
  ]);
  const [r] = store.rows('timeline_event');
  assert.equal(typeof r.starts_at, 'number', 'TEXT affinity here would break every client comparison');
  assert.equal(typeof r.ends_at, 'number');
  assert.equal(typeof r.all_day, 'boolean');
});

test('timeline rows are ordered before the limit is applied', () => {
  const store = new SqliteStore(':memory:');
  store.upsertRows('timeline_event', [
    { source_id: 's', external_id: 'a-later', observed_at: now, valid_until: now + 1000, kind: 'class', title: 'Later', starts_at: now + 3600_000, ends_at: now + 7200_000 },
    { source_id: 's', external_id: 'z-sooner', observed_at: now, valid_until: now + 1000, kind: 'class', title: 'Sooner', starts_at: now + 60_000, ends_at: now + 120_000 },
  ]);
  assert.equal(store.rows('timeline_event', { orderBy: 'starts_at', limit: 1 })[0].title, 'Sooner');
  assert.throws(() => store.rows('timeline_event', { orderBy: 'starts_at DESC' }), /invalid order column/);
  store.close();
});

test('a tombstoned row comes back to life when the source reports it again', () => {
  const store = new SqliteStore(':memory:');
  const row = { source_id: 's', external_id: 'e1', observed_at: 1, valid_until: 2, kind: 'class', title: 'x', starts_at: now, ends_at: now };
  store.upsertRows('timeline_event', [row]);
  assert.equal(store.tombstoneMissing('timeline_event', 's', []), 1);
  assert.equal(store.rows('timeline_event').length, 0);
  store.upsertRows('timeline_event', [row]);
  assert.equal(store.rows('timeline_event').length, 1);
});

test('tombstoning is per source, so one source cannot delete another source rows', () => {
  const store = new SqliteStore(':memory:');
  store.upsertRows('timeline_event', [
    { source_id: 'a', external_id: 'e1', observed_at: 1, valid_until: 2, kind: 'class', title: 'a', starts_at: now, ends_at: now },
    { source_id: 'b', external_id: 'e1', observed_at: 1, valid_until: 2, kind: 'class', title: 'b', starts_at: now, ends_at: now },
  ]);
  store.tombstoneMissing('timeline_event', 'a', []);
  assert.deepEqual(store.rows('timeline_event').map((r) => r.title), ['b']);
});

test('json extras survive as arrays without a jsonb column', () => {
  const store = new SqliteStore(':memory:');
  store.upsertRows('menu_item', [
    { source_id: 's', external_id: 'd1', observed_at: 1, valid_until: 2, outlet: 'REV', dish: 'Soup', service_date: '2026-09-21', diet: ['vegan'], allergens: ['gluten'] },
  ]);
  const [r] = store.rows('menu_item');
  assert.deepEqual(r.diet, ['vegan']);
  assert.deepEqual(r.allergens, ['gluten']);
});

test('job scheduling backs off on failure and opens a circuit after five', () => {
  const store = new SqliteStore(':memory:');
  store.scheduleJob('s', now);
  let next = now;
  const delays = [];
  for (let i = 0; i < 6; i++) {
    store.recordJobResult('s', { startedAt: now, finishedAt: now, outcome: 'failed', cadenceMs: 60_000, now });
    const job = store.jobs()[0];
    delays.push(Math.round((job.next_due_at - now) / 1000));
    next = job.next_due_at;
  }
  assert.ok(delays[0] < delays[5], `backoff must grow: ${delays.join(',')}`);
  assert.equal(store.jobs()[0].circuit_state, 'open');
  assert.ok(delays[5] <= 15 * 60, 'backoff is capped at 15 minutes');
});

test('a success resets failures and closes the circuit', () => {
  const store = new SqliteStore(':memory:');
  store.scheduleJob('s', now);
  for (let i = 0; i < 5; i++) store.recordJobResult('s', { startedAt: now, finishedAt: now, outcome: 'failed', cadenceMs: 60_000, now });
  assert.equal(store.jobs()[0].circuit_state, 'open');
  store.recordJobResult('s', { startedAt: now, finishedAt: now, outcome: 'ok', cadenceMs: 60_000, now });
  const job = store.jobs()[0];
  assert.equal(job.circuit_state, 'closed');
  assert.equal(job.consecutive_failures, 0);
  assert.equal(job.next_due_at, now + 60_000, 'a healthy source returns to its own cadence');
});

test('HTTP 429 waits at least 30 minutes before retrying a feed', () => {
  const store = new SqliteStore(':memory:');
  store.scheduleJob('s', now);
  store.recordJobResult('s', { startedAt: now, finishedAt: now, outcome: 'failed', httpStatus: 429, cadenceMs: 15 * 60_000, now });
  assert.ok(store.jobs()[0].next_due_at >= now + 30 * 60_000);
  store.close();
});

test('due jobs are returned in due order', () => {
  const store = new SqliteStore(':memory:');
  store.scheduleJob('later', now + 1000);
  store.scheduleJob('sooner', now - 1000);
  assert.deepEqual(store.dueJobs(now).map((j) => j.source_id), ['sooner']);
});

test('a multi-row insert keeps every column aligned with its own row', () => {
  const store = new SqliteStore(':memory:');
  // 13 rows is more than one statement for timeline_event (16 params per row, 100 param ceiling).
  const rows = Array.from({ length: 13 }, (_, i) => ({
    source_id: 'uw-portal-ics',
    external_id: `e${i}`,
    observed_at: now,
    valid_until: now + 1000,
    kind: 'class',
    title: `ECE 150 LEC 00${i}`,
    location: `E7 23${10 + i}`,
    starts_at: now + i * 60_000,
    ends_at: now + i * 60_000 + 300_000,
    all_day: false,
  }));
  store.upsertRows('timeline_event', rows);
  const back = store.rows('timeline_event', { limit: 50 }).sort((a, b) => a.starts_at - b.starts_at);
  assert.equal(back.length, 13);
  for (let i = 0; i < 13; i += 1) {
    assert.equal(back[i].title, `ECE 150 LEC 00${i}`);
    assert.equal(back[i].location, `E7 23${10 + i}`);
    assert.equal(back[i].starts_at, now + i * 60_000);
  }
});

test('a second save of an identical body skips the gzip and the write', () => {
  const store = new SqliteStore(':memory:');
  const hash = store.saveSnapshot({ sourceId: 's', fetchedAt: now, contentType: 'text/html', body: '<html>same</html>' });
  assert.equal(store.hasSnapshot(hash), true);
  store.saveSnapshot({ sourceId: 's', fetchedAt: now + 1000, contentType: 'text/html', body: '<html>same</html>' });
  assert.equal(store.snapshotCount(), 1);
});

test('run receipts older than the retention window are pruned', () => {
  const store = new SqliteStore(':memory:');
  store.insertRun({ source_id: 's', started_at: now - 30 * 86_400_000, finished_at: now - 30 * 86_400_000, outcome: 'ok' });
  store.insertRun({ source_id: 's', started_at: now, finished_at: now, outcome: 'ok' });
  assert.equal(store.pruneRuns(now - 7 * 86_400_000), 1);
  assert.equal(store.recentRuns(10).length, 1);
});

test('the raw snapshot archive deduplicates identical bodies', () => {
  const store = new SqliteStore(':memory:');
  const a = store.saveSnapshot({ sourceId: 's', fetchedAt: now, contentType: 'text/html', body: '<html>same</html>' });
  const b = store.saveSnapshot({ sourceId: 's', fetchedAt: now + 1000, contentType: 'text/html', body: '<html>same</html>' });
  assert.equal(a, b);
  assert.equal(store.snapshotCount(), 1);
  assert.equal(store.getSnapshot(a).body, '<html>same</html>');
});
