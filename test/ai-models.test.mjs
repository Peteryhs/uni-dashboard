import test from 'node:test';
import assert from 'node:assert/strict';
import { getAvailableAiModels, DEFAULT_AI_MODEL, POPULAR_MODELS, formatModelDisplayName, buildModelTag } from '../apps/relay/src/ai.mjs';
import { estimateAiReservation } from '../apps/relay/src/ai-budget.mjs';

test('getAvailableAiModels falls back to POPULAR_MODELS when credentials are missing', async () => {
  const models = await getAvailableAiModels({ accountId: '', apiToken: '', force: true });
  assert.ok(Array.isArray(models));
  assert.ok(models.length >= 5);
  assert.equal(models[0].id, DEFAULT_AI_MODEL);
});

test('formatModelDisplayName provides clean, human-readable names for both curated and dynamic models', () => {
  assert.equal(formatModelDisplayName('@cf/google/gemma-4-26b-a4b-it'), 'Google Gemma 4 (26B-A4B)');
  assert.equal(formatModelDisplayName('@cf/ibm-granite/granite-4.0-h-micro'), 'IBM Granite 4.0 Micro');
  assert.equal(formatModelDisplayName('@cf/meta/llama-3.2-1b-instruct'), 'Meta Llama 3.2 (1B)');
  assert.equal(formatModelDisplayName('@cf/meta/llama-3.2-3b-instruct'), 'Meta Llama 3.2 (3B)');
});

test('buildModelTag assigns cost and efficiency badges', () => {
  assert.equal(buildModelTag('@cf/google/gemma-4-26b-a4b-it', 0.1), 'Recommended · 4B Active MoE');
  assert.equal(buildModelTag('@cf/ibm-granite/granite-4.0-h-micro', 0.017), 'Cheapest Free · $0.02/M');
  assert.equal(buildModelTag('@cf/unknown/new-model', 0.05), 'Free Tier · $0.05/M tokens');
});

test('getAvailableAiModels correctly processes API response and filters paid/lora models', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    return {
      ok: true,
      json: async () => ({
        result: [
          {
            name: '@cf/expensive/paid-model',
            properties: [{ property_id: 'require_workers_paid', value: 'true' }],
          },
          {
            name: '@cf/special/lora-adapter-lora',
            properties: [{ property_id: 'price', value: [{ unit: 'per M input tokens', price: 0.01 }] }],
          },
          {
            name: '@cf/meta/llama-guard-3-8b',
            properties: [{ property_id: 'price', value: [{ unit: 'per M input tokens', price: 0.01 }] }],
          },
          {
            name: '@cf/meta/llama-3.2-1b-instruct',
            properties: [
              {
                property_id: 'price',
                value: [
                  { unit: 'per M input tokens', price: 0.027 },
                  { unit: 'per M output tokens', price: 0.201 },
                ],
              },
            ],
          },
          {
            name: '@cf/ibm-granite/granite-4.0-h-micro',
            properties: [
              {
                property_id: 'price',
                value: [
                  { unit: 'per M input tokens', price: 0.017 },
                  { unit: 'per M output tokens', price: 0.112 },
                ],
              },
            ],
          },
          {
            name: DEFAULT_AI_MODEL,
            properties: [
              {
                property_id: 'price',
                value: [
                  { unit: 'per M input tokens', price: 0.1 },
                  { unit: 'per M output tokens', price: 0.3 },
                ],
              },
            ],
          },
        ],
      }),
    };
  };

  try {
    const models = await getAvailableAiModels({ accountId: 'test-acc', apiToken: 'test-token', force: true });
    // Default model should be first
    assert.equal(models[0].id, DEFAULT_AI_MODEL);
    // Paid, lora, and guard should be excluded
    assert.ok(!models.some((m) => m.id.includes('paid-model')));
    assert.ok(!models.some((m) => m.id.includes('lora-adapter-lora')));
    assert.ok(!models.some((m) => m.id.includes('llama-guard')));
    // Cheapest free model (Granite at avg $0.0645) comes before Llama 3.2 1B (avg $0.114)
    assert.equal(models[1].id, '@cf/ibm-granite/granite-4.0-h-micro');
    assert.equal(models[2].id, '@cf/meta/llama-3.2-1b-instruct');

    // Dynamic rate should be registered and estimateAiReservation should succeed without throwing
    const reservation = estimateAiReservation({
      model: '@cf/ibm-granite/granite-4.0-h-micro',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 512,
    });
    assert.ok(reservation > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
