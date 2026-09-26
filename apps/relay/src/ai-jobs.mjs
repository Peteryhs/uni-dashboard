/** Persist user-started AI work so closing the page cannot own or cancel it. */
import { rankDailyMenu, parseOfficeHoursWithAi } from './ai.mjs';
import { aiBudgetGuard } from './ai-budget.mjs';
import { buildPreviewOccurrences } from '#sources/office-hours/source.mjs';
import { normalizeCourse } from './course-library.mjs';
import { previewSyllabus } from './syllabus.mjs';
import { claimFoodAiRun, cleanFoodProfile, failManualFoodRanking, getFoodProfile, markManualFoodRanking, persistManualFoodRecommendation, saveFoodProfile } from './food-recommendation.mjs';

const PREFIX = 'AI_JOB:';
const STALLED_AFTER_MS = 90_000;
const KINDS = new Set(['food', 'office_hours', 'syllabus']);

function keyFor(kind, scope) {
  if (!KINDS.has(kind)) throw new RangeError('unknown AI job kind');
  const normalizedScope = kind === 'syllabus' ? normalizeCourse(scope) : kind === 'food' && /^\d{4}-\d{2}-\d{2}$/.test(scope) ? scope : kind === 'office_hours' ? 'latest' : null;
  if (!normalizedScope) throw new RangeError('invalid AI job scope');
  return `${PREFIX}${kind}:${encodeURIComponent(normalizedScope)}`;
}

function parseJob(raw) {
  try {
    const job = JSON.parse(raw);
    return job && KINDS.has(job.kind) && typeof job.id === 'string' ? job : null;
  } catch { return null; }
}

async function setIfUnchanged(store, key, expected, value, now) {
  if (typeof store.compareAndSetSetting === 'function') return store.compareAndSetSetting(key, expected, value, now);
  if (await store.getSetting(key) !== expected) return false;
  await store.setSetting(key, value, now);
  return true;
}

export function publicAiJob(job) {
  if (!job) return { status: 'idle' };
  return {
    id: job.id,
    kind: job.kind,
    scope: job.scope,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    ...(job.status === 'ready' ? { result: job.result } : {}),
    ...(job.status === 'failed' ? { error: job.error } : {}),
  };
}

export async function getAiJob(store, kind, scope) {
  return publicAiJob(parseJob(await store.getSetting(keyFor(kind, scope))));
}

export async function clearAiJob(store, kind, scope) {
  await store.deleteSetting(keyFor(kind, scope));
}

export async function queueAiJob(store, { kind, scope, input, now = Date.now() }) {
  const key = keyFor(kind, scope);
  for (let attempt = 0; attempt < 4; attempt++) {
    const previousRaw = await store.getSetting(key);
    const previous = parseJob(previousRaw);
    if (previous?.status === 'processing' && now - previous.updated_at < STALLED_AFTER_MS) {
      return { job: previous, started: false };
    }
    const job = { id: globalThis.crypto.randomUUID(), kind, scope, status: 'processing', input, created_at: now, updated_at: now };
    if (!await setIfUnchanged(store, key, previousRaw, JSON.stringify(job), now)) continue;
    if (kind === 'food') await markManualFoodRanking(store, { jobId: job.id, serviceDate: scope, now });
    return { job, started: true };
  }
  throw new Error('AI job changed repeatedly; try again.');
}

async function runFoodRanking(store, job, cfEnv) {
  const serviceDate = job.scope;
  const latest = await store.rows('menu_item', { where: 'service_date = (SELECT MAX(service_date) FROM menu_item WHERE deleted=0)', limit: 1 });
  if (latest[0]?.service_date !== serviceDate) throw new Error('The menu date changed. Refresh dining and rank again.');
  const menuItems = await store.rows('menu_item', { where: 'service_date = ?', params: [serviceDate], limit: 500 });
  if (!menuItems.length) throw new Error('No dining menu items are available for this date.');
  const saved = await getFoodProfile(store) || await saveFoodProfile(store, {});
  const profile = cleanFoodProfile(saved);
  if (!await claimFoodAiRun(store, Date.now(), 'manual')) throw new Error('Daily manual dining ranking cap reached; try again after UTC midnight.');
  const recommendation = await rankDailyMenu({
    menuItems, serviceDate, tasteProfile: profile, model: profile.selectedAiModel,
    cfEnv, force: true, now: Date.now(), beforeAiCall: aiBudgetGuard(store),
  });
  if (parseJob(await store.getSetting(keyFor('food', serviceDate)))?.id !== job.id) {
    throw new Error('This ranking was superseded by a newer request.');
  }
  const persisted = await persistManualFoodRecommendation(store, {
    recommendation, tasteProfile: profile, model: profile.selectedAiModel,
    requestedDate: serviceDate, serviceDate, menuItems, startedAt: job.created_at,
  });
  if (!persisted) throw new Error('The menu or taste profile changed while ranking. Rank again for the latest version.');
  return recommendation;
}

async function runJob(store, job, cfEnv) {
  if (job.kind === 'food') return runFoodRanking(store, job, cfEnv);
  if (job.kind === 'office_hours') {
    const { text, course, model, force } = job.input;
    const now = Date.now();
    const draft = await parseOfficeHoursWithAi({ text, course, model, force, now, cfEnv, beforeAiCall: aiBudgetGuard(store) });
    return { draft, preview: buildPreviewOccurrences(draft.rules, { now, count: 6 }), model };
  }
  return previewSyllabus(store, { ...job.input, course: job.scope, use_ai: true }, {
    cfEnv, now: Date.now(), beforeAiCall: aiBudgetGuard(store),
  });
}

/** Called from Worker waitUntil or the local relay, never awaited by a page response. */
export async function processAiJob(store, job, { cfEnv = null } = {}) {
  const key = keyFor(job.kind, job.scope);
  let outcome;
  try {
    const result = await runJob(store, job, cfEnv);
    outcome = { ...job, status: 'ready', result, updated_at: Date.now() };
  } catch (error) {
    outcome = { ...job, status: 'failed', error: error instanceof Error ? error.message : String(error), updated_at: Date.now() };
    if (job.kind === 'food') await failManualFoodRanking(store, { jobId: job.id, error: outcome.error, now: outcome.updated_at });
  }
  delete outcome.input;
  const currentRaw = await store.getSetting(key);
  if (parseJob(currentRaw)?.id === job.id) await setIfUnchanged(store, key, currentRaw, JSON.stringify(outcome), outcome.updated_at);
  return publicAiJob(outcome);
}

/** Cron retries a job left processing if a Worker isolate ended before waitUntil finished. */
export async function restartStalledAiJob(store, settings, now = Date.now()) {
  const stalled = settings
    .filter((row) => row.name.startsWith(PREFIX))
    .map((row) => parseJob(row.value))
    .filter((job) => job?.status === 'processing' && now - job.updated_at >= STALLED_AFTER_MS && job.input)
    .sort((a, b) => a.updated_at - b.updated_at)[0];
  if (!stalled) return null;
  const key = keyFor(stalled.kind, stalled.scope);
  const currentRaw = await store.getSetting(key);
  const current = parseJob(currentRaw);
  if (current?.id !== stalled.id || current.status !== 'processing' || now - current.updated_at < STALLED_AFTER_MS) return null;
  const job = { ...current, id: globalThis.crypto.randomUUID(), updated_at: now };
  if (!await setIfUnchanged(store, key, currentRaw, JSON.stringify(job), now)) return null;
  if (job.kind === 'food') await markManualFoodRanking(store, { jobId: job.id, serviceDate: job.scope, now });
  return job;
}
