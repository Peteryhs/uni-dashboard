/**
 * Small, storage-neutral setup state used by both the local relay and the Worker.
 *
 * Feed URLs are only inspected for presence. They are never included in the returned contract.
 * `SETUP_STARTED_AT` is deliberately just an epoch-millisecond marker: it records that a fresh
 * empty database was seen, without recording a credential or an onboarding decision.
 */
import { SHAPES } from './schema.mjs';

export const SETUP_STARTED_AT = 'SETUP_STARTED_AT';
export const SETUP_SCHEDULE_CHANGED_AT = 'SETUP_SCHEDULE_CHANGED_AT';
export const SETUP_LEARN_CHANGED_AT = 'SETUP_LEARN_CHANGED_AT';
const LIVE_SHAPES = Object.keys(SHAPES);
const SUCCESS_OUTCOMES = new Set(['ok', 'empty']);

const CONFIG_KEYS = {
  'uw-portal-ics': ['PORTAL_ICS_URL', 'GOOGLE_CALENDAR_ICS_URL', 'SCHEDULE_ICS_URL'],
  'uw-learn-ics': ['LEARN_ICS_URL'],
};
const DURABLE_USER_SETTINGS = new Set(['OFFICE_HOURS_JSON', 'FOOD_AI_PROFILE_JSON', 'COURSE_LIBRARY_JSON']);

function hasDurableUserSettings(settings) {
  return settings.some((row) => {
    const name = String(row?.name || '');
    return DURABLE_USER_SETTINGS.has(name) || name.startsWith('SYLLABUS:');
  });
}

function changedAt(settings, sourceId) {
  const marker = sourceId === 'uw-portal-ics' ? SETUP_SCHEDULE_CHANGED_AT : SETUP_LEARN_CHANGED_AT;
  const markerRow = settings.find((row) => row?.name === marker);
  if (markerRow?.value && Number.isFinite(Number(markerRow.value))) return Number(markerRow.value);
  const names = CONFIG_KEYS[sourceId] ?? [];
  const configRows = settings.filter((row) => names.includes(row?.name) && Number.isFinite(Number(row?.updated_at)));
  return configRows.length ? Math.max(...configRows.map((row) => Number(row.updated_at))) : null;
}

async function configured(source, settings) {
  const url = typeof source?.url === 'function' ? source.url() : source?.url;
  if (typeof url === 'string' && url.trim()) return true;
  const names = CONFIG_KEYS[source?.id] ?? [];
  return settings.some((row) => names.includes(row?.name) && typeof row?.value === 'string' && row.value.trim());
}

async function hasLiveData(store) {
  const rows = await Promise.all(LIVE_SHAPES.map((shape) => store.rows(shape, { limit: 1 })));
  return rows.some((shapeRows) => Array.isArray(shapeRows) && shapeRows.length > 0);
}

async function latestRun(store, sourceId) {
  if (typeof store.lastRun === 'function') return (await store.lastRun(sourceId)) ?? null;
  if (typeof store.lastRunPerSource === 'function') {
    const runs = await store.lastRunPerSource();
    return runs.find((run) => run.source_id === sourceId) ?? null;
  }
  if (typeof store.recentRuns === 'function') {
    const runs = await store.recentRuns(100);
    return runs.find((run) => run.source_id === sourceId) ?? null;
  }
  return null;
}

async function hasRunHistory(store) {
  if (typeof store.recentRuns === 'function') return (await store.recentRuns(1)).length > 0;
  if (typeof store.lastRunPerSource === 'function') return (await store.lastRunPerSource()).length > 0;
  return false;
}

/**
 * Return setup state for a store and source registry. The first call on a genuinely fresh store
 * writes SETUP_STARTED_AT. A database that was initialized and later had its canonical rows
 * cleared still has run history, so it is never reported as a first run.
 */
export async function getSetupStatus(store, { sources = [], now = Date.now() } = {}) {
  const [dataEmpty, settings, marker, runHistory] = await Promise.all([
    hasLiveData(store).then((hasData) => !hasData),
    typeof store.settings === 'function' ? store.settings() : [],
    typeof store.getSetting === 'function' ? store.getSetting(SETUP_STARTED_AT) : null,
    hasRunHistory(store),
  ]);

  // Feed credentials alone do not make a store initialized: a user may paste both URLs before
  // the first poll. Durable user-owned settings do, however, so a database with no live rows but
  // a saved course/profile/office-hours choice is not mistaken for a new installation.
  const fresh = dataEmpty && !marker && !runHistory && !hasDurableUserSettings(settings);
  if (fresh && typeof store.compareAndSetSetting === 'function') {
    await store.compareAndSetSetting(SETUP_STARTED_AT, null, String(now), now);
  } else if (fresh && typeof store.setSetting === 'function') {
    await store.setSetting(SETUP_STARTED_AT, String(now), now);
  }

  const schedule = sources.find((source) => source?.id === 'uw-portal-ics');
  const learn = sources.find((source) => source?.id === 'uw-learn-ics');
  const [scheduleConfigured, learnConfigured, scheduleRun, learnRun] = await Promise.all([
    configured(schedule, settings),
    configured(learn, settings),
    latestRun(store, 'uw-portal-ics'),
    latestRun(store, 'uw-learn-ics'),
  ]);
  const scheduleCutoff = changedAt(settings, 'uw-portal-ics');
  const learnCutoff = changedAt(settings, 'uw-learn-ics');
  const scheduleSynced = scheduleConfigured && SUCCESS_OUTCOMES.has(scheduleRun?.outcome)
    && (scheduleCutoff == null || Number(scheduleRun?.started_at) >= scheduleCutoff);
  const learnSynced = learnConfigured && SUCCESS_OUTCOMES.has(learnRun?.outcome)
    && (learnCutoff == null || Number(learnRun?.started_at) >= learnCutoff);
  // Existing populated installations are not onboarding just because a feed is absent. A marker
  // (or this first fresh response) scopes the checklist to a newly started onboarding flow, and
  // it ends once both core feeds have reported a successful or valid-empty latest run.
  const setupNeeded = Boolean(marker || fresh) && !(scheduleSynced && learnSynced);

  return {
    data_empty: dataEmpty,
    first_run: fresh,
    schedule_configured: scheduleConfigured,
    learn_configured: learnConfigured,
    schedule_synced: scheduleSynced,
    learn_synced: learnSynced,
    setup_needed: setupNeeded,
  };
}
