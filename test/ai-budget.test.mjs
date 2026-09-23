import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { DAILY_AI_BUDGET, aiBudgetGuard, aiBudgetStatus, estimateAiReservation } from '../apps/relay/src/ai-budget.mjs';
import { runStructured, DEFAULT_AI_MODEL, clearAiCache } from '../apps/relay/src/ai.mjs';

const now = Date.parse('2026-09-23T12:00:00Z');
const request = { model: DEFAULT_AI_MODEL, messages: [{ role: 'user', content: 'Summarize this syllabus.' }], maxTokens: 1600 };

test('AI allowance persists, rejects overspending and resets on the next UTC day', async () => {
  const store = new SqliteStore(':memory:');
  const amount = estimateAiReservation(request);
  store.reserveAiBudget('2026-09-23', DAILY_AI_BUDGET - amount, DAILY_AI_BUDGET);
  await aiBudgetGuard(store, { now })(request);
  await assert.rejects(aiBudgetGuard(store, { now })(request), { status: 429 });
  assert.equal((await aiBudgetStatus(store, now)).reserved_neurons, DAILY_AI_BUDGET);
  await aiBudgetGuard(store, { now: now + 86_400_000 })(request);
  assert.equal((await aiBudgetStatus(store, now + 86_400_000)).reserved_neurons, amount);
  assert.throws(() => estimateAiReservation({ ...request, model: '@cf/unknown/model' }), /supported AI models/);
  store.close();
});

test('each AI retry reserves its own budget and cache reads cost no additional calls', async () => {
  clearAiCache();
  const store = new SqliteStore(':memory:');
  let calls = 0;
  const cfEnv = { AI: { run: async (_model, payload) => {
    assert.equal(payload.max_tokens, 256);
    calls++;
    return { response: JSON.stringify(calls === 1 ? { wrong: true } : { summary: 'Ready.' }) };
  } } };
  const input = { systemMessage: 'Summarize', userMessage: 'Short text', schema: z.object({ summary: z.string() }),
    cfEnv, maxTokens: 256, cacheKey: 'budget-test', now, beforeAiCall: aiBudgetGuard(store, { now }) };
  await runStructured(input);
  await runStructured(input);
  assert.equal(calls, 2);
  assert.equal((await aiBudgetStatus(store, now)).calls, 2);
  store.close();
});

test('an exhausted allowance rejects before invoking the model', async () => {
  const store = new SqliteStore(':memory:');
  store.reserveAiBudget('2026-09-23', DAILY_AI_BUDGET, DAILY_AI_BUDGET);
  let called = false;
  await assert.rejects(runStructured({ systemMessage: 'Test', userMessage: 'Test',
    cfEnv: { AI: { run: async () => { called = true; } } },
    beforeAiCall: aiBudgetGuard(store, { now }) }), { status: 429 });
  assert.equal(called, false);
  store.close();
});
