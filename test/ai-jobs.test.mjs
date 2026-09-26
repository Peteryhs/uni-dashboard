import test from 'node:test';
import assert from 'node:assert/strict';
import { getAiJob, queueAiJob, restartStalledAiJob } from '../apps/relay/src/ai-jobs.mjs';

test('AI jobs are deduplicated while active and can be reclaimed after a stalled Worker', async () => {
  const settings = new Map();
  const store = {
    async getSetting(key) { return settings.get(key) ?? null; },
    async setSetting(key, value) { settings.set(key, value); },
  };
  const input = { text: 'Office hours Mondays 2-3pm' };
  const first = await queueAiJob(store, { kind: 'office_hours', scope: 'latest', input, now: 1_000 });
  assert.equal(first.started, true);
  const duplicate = await queueAiJob(store, { kind: 'office_hours', scope: 'latest', input, now: 2_000 });
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.job.id, first.job.id);
  assert.equal((await getAiJob(store, 'office_hours', 'latest')).status, 'processing');
  assert.equal('input' in await getAiJob(store, 'office_hours', 'latest'), false, 'pasted text is not exposed by status reads');

  const rows = [...settings].map(([name, value]) => ({ name, value }));
  const recovered = await restartStalledAiJob(store, rows, 100_000);
  assert.notEqual(recovered.id, first.job.id);
  assert.deepEqual(recovered.input, input);
  assert.equal((await getAiJob(store, 'office_hours', 'latest')).id, recovered.id);
});
