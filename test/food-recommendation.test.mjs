import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimFoodAiRun,
  cleanFoodProfile,
  foodRecommendationSignature,
  getFoodRecommendation,
  persistManualFoodRecommendation,
  saveFoodProfile,
  syncFoodRecommendation,
} from '../apps/relay/src/food-recommendation.mjs';
import { createServer } from '../apps/relay/src/server.mjs';

const SERVICE_DATE = '2026-09-24';
const PROFILE_KEY = 'FOOD_AI_PROFILE_JSON';
const RESULT_KEY = 'FOOD_AI_RECOMMENDATION_JSON';
const USAGE_KEY = 'FOOD_AI_USAGE_JSON';

function makeStore() {
  const settings = new Map();
  const menu = [{ service_date: SERVICE_DATE, external_id: 'dish-1', outlet: 'Cafe', dish: 'Soup', diet: [], allergens: [] }];
  let reserved = 0;
  return {
    settings,
    async rows() { return menu; },
    async getSetting(key) { return settings.get(key) ?? null; },
    async setSetting(key, value) { settings.set(key, value); },
    async reserveAiBudget(day, amount, limit) {
      if (reserved + amount > limit) return null;
      reserved += amount;
      return { day, reserved_neurons: reserved, calls: 1 };
    },
  };
}

const savedRecommendation = {
  service_date: SERVICE_DATE,
  model: '@cf/google/gemma-4-26b-a4b-it',
  headline: 'Saved summary',
  top_outlet: 'Cafe',
  ranked_outlets: [{ outlet: 'Cafe', rank: 1, match_score: 90, verdict: 'Good fit', highlights: [] }],
  tip: '',
  generated_at: Date.now(),
};

test('legacy taste presets are folded into free text before ranking', () => {
  const profile = cleanFoodProfile({ bio: 'likes noodles', spiceLevel: 'hot', dietaryGoals: ['high-protein'] });
  assert.equal(profile.spiceLevel, 'none');
  assert.deepEqual(profile.dietaryGoals, []);
  assert.match(profile.bio, /likes noodles; hot spice, high protein/);
});

test('automatic ranking retries back off, cap repeated failures, and retain the last error', async () => {
  const store = makeStore();
  // Keep the 37-minute retry sequence within one UTC day.
  const now = Date.parse(`${SERVICE_DATE}T12:00:00Z`);
  const originalDateNow = Date.now;
  let simulatedNow = now;
  Date.now = () => simulatedNow;
  const syncAt = (at) => {
    simulatedNow = at;
    return syncFoodRecommendation(store, { cfEnv, now: at });
  };
  let modelCalls = 0;
  const cfEnv = { AI: { run: async () => { modelCalls++; throw new Error('simulated provider outage'); } } };

  try {
    assert.equal((await syncAt(now)).status, 'failed');
    assert.equal((await syncAt(now + 4 * 60_000)).cached, true);
    assert.equal(modelCalls, 1);
    assert.equal((await syncAt(now + 6 * 60_000)).status, 'failed');
    assert.equal((await syncAt(now + 37 * 60_000)).status, 'attempt_limited');
    assert.equal(modelCalls, 3);

    const result = JSON.parse(store.settings.get(RESULT_KEY));
    assert.equal(result.failure_count, 3);
    assert.match(result.error, /simulated provider outage/);
    assert.equal(result.limit_reason, 'repeated_failures');
    assert.equal(JSON.parse(store.settings.get(USAGE_KEY)).automatic_count, 3);
    assert.equal((await syncAt(now + 86_400_000)).status, 'attempt_limited');
    assert.equal(modelCalls, 3, 'a signature with three failures is capped across days');
  } finally {
    Date.now = originalDateNow;
  }
});

test('unreadable dining output stores safe diagnostics without persisting provider text', async () => {
  const store = makeStore();
  const providerText = 'PRIVATE_MENU_PROFILE_SENTINEL: not JSON';
  let calls = 0;
  const result = await syncFoodRecommendation(store, {
    now: Date.parse(`${SERVICE_DATE}T12:00:00Z`),
    cfEnv: { AI: { run: async () => { calls++; return { response: providerText }; } } },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.error, /Response was not valid JSON/);
  assert.equal(calls, 2, 'the provider gets only one retry');
  assert.equal(result.diagnostic.parses_as_json, false);
  const stored = store.settings.get(RESULT_KEY);
  assert.doesNotMatch(stored, /PRIVATE_MENU_PROFILE_SENTINEL/);
  assert.equal(JSON.parse(stored).error_diagnostic.response_chars, providerText.length);

  const exposed = await getFoodRecommendation(store, SERVICE_DATE);
  assert.equal(exposed.diagnostic.parses_as_json, false);
  assert.doesNotMatch(JSON.stringify(exposed), /PRIVATE_MENU_PROFILE_SENTINEL/);
});

test('daily cap reports ranking attempts separately from shared AI usage', async () => {
  const store = makeStore();
  store.settings.set(USAGE_KEY, JSON.stringify({ date: SERVICE_DATE, count: 12, automatic_count: 12, manual_count: 0, legacy_unattributed_count: 0 }));
  const result = await syncFoodRecommendation(store, { now: Date.parse(`${SERVICE_DATE}T12:00:00Z`) });
  assert.equal(result.status, 'attempt_limited');
  assert.equal(JSON.parse(store.settings.get(RESULT_KEY)).limit_reason, 'automatic_attempt_cap');
  assert.equal((await getFoodRecommendation(store, SERVICE_DATE)).status, 'attempt_limited');
});

test('legacy daily totals remain unattributed while automatic and manual caps track separately', async () => {
  const store = makeStore();
  const now = Date.parse(`${SERVICE_DATE}T12:00:00Z`);
  const legacyUsage = { date: SERVICE_DATE, count: 12 };
  store.settings.set(USAGE_KEY, JSON.stringify(legacyUsage));

  for (let attempt = 0; attempt < 12; attempt++) assert.equal(await claimFoodAiRun(store, now, 'automatic'), true);
  for (let attempt = 0; attempt < 12; attempt++) assert.equal(await claimFoodAiRun(store, now, 'manual'), true);
  assert.equal(await claimFoodAiRun(store, now, 'automatic'), false);
  assert.equal(await claimFoodAiRun(store, now, 'manual'), false);

  const recovered = JSON.parse(store.settings.get(USAGE_KEY));
  assert.equal(recovered.count, 36);
  assert.equal(recovered.legacy_unattributed_count, 12);
  assert.equal(recovered.automatic_count, 12);
  assert.equal(recovered.manual_count, 12);
});

test('known manual usage remains capped when automatic attempts are still available', async () => {
  const store = makeStore();
  const now = Date.parse(`${SERVICE_DATE}T12:00:00Z`);
  const existing = { date: SERVICE_DATE, count: 12, automatic_count: 0, manual_count: 12, legacy_unattributed_count: 0 };
  store.settings.set(USAGE_KEY, JSON.stringify(existing));

  assert.equal(await claimFoodAiRun(store, now, 'manual'), false);
  assert.deepEqual(JSON.parse(store.settings.get(USAGE_KEY)), existing);
  assert.equal(await claimFoodAiRun(store, now, 'automatic'), true);
  const updated = JSON.parse(store.settings.get(USAGE_KEY));
  assert.equal(updated.manual_count, 12);
  assert.equal(updated.automatic_count, 1);
});

test('legacy daily totals do not bypass the shared AI neuron budget', async () => {
  const store = makeStore();
  store.settings.set(USAGE_KEY, JSON.stringify({ date: SERVICE_DATE, count: 12 }));
  store.reserveAiBudget = async () => null;
  let modelCalls = 0;
  const result = await syncFoodRecommendation(store, {
    now: Date.parse(`${SERVICE_DATE}T12:00:00Z`),
    cfEnv: { AI: { run: async () => { modelCalls++; return { response: '{}' }; } } },
  });

  assert.equal(result.status, 'budget_limited');
  assert.equal(modelCalls, 0);
  const usage = JSON.parse(store.settings.get(USAGE_KEY));
  assert.equal(usage.count, 13);
  assert.equal(usage.automatic_count, 1);
  assert.equal(usage.legacy_unattributed_count, 12);
  assert.equal(JSON.parse(store.settings.get(RESULT_KEY)).limit_reason, 'shared_ai_budget');
});

test('legacy daily attempt-cap status can retry after automatic and manual caps are split', async () => {
  const store = makeStore();
  const now = Date.parse(`${SERVICE_DATE}T12:00:00Z`);
  let calls = 0;
  const cfEnv = { AI: { run: async () => {
    calls++;
    return { response: JSON.stringify({
      headline: 'Cafe fits today.',
      top_outlet: 'Cafe',
      ranked_outlets: [{ outlet: 'Cafe', rank: 1, match_score: 82, verdict: 'Good fit.', highlights: [] }],
      tip: '',
    }) };
  } } };

  assert.equal((await syncFoodRecommendation(store, { cfEnv, now })).status, 'ready');
  const saved = JSON.parse(store.settings.get(RESULT_KEY));
  store.settings.set(RESULT_KEY, JSON.stringify({ ...saved, status: 'attempt_limited', limit_reason: 'daily_attempt_cap', limit_day: SERVICE_DATE }));
  store.settings.set(USAGE_KEY, JSON.stringify({ date: SERVICE_DATE, count: 15, automatic_count: 3, legacy_unattributed_count: 12 }));

  assert.equal((await syncFoodRecommendation(store, { cfEnv, now: now + 60_000 })).status, 'ready');
  assert.equal(calls, 2);
  const usage = JSON.parse(store.settings.get(USAGE_KEY));
  assert.equal(usage.count, 16);
  assert.equal(usage.automatic_count, 4);
  assert.equal(usage.legacy_unattributed_count, 12);
});

test('profile changes keep a saved same-day recommendation available as stale', async () => {
  const store = makeStore();
  store.settings.set(PROFILE_KEY, JSON.stringify(cleanFoodProfile({})));
  store.settings.set(RESULT_KEY, JSON.stringify({ status: 'ready', service_date: SERVICE_DATE, recommendation: savedRecommendation }));

  await saveFoodProfile(store, { bio: 'likes tofu' });
  const result = await getFoodRecommendation(store, SERVICE_DATE);
  assert.equal(result.status, 'pending');
  assert.equal(result.stale, true);
  assert.equal(result.recommendation.headline, 'Saved summary');
});

test('manual ranking persists only when the saved profile, model, latest date, and menu still match', async () => {
  const store = makeStore();
  const now = Date.parse(`${SERVICE_DATE}T12:00:00Z`);
  const profile = await saveFoodProfile(store, { bio: 'soup fan' });
  const menu = await store.rows('menu_item');
  const recommendation = { ...savedRecommendation, headline: 'Manual match', generated_at: now };

  assert.equal(await persistManualFoodRecommendation(store, {
    recommendation, tasteProfile: profile, model: profile.selectedAiModel,
    requestedDate: SERVICE_DATE, serviceDate: SERVICE_DATE, menuItems: menu, now,
  }), true);
  const stored = JSON.parse(store.settings.get(RESULT_KEY));
  assert.equal(stored.signature, foodRecommendationSignature(SERVICE_DATE, profile, menu));
  assert.equal(stored.status, 'ready');
  assert.equal((await getFoodRecommendation(store, SERVICE_DATE)).recommendation.headline, 'Manual match');

  const beforeMismatch = store.settings.get(RESULT_KEY);
  assert.equal(await persistManualFoodRecommendation(store, {
    recommendation: { ...recommendation, headline: 'Older concurrent result' }, tasteProfile: profile,
    model: profile.selectedAiModel, requestedDate: SERVICE_DATE, serviceDate: SERVICE_DATE,
    menuItems: menu, startedAt: now - 1, now: now + 1,
  }), false, 'a slower request must not replace a newer successful result');
  assert.equal(await persistManualFoodRecommendation(store, {
    recommendation, tasteProfile: { ...profile, bio: 'different profile' }, model: profile.selectedAiModel,
    requestedDate: SERVICE_DATE, serviceDate: SERVICE_DATE, menuItems: menu, now: now + 1,
  }), false);
  assert.equal(await persistManualFoodRecommendation(store, {
    recommendation, tasteProfile: profile, model: '@cf/zai-org/glm-4.7-flash',
    requestedDate: SERVICE_DATE, serviceDate: SERVICE_DATE, menuItems: menu, now: now + 1,
  }), false);
  assert.equal(await persistManualFoodRecommendation(store, {
    recommendation, tasteProfile: profile, model: profile.selectedAiModel,
    requestedDate: '2026-09-23', serviceDate: SERVICE_DATE, menuItems: menu, now: now + 1,
  }), false);
  store.rows = async (_shape, options) => options?.where?.includes('MAX(service_date)')
    ? [{ service_date: '2026-09-25' }]
    : menu;
  assert.equal(await persistManualFoodRecommendation(store, {
    recommendation, tasteProfile: profile, model: profile.selectedAiModel,
    requestedDate: SERVICE_DATE, serviceDate: SERVICE_DATE, menuItems: menu, now: now + 1,
  }), false, 'older menu dates must not replace the current lunch recommendation');
  store.rows = async (_shape, options) => options?.where?.includes('MAX(service_date)')
    ? [{ service_date: SERVICE_DATE }]
    : [{ ...menu[0], dish: 'Different menu content' }];
  assert.equal(await persistManualFoodRecommendation(store, {
    recommendation, tasteProfile: profile, model: profile.selectedAiModel,
    requestedDate: SERVICE_DATE, serviceDate: SERVICE_DATE, menuItems: menu, now: now + 1,
  }), false, 'menu changes during ranking must not be saved under the new menu signature');
  assert.equal(store.settings.get(RESULT_KEY), beforeMismatch, 'mismatched manual output must not replace saved data');
});

test('local relay manual rank route saves matching output for background recommendations', async (t) => {
  const store = makeStore();
  const profile = await saveFoodProfile(store, { bio: 'soup fan' });
  const menuRows = await store.rows('menu_item');
  // The local relay uses the synchronous SqliteStore interface; D1-like adapters are async.
  store.rows = () => menuRows;
  let aiCalls = 0;
  const originalFetch = globalThis.fetch;
  const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/ai/run/')) {
      aiCalls++;
      return new Response(JSON.stringify({ result: { response: JSON.stringify({
        headline: 'Manual ranking saved.',
        top_outlet: 'Cafe',
        ranked_outlets: [{ outlet: 'Cafe', rank: 1, match_score: 88, verdict: 'Fits your profile.', highlights: [] }],
        tip: '',
      }) } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  };

  const { server } = createServer({ store, sources: [], token: '', serveWeb: false, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousToken;
  });

  const address = server.address();
  const root = `http://127.0.0.1:${address.port}`;
  const response = await originalFetch(`${root}/v1/ai/rank-food`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasteProfile: profile, model: profile.selectedAiModel, date: SERVICE_DATE, force: true }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).headline, 'Manual ranking saved.');

  const saved = await getFoodRecommendation(store, SERVICE_DATE);
  assert.equal(saved.status, 'ready');
  assert.equal(saved.recommendation.headline, 'Manual ranking saved.');
  assert.equal((await syncFoodRecommendation(store, { now: Date.parse(`${SERVICE_DATE}T13:00:00Z`) })).cached, true);
  assert.equal(aiCalls, 1, 'the automatic job reuses the manual result under its matching signature');
});

test('ranking attempt usage records manual and automatic sources separately', async () => {
  const store = makeStore();
  const now = Date.parse(`${SERVICE_DATE}T12:00:00Z`);
  assert.equal(await claimFoodAiRun(store, now, 'automatic'), true);
  assert.equal(await claimFoodAiRun(store, now, 'manual'), true);
  assert.deepEqual(JSON.parse(store.settings.get(USAGE_KEY)), {
    date: SERVICE_DATE,
    count: 2,
    automatic_count: 1,
    manual_count: 1,
  });
});
