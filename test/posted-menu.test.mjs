import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { handleGuidanceRoute } from '../apps/relay/src/guidance-api.mjs';
import { cadenceMs } from '../sources/food/source.mjs';

const at = Date.parse('2026-10-11T12:00:00Z');
const date = '2026-10-11';
const row = observedAt => ({ source_id: 'uw-food-daily-menu', external_id: 'dish',
  observed_at: observedAt, valid_until: observedAt + cadenceMs, service_date: date,
  outlet: 'Campus Cafe', dish: 'Tofu bowl', station: 'Lunch', diet: ['vegan'], allergens: [] });

test('posted menu retains its original observation through fresh, ageing and stale reads', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  store.upsertRows('menu_item', [row(at)]);
  const before = store.db.prepare('SELECT total_changes() AS count').get().count;
  for (const [now, state] of [[at, 'live'], [at + cadenceMs + 1, 'ageing'], [at + cadenceMs * 3 + 1, 'stale']]) {
    const result = await handleGuidanceRoute({ url: new URL(`https://example.test/v1/menu?date=${date}`), method: 'GET', store, now });
    assert.equal(result.status, 200);
    assert.equal(result.body.service_date, date);
    assert.equal(result.body.observed_at, at);
    assert.equal(result.body.valid_until, at + cadenceMs);
    assert.equal(result.body.cadence_ms, cadenceMs);
    assert.equal(result.body.state, state);
    assert.equal(result.body.items[0].dish, 'Tofu bowl');
  }
  assert.equal(store.db.prepare('SELECT total_changes() AS count').get().count, before, 'reads do not refresh evidence or write data');
});

test('a previous menu keeps its actual date and freshness; an absent menu has no observation', async t => {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  const get = target => handleGuidanceRoute({ url: new URL(`https://example.test/v1/menu?date=${target}`), method: 'GET', store, now: at });
  assert.deepEqual((await get(date)).body, { requested_date: date, service_date: null, status: 'unavailable',
    observed_at: null, valid_until: null, cadence_ms: cadenceMs, state: 'empty', items: [] });
  store.upsertRows('menu_item', [row(at - cadenceMs * 4)]);
  const next = (await get('2026-10-12')).body;
  assert.equal(next.status, 'previous');
  assert.equal(next.service_date, date);
  assert.equal(next.observed_at, at - cadenceMs * 4);
  assert.equal(next.state, 'stale');
});
