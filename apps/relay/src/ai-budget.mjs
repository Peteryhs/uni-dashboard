/** Conservative reservations, shared by every app AI call and safe across Worker isolates. */
export const DAILY_AI_BUDGET = 7000;
// Neurons per million input/output tokens, Cloudflare pricing checked 2026-09-23.
const RATES = {
  '@cf/google/gemma-4-26b-a4b-it': [9091, 27273],
  '@cf/zai-org/glm-4.7-flash': [5500, 36400],
  '@cf/meta/llama-4-scout-17b-16e-instruct': [24545, 77273],
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': [45170, 443756],
  '@cf/qwen/qwen3-30b-a3b-fp8': [4625, 30475],
};

export function estimateAiReservation({ model, messages, maxTokens, jsonSchema = null }) {
  const rate = RATES[model];
  if (!rate) {
    const error = new RangeError('Choose one of the supported AI models so its free allowance can be budgeted.');
    error.status = 400;
    throw error;
  }
  // A byte per token is intentionally much more conservative than usual text tokenization.
  // Reserve the full output cap, schema, message framing and a further 25% margin; no refunds.
  const bytes = new TextEncoder().encode(JSON.stringify({ messages, jsonSchema })).length;
  const inputBound = bytes + 1024;
  return Math.max(1, Math.ceil(1.25 * (inputBound * rate[0] + maxTokens * rate[1]) / 1_000_000));
}

export function aiBudgetGuard(store, { now = null } = {}) {
  return async (request) => {
    const at = now ?? Date.now();
    const day = new Date(at).toISOString().slice(0, 10);
    const amount = estimateAiReservation(request);
    const reserved = await store.reserveAiBudget(day, amount, DAILY_AI_BUDGET);
    if (!reserved) {
      const error = new Error('Today’s AI allowance is reserved. Your schedule and recommendations still work; AI imports resume after midnight UTC.');
      error.status = 429;
      throw error;
    }
    return reserved;
  };
}

export async function aiBudgetStatus(store, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const usage = await store.aiUsage(day);
  return { day, budget_neurons: DAILY_AI_BUDGET, reserved_neurons: usage?.reserved_neurons ?? 0,
    calls: usage?.calls ?? 0, remaining_neurons: DAILY_AI_BUDGET - (usage?.reserved_neurons ?? 0),
    resets_at: Date.parse(`${day}T00:00:00Z`) + 86_400_000, accounting: 'conservative reservation' };
}
