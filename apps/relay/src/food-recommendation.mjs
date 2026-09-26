/** Persistent dining recommendation shared by the Worker, local relay, and clients. */
import { rankDailyMenu, DEFAULT_AI_MODEL, POPULAR_MODELS } from './ai.mjs';
import { aiBudgetGuard } from './ai-budget.mjs';

const PROFILE_KEY = 'FOOD_AI_PROFILE_JSON';
const RESULT_KEY = 'FOOD_AI_RECOMMENDATION_JSON';
const USAGE_KEY = 'FOOD_AI_USAGE_JSON';
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000];
const MAX_FAILURE_ATTEMPTS = 3;
const MAX_AUTOMATIC_AI_RANKINGS_PER_DAY = 12;
const MAX_MANUAL_AI_RANKINGS_PER_DAY = 12;

function parseJson(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function menuSignatureRows(menuItems) {
  return menuItems.map((item) => [item.external_id, item.outlet, item.dish, item.diet, item.allergens])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

/** Keep manual and background recommendation cache keys byte-for-byte compatible. */
export function foodRecommendationSignature(serviceDate, profile, menuItems) {
  return JSON.stringify({
    serviceDate,
    model: profile.selectedAiModel,
    profile: { bio: profile.bio, dietaryFilter: profile.dietaryFilter },
    menu: menuSignatureRows(menuItems),
  });
}

export function cleanFoodProfile(input = {}) {
  const profile = input && typeof input === 'object' ? input : {};
  const model = typeof profile.selectedAiModel === 'string' && POPULAR_MODELS.some((item) => item.id === profile.selectedAiModel)
    ? profile.selectedAiModel : DEFAULT_AI_MODEL;
  const legacySpice = typeof profile.spiceLevel === 'string' && profile.spiceLevel !== 'none' ? `${profile.spiceLevel.replace('-', ' ')} spice` : '';
  const legacyGoals = Array.isArray(profile.dietaryGoals)
    ? profile.dietaryGoals.filter((goal) => typeof goal === 'string').slice(0, 12).map((goal) => goal.slice(0, 80).replace(/[-_]+/g, ' '))
    : [];
  const bio = [typeof profile.bio === 'string' ? profile.bio.trim().slice(0, 1000) : '', [legacySpice, ...legacyGoals].filter(Boolean).join(', ')]
    .filter(Boolean).join('; ');
  return {
    bio,
    spiceLevel: 'none',
    dietaryGoals: [],
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
    // Keep the last successful result visible while the new profile is re-ranked.
    const saved = parseJson(await store.getSetting(RESULT_KEY), null);
    if (saved) await store.setSetting(RESULT_KEY, JSON.stringify({ ...saved, status: 'pending', stale: Boolean(saved.recommendation), updated_at: Date.now() }));
  }
  return profile;
}

export async function getFoodProfile(store) {
  return parseJson(await store.getSetting(PROFILE_KEY), null);
}

/** Save a manual result only if it still represents the latest menu and saved backend profile. */
export async function persistManualFoodRecommendation(store, {
  recommendation,
  tasteProfile,
  model,
  requestedDate,
  serviceDate,
  menuItems,
  startedAt = null,
  now = Date.now(),
}) {
  const requestedProfile = cleanFoodProfile(tasteProfile);
  if (!model || model !== requestedProfile.selectedAiModel) return false;
  if (!requestedDate || requestedDate !== serviceDate || recommendation?.service_date !== serviceDate) return false;

  const rawSavedProfile = await getFoodProfile(store);
  if (!rawSavedProfile) return false;
  const savedProfile = cleanFoodProfile(rawSavedProfile);
  if (JSON.stringify(savedProfile) !== JSON.stringify(requestedProfile) || savedProfile.selectedAiModel !== model) return false;

  const latest = await store.rows('menu_item', {
    where: 'service_date = (SELECT MAX(service_date) FROM menu_item WHERE deleted=0)',
    limit: 1,
  });
  if (latest[0]?.service_date !== serviceDate) return false;
  const currentMenu = await store.rows('menu_item', {
    where: 'service_date = ?',
    params: [serviceDate],
    limit: 500,
  });
  const signature = foodRecommendationSignature(serviceDate, savedProfile, currentMenu);
  if (!currentMenu.length || signature !== foodRecommendationSignature(serviceDate, savedProfile, menuItems)) return false;

  const previous = parseJson(await store.getSetting(RESULT_KEY), null);
  if (previous?.signature === signature && previous.status === 'ready' && Number.isFinite(startedAt) && previous.updated_at > startedAt) return false;
  await store.setSetting(RESULT_KEY, JSON.stringify({
    signature,
    service_date: serviceDate,
    status: 'ready',
    recommendation,
    stale: false,
    updated_at: now,
  }));
  return true;
}

export async function getFoodRecommendation(store, serviceDate = '') {
  const result = parseJson(await store.getSetting(RESULT_KEY), null);
  if (!result) return { status: 'pending', recommendation: null };
  if (serviceDate && result.service_date !== serviceDate) return { status: 'pending', recommendation: null };
  const recommendation = result.recommendation?.service_date === result.service_date ? result.recommendation : null;
  const status = result.status === 'limited' ? 'attempt_limited' : result.status;
  return {
    status,
    recommendation,
    stale: Boolean(recommendation && (result.stale || status !== 'ready')),
    limit_reason: result.limit_reason || (result.status === 'limited' ? 'daily_attempt_cap' : ''),
    error: result.error || '',
    diagnostic: result.error_diagnostic || null,
    service_date: result.service_date,
  };
}

/** Keep cron rankings and user-triggered rankings on separate daily attempt budgets. */
export async function claimFoodAiRun(store, now = Date.now(), source = 'manual') {
  const date = new Date(now).toISOString().slice(0, 10);
  const usage = parseJson(await store.getSetting(USAGE_KEY), {});
  const sameDate = usage.date === date;
  const count = sameDate ? usage.count || 0 : 0;
  const normalizedSource = source === 'automatic' ? 'automatic' : 'manual';
  const automaticCount = sameDate && Number.isInteger(usage.automatic_count) ? usage.automatic_count : 0;
  const manualCount = sameDate && Number.isInteger(usage.manual_count) ? usage.manual_count : 0;
  const attemptCount = normalizedSource === 'automatic' ? automaticCount : manualCount;
  const attemptLimit = normalizedSource === 'automatic' ? MAX_AUTOMATIC_AI_RANKINGS_PER_DAY : MAX_MANUAL_AI_RANKINGS_PER_DAY;
  if (attemptCount >= attemptLimit) return false;

  const hasSourceBreakdown = sameDate && typeof usage.automatic_count === 'number' && typeof usage.manual_count === 'number';
  const legacyUnattributedCount = sameDate
    ? Number.isInteger(usage.legacy_unattributed_count)
      ? usage.legacy_unattributed_count
      : hasSourceBreakdown ? 0 : count
    : 0;
  await store.setSetting(USAGE_KEY, JSON.stringify({
    ...(sameDate ? usage : {}),
    date,
    count: count + 1,
    automatic_count: automaticCount + Number(normalizedSource === 'automatic'),
    manual_count: manualCount + Number(normalizedSource === 'manual'),
    ...(legacyUnattributedCount > 0 ? { legacy_unattributed_count: legacyUnattributedCount } : {}),
  }));
  return true;
}

/** Cron and local poll call this after fetching; it never needs a page view. */
export async function syncFoodRecommendation(store, { cfEnv = null, now = Date.now(), force = false } = {}) {
  const latest = await store.rows('menu_item', { where: 'service_date = (SELECT MAX(service_date) FROM menu_item WHERE deleted=0)', limit: 1 });
  if (!latest.length) return { status: 'pending', reason: 'no menu' };
  const serviceDate = latest[0].service_date;
  const menuItems = await store.rows('menu_item', { where: 'service_date = ?', params: [serviceDate], limit: 500 });
  const profile = cleanFoodProfile(parseJson(await store.getSetting(PROFILE_KEY), {}));
  const signature = foodRecommendationSignature(serviceDate, profile, menuItems);
  const previous = parseJson(await store.getSetting(RESULT_KEY), null);
  const sameSignature = previous?.signature === signature;
  const today = new Date(now).toISOString().slice(0, 10);
  const priorFailures = sameSignature ? previous.failure_count || 0 : 0;
  const keepRecommendation = previous?.recommendation?.service_date === serviceDate ? previous.recommendation : null;
  if (!force && sameSignature) {
    if (previous.status === 'ready') return { status: 'ready', cached: true };
    if (previous.status === 'budget_limited' && previous.limit_day === today) {
      return { status: previous.status, error: previous.error || '', cached: true };
    }
    if (priorFailures >= MAX_FAILURE_ATTEMPTS) return { status: 'attempt_limited', error: previous.error || '', cached: true };
    const legacyDailyCap = previous.status === 'limited' || previous.status === 'attempt_limited' && (!previous.limit_reason || previous.limit_reason === 'daily_attempt_cap');
    if (previous.status === 'attempt_limited' && previous.limit_reason === 'repeated_failures') {
      return { status: 'attempt_limited', error: previous.error || '', cached: true };
    }
    if (!legacyDailyCap && previous.status === 'attempt_limited' && previous.limit_day === today) {
      return { status: previous.status, error: previous.error || '', cached: true };
    }
    const retryDelay = RETRY_DELAYS_MS[Math.max(0, priorFailures - 1)];
    if (previous.status === 'failed' && now - (previous.updated_at || 0) < (retryDelay ?? Number.POSITIVE_INFINITY)) {
      return { status: previous.status, error: previous.error || '', cached: true };
    }
    if (previous.status === 'processing' && now - (previous.updated_at || 0) < RETRY_DELAYS_MS[0]) {
      return { status: previous.status, error: previous.error || '', cached: true };
    }
  }
  if (!await claimFoodAiRun(store, now, 'automatic')) {
    await store.setSetting(RESULT_KEY, JSON.stringify({
      ...(keepRecommendation ? { recommendation: keepRecommendation, stale: true } : {}),
      signature,
      service_date: serviceDate,
      status: 'attempt_limited',
      limit_reason: 'automatic_attempt_cap',
      error: sameSignature ? previous.error || '' : '',
      failure_count: priorFailures,
      failure_day: sameSignature ? previous.failure_day || '' : '',
      limit_day: today,
      updated_at: now,
    }));
    return { status: 'attempt_limited', reason: 'daily ranking attempt cap reached' };
  }
  await store.setSetting(RESULT_KEY, JSON.stringify({
    ...(keepRecommendation ? { recommendation: keepRecommendation, stale: true } : {}),
    signature,
    service_date: serviceDate,
    status: 'processing',
    failure_count: priorFailures,
    updated_at: now,
  }));
  try {
    const recommendation = await rankDailyMenu({ menuItems, serviceDate, tasteProfile: profile, model: profile.selectedAiModel, cfEnv, force: true, now, beforeAiCall: aiBudgetGuard(store) });
    // A newer menu/profile may have arrived while the model ran. Never replace its result.
    const current = parseJson(await store.getSetting(RESULT_KEY), null);
    if (current?.signature === signature && !(current.status === 'ready' && current.updated_at > now)) {
      await store.setSetting(RESULT_KEY, JSON.stringify({ signature, service_date: serviceDate, status: 'ready', recommendation, stale: false, updated_at: Date.now() }));
    }
    return { status: 'ready', recommendation };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = parseJson(await store.getSetting(RESULT_KEY), null);
    const sharedBudgetExhausted = error?.code === 'AI_DAILY_BUDGET_REACHED';
    const failureCount = priorFailures + Number(!sharedBudgetExhausted);
    const attemptLimited = !sharedBudgetExhausted && failureCount >= MAX_FAILURE_ATTEMPTS;
    const failureStatus = sharedBudgetExhausted ? 'budget_limited' : attemptLimited ? 'attempt_limited' : 'failed';
    if (current?.signature === signature && current.status !== 'ready') await store.setSetting(RESULT_KEY, JSON.stringify({
      ...(keepRecommendation ? { recommendation: keepRecommendation, stale: true } : {}),
      signature,
      service_date: serviceDate,
      status: failureStatus,
      limit_reason: sharedBudgetExhausted ? 'shared_ai_budget' : attemptLimited ? 'repeated_failures' : '',
      error: message,
      error_diagnostic: error?.diagnostic || null,
      failure_count: failureCount,
      failure_day: today,
      limit_day: sharedBudgetExhausted || attemptLimited ? today : '',
      updated_at: Date.now(),
    }));
    return { status: failureStatus, error: message, diagnostic: error?.diagnostic || null };
  }
}
