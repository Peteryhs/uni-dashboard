import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceCondition } from '../apps/web/src/lib/source-status.mjs';

const now = 1_800_000_000_000;
const source = (overrides = {}) => ({
  id: 'learn-calendar',
  ready: true,
  cadence_ms: 60 * 60_000,
  last_run: { at: now, outcome: 'ok', meta: {} },
  job: { circuit: 'closed' },
  ...overrides,
});

test('fresh successful runs are healthy while fresh empty runs are valid', () => {
  assert.equal(sourceCondition(source(), now), 'healthy');
  assert.equal(sourceCondition(source({ last_run: { at: now, outcome: 'empty', meta: {} } }), now), 'healthy');
});

test('successful data is stale after three cadences and dead after six', () => {
  const cadence = 60 * 60_000;
  assert.equal(sourceCondition(source({ last_run: { at: now - cadence * 3 - 1, outcome: 'ok' } }), now), 'stale');
  assert.equal(sourceCondition(source({ last_run: { at: now - cadence * 6 - 1, outcome: 'ok' } }), now), 'dead');
});

test('skipped or missing runs never claim a healthy source', () => {
  assert.equal(sourceCondition(source({ last_run: { at: now, outcome: 'skipped' } }), now), 'unknown');
  assert.equal(sourceCondition(source({ last_run: null }), now), 'unknown');
});

test('an open circuit and partial calendar parse prevent a green status', () => {
  assert.equal(sourceCondition(source({ job: { circuit: 'open' } }), now), 'failing');
  assert.equal(sourceCondition(source({ last_run: { at: now, outcome: 'ok', meta: { skipped_events: 2 } } }), now), 'partial');
});

test('a recent failed attempt does not hide a source issue and missing credentials remain blocked', () => {
  for (const outcome of ['failed', 'implausible']) {
    assert.equal(sourceCondition(source({ last_run: { at: now, outcome } }), now), 'failing');
  }
  assert.equal(sourceCondition(source({ ready: false }), now), 'blocked');
});

test('unconfigured optional sources do not become blocked', () => {
  assert.equal(sourceCondition(source({ ready: false, optional: true }), now), 'unknown');
});
