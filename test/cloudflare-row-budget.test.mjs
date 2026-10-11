import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { D1Store } from '../apps/relay/src/d1-store.mjs';
import worker from '../apps/relay/src/worker.mjs';
import { SOURCES } from '../sources/registry.mjs';

test('calendar and guidance read budgets stay bounded with a week of minute-by-minute receipts', async t => {
  // Use the local D1 runtime's rows_read metadata: statement counts alone missed a receipt scan.
  const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'row-budget', modules: true,
    script: 'export default { fetch() { return new Response("Local budget test"); } }',
    compatibilityDate: '2026-09-01', d1Databases: ['DB'] }));
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database('DB');
  const usage = { queries: 0, read: 0, written: 0 };
  const record = result => {
    assert.ok(Number.isFinite(result.meta?.rows_read), 'D1 must supply row usage metadata');
    usage.queries++;
    usage.read += result.meta.rows_read;
    usage.written += result.meta.rows_written;
    return result;
  };
  const wrap = raw => ({
    raw,
    bind(...values) { return wrap(raw.bind(...values)); },
    async all() { return record(await raw.all()); },
    async run() { return record(await raw.run()); },
    async first(column) {
      const result = record(await raw.all());
      const row = result.results[0];
      return row ? column ? row[column] : row : null;
    },
  });
  const binding = {
    prepare(sql) { return wrap(db.prepare(sql)); },
    async batch(statements) { return (await db.batch(statements.map(statement => statement.raw))).map(record); },
  };
  const store = new D1Store(binding);
  await store.init();
  const now = Date.now();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(now);
  for (const source of SOURCES) {
    await store.scheduleJob(source.id, now + 86_400_000);
    await store.insertRun({ source_id: source.id, started_at: now, finished_at: now, outcome: 'ok' });
  }
  await store.upsertRows('timeline_event', ['uw-portal-ics', 'uw-learn-ics'].flatMap(source_id =>
    Array.from({ length: 80 }, (_, index) => ({ source_id, external_id: `event-${index}`,
      kind: source_id === 'uw-learn-ics' ? 'deadline' : 'class',
      title: source_id === 'uw-learn-ics' ? `ECE 105 - Report ${index} - Due` : 'ECE 105 LEC 001',
      location: source_id === 'uw-learn-ics' ? 'ECE 105 - Fall 2026' : 'MC 2034',
      observed_at: now, valid_until: now + 900_000,
      starts_at: now + index * 6 * 3600_000, ends_at: now + index * 6 * 3600_000 + 3600_000,
    }))));
  await db.prepare(`WITH RECURSIVE sequence(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM sequence WHERE i<10079)
    INSERT INTO source_run (source_id,started_at,finished_at,outcome,rows_written)
    SELECT 'uw-status', ?-(10079-i)*60000, ?-(10079-i)*60000, 'ok', 1 FROM sequence`).bind(now, now).run();

  let aiCalls = 0;
  const upstreamFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Saved-data reads must not fetch an upstream feed'); };
  t.after(() => { globalThis.fetch = upstreamFetch; });
  const env = { ACCESS_DISABLED: '1', DB: binding, AI: { run: async () => { aiCalls++; throw new Error('No AI on reads'); } } };
  for (const path of [`/v1/calendar?start=${date}&days=31`, '/v1/recommendations']) {
    const before = { ...usage };
    const response = await worker.fetch(new Request(`https://dash.test${path}`), env, {});
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(path.includes('/calendar') ? payload.count > 0 : payload.items.length > 0,
      'the fixture must exercise real calendar and task presentation');
    const read = usage.read - before.read;
    assert.ok(read < 1000, `${path} scanned ${read} rows; retained receipts must use source index seeks`);
    assert.ok(usage.queries - before.queries <= 20, 'the invocation must retain its statement budget');
    assert.equal(usage.written, before.written, 'reads must not spend the daily write allowance');
    t.diagnostic(`${path}: ${read} rows read; ${usage.queries - before.queries} statements; no writes`);
  }
  assert.equal(aiCalls, 0);
});
