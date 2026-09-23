/** Persistent dining recommendation shared by the Worker, local relay, and clients. */
import { rankDailyMenu, DEFAULT_AI_MODEL, POPULAR_MODELS } from './ai.mjs';
import { aiBudgetGuard } from './ai-budget.mjs';

const PROFILE_KEY = 'FOOD_AI_PROFILE_JSON';
const RESULT_KEY = 'FOOD_AI_RECOMMENDATION_JSON';
const USAGE_KEY = 'FOOD_AI_USAGE_JSON';
const RETRY_MS = 5 * 60_000;
const MAX_AI_RANKINGS_PER_DAY = 12;

function parseJson(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

export function cleanFoodProfile(input = {}) {
  const profile = input && typeof input === 'object' ? input : {};
  const model = typeof profile.selectedAiModel === 'string' && POPULAR_MODELS.some((item) => item.id === profile.selectedAiModel)
    ? profile.selectedAiModel : DEFAULT_AI_MODEL;
  return {
    bio: typeof profile.bio === 'string' ? profile.bio.slice(0, 1000) : '',
    spiceLevel: ['none', 'mild', 'medium', 'hot', 'extra-hot'].includes(profile.spiceLevel) ? profile.spiceLevel : 'medium',
    dietaryGoals: Array.isArray(profile.dietaryGoals) ? profile.dietaryGoals.filter((goal) => typeof goal === 'string').slice(0, 12).map((goal) => goal.slice(0, 80)) : [],
    dietaryFilter: typeof profile.dietaryFilter === 'string' ? profile.dietaryFilter.slice(0, 30) : 'all',
    selectedAiModel: model,
  };
}

export async function saveFoodProfile(store, input) {
  const profile = cleanFoodProfile(input);
  const previous = await store.getSetting(PROFILE_KEY);
  const next = JSON.stringify(profile);
  if (previous !== next) {
    await store.setSetting(PROFILE_KEY, next);
    await store.setSetting(RESULT_KEY, JSON.stringify({ status: 'pending', service_date: '', updated_at: Date.now() }));
  }
  return profile;
}

export async function getFoodProfile(store) {
  return parseJson(await store.getSetting(PROFILE_KEY), null);
}

export async function getFoodRecommendation(store, serviceDate = '') {
  const result = parseJson(await store.getSetting(RESULT_KEY), null);
  if (!result) return { status: 'pending', recommendation: null };
  if (serviceDate && result.service_date !== serviceDate) return { status: 'pending', recommendation: null };
  return { status: result.status, recommendation: result.status === 'ready' ? result.recommendation : null, error: result.error || '', service_date: result.service_date };
}

/** One shared daily limit covers background rankings and the temporary manual route. */
export async function claimFoodAiRun(store, now = Date.now()) {
  const date = new Date(now).toISOString().slice(0, 10);
  const usage = parseJson(await store.getSetting(USAGE_KEY), {});
  const count = usage.date === date ? usage.count || 0 : 0;
  if (count >= MAX_AI_RANKINGS_PER_DAY) return false;
  await store.setSetting(USAGE_KEY, JSON.stringify({ date, count: count + 1 }));
  return true;
}

/** Cron and local poll call this after fetching; it never needs a page view. */
export async function syncFoodRecommendation(store, { cfEnv = null, now = Date.now(), force = false } = {}) {
  const latest = await store.rows('menu_item', { where: 'service_date = (SELECT MAX(service_date) FROM menu_item WHERE deleted=0)', limit: 1 });
  if (!latest.length) return { status: 'pending', reason: 'no menu' };
  const serviceDate = latest[0].service_date;
  const menuItems = await store.rows('menu_item', { where: 'service_date = ?', params: [serviceDate], limit: 500 });
  const profile = cleanFoodProfile(parseJson(await store.getSetting(PROFILE_KEY), {}));
  const signature = JSON.stringify({ serviceDate, model: profile.selectedAiModel, profile, menu: menuItems.map((item) => [item.external_id, item.outlet, item.dish, item.diet, item.allergens]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) });
  const previous = parseJson(await store.getSetting(RESULT_KEY), null);
  if (!force && previous?.signature === signature) {
    if (previous.status === 'ready') return { status: 'ready', cached: true };
    if (now - (previous.updated_at || 0) < RETRY_MS) return { status: previous.status, error: previous.error || '', cached: true };
  }
  if (!await claimFoodAiRun(store, now)) {
    if (previous?.signature !== signature || previous.status !== 'limited') {
      await store.setSetting(RESULT_KEY, JSON.stringify({ signature, service_date: serviceDate, status: 'limited', updated_at: now }));
    }
    return { status: 'limited', reason: 'daily AI ranking limit reached' };
  }
  await store.setSetting(RESULT_KEY, JSON.stringify({ signature, service_date: serviceDate, status: 'processing', updated_at: now }));
  try {
    const recommendation = await rankDailyMenu({ menuItems, serviceDate, tasteProfile: profile, model: profile.selectedAiModel, cfEnv, force: true, now, beforeAiCall: aiBudgetGuard(store) });
    // A newer menu/profile may have arrived while the model ran. Never replace its result.
    const current = parseJson(await store.getSetting(RESULT_KEY), null);
    if (current?.signature === signature) await store.setSetting(RESULT_KEY, JSON.stringify({ signature, service_date: serviceDate, status: 'ready', recommendation, updated_at: Date.now() }));
    return { status: 'ready', recommendation };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = parseJson(await store.getSetting(RESULT_KEY), null);
    if (current?.signature === signature) await store.setSetting(RESULT_KEY, JSON.stringify({ signature, service_date: serviceDate, status: 'failed', error: message, updated_at: Date.now() }));
    return { status: 'failed', error: message };
  }
}
