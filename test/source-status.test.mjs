import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceCondition } from '../apps/web/src/lib/source-status.mjs';
import { sourceFreshness, sourceRecovery } from '../packages/contract/src/source-health.mjs';

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

test('freshness describes successful checks independently of the latest attempt', () => {
  const cadence = 60 * 60_000;
  assert.equal(sourceFreshness(source({ last_run: { at: now, outcome: 'empty' } }), now), 'live');
  const failed = source({ last_success_at: now - 2 * cadence, last_run: { at: now, outcome: 'failed' } });
  assert.equal(sourceFreshness(failed, now), 'ageing');
  assert.equal(sourceFreshness(failed, now + 2 * cadence), 'stale');
  assert.equal(sourceFreshness(failed, now + 5 * cadence), 'dead');
  assert.equal(sourceCondition(failed, now), 'failing');
  assert.equal(sourceFreshness(source({ last_run: { at: now, outcome: 'failed' } }), now), 'unknown');
  assert.equal(sourceFreshness(source({ last_run: { at: now, outcome: 'skipped' } }), now), 'unknown');
});

test('freshness thresholds include the documented boundary and tolerate clock skew', () => {
  const cadence = 60 * 60_000;
  const value = source();
  for (const [age, state] of [[-1, 'live'], [cadence, 'live'], [cadence + 1, 'ageing'],
    [3 * cadence, 'ageing'], [3 * cadence + 1, 'stale'], [6 * cadence, 'stale'], [6 * cadence + 1, 'dead']]) {
    assert.equal(sourceFreshness(value, now + age), state);
  }
});

const automatic = { polling: 'automatic' };

test('recovery distinguishes missing schedules, manual polling, unknown runtime and configuration', () => {
  const missing = source({ last_run: null, job: null });
  assert.deepEqual(sourceRecovery(missing, { now, runtime: automatic }), {
    state: 'unknown', action: 'wait', next_attempt_at: null, automatic: true,
    reason: 'The poller will rebuild this source’s schedule and honor provider retry limits before checking it.',
  });
  const recent = source({ job: null });
  assert.equal(sourceRecovery(recent, { now, runtime: automatic }).next_attempt_at, null,
    'missing schedules cannot promise an immediate check of a recently fetched provider');
  assert.equal(sourceRecovery(source({ job: { next_due_at: null } }), { now, runtime: automatic }).state, 'unknown');
  assert.equal(sourceRecovery(missing, { now, runtime: { polling: 'manual' } }).state, 'manual');
  assert.equal(sourceRecovery(missing, { now }).state, 'unknown');
  const blocked = sourceRecovery(source({ ready: false, blocked_by: 'set CALENDAR_URL' }), { now, runtime: automatic });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.action, 'configure');
  assert.equal(blocked.automatic, false);
  assert.equal(sourceRecovery(source({ monitored: false }), { now, runtime: automatic }).state, 'inactive');
});

test('a failing circuit waits until backoff expires then retries automatically', () => {
  const value = source({ last_run: { at: now, outcome: 'failed' },
    job: { circuit: 'open', failures: 5, next_due_at: now + 60_000 } });
  const waiting = sourceRecovery(value, { now, runtime: automatic });
  assert.equal(waiting.state, 'backoff');
  assert.equal(waiting.action, 'retry');
  assert.equal(waiting.next_attempt_at, now + 60_000);
  assert.equal(waiting.automatic, true);
  assert.equal(sourceRecovery(value, { now: now + 60_000, runtime: automatic }).state, 'due');
});

test('leases explain updates in progress and expired leases permit recovery', () => {
  const value = source({ job: { lease_expires_at: now + 60_000, next_due_at: now } });
  const running = sourceRecovery(value, { now, runtime: automatic });
  assert.equal(running.state, 'refreshing');
  assert.equal(running.action, 'wait');
  assert.equal(sourceRecovery(value, { now: now + 60_000, runtime: automatic }).state, 'due');
});

test('partial and skipped updates explain automatic recovery instead of claiming a clean update', () => {
  const partial = source({ last_run: { at: now, outcome: 'ok', meta: { skipped_events: 3 } },
    job: { next_due_at: now + 60_000, last_outcome: 'partial' } });
  assert.equal(sourceRecovery(partial, { now, runtime: automatic }).action, 'retry');
  assert.equal(sourceRecovery(partial, { now: now + 60_000, runtime: automatic }).state, 'due');
  const skipped = source({ last_run: { at: now, outcome: 'skipped' }, job: { next_due_at: now + 60_000 } });
  assert.equal(sourceRecovery(skipped, { now, runtime: automatic }).state, 'backoff');
});

test('a newer fenced job failure is visible even when storing its receipt failed', () => {
  const value = source({ last_success_at: now - 60_000,
    last_run: { at: now - 60_000, outcome: 'ok' },
    job: { circuit: 'closed', failures: 1, last_outcome: 'failed', last_finished_at: now, next_due_at: now + 60_000 } });
  assert.equal(sourceCondition(value, now), 'failing');
  assert.equal(sourceFreshness(value, now), 'live');
  assert.equal(sourceRecovery(value, { now, runtime: automatic }).state, 'backoff');
  assert.equal(sourceCondition({ ...value, last_run: null }, now), 'failing');
  assert.equal(sourceCondition({ ...value, last_run: { at: now, outcome: 'ok' } }, now), 'failing', 'same-millisecond failure wins');
  assert.equal(sourceCondition({ ...value, job: { ...value.job, last_finished_at: now - 60_001 } }, now), 'healthy', 'older job failure does not override a newer receipt');
});
