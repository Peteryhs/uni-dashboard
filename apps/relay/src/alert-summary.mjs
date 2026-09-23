/** Compact alert text and acknowledgement, persisted across clients and Worker invocations. */
import { hashKey, summarizeAlertsWithAi } from './ai.mjs';
import { aiBudgetGuard } from './ai-budget.mjs';

const SUMMARY_KEY = 'ALERT_SUMMARY_JSON';
const DISMISSED_KEY = 'ALERT_DISMISSED_KEY';
const USAGE_KEY = 'ALERT_AI_USAGE_JSON';
const RETRY_MS = 15 * 60_000;
const MAX_AI_SUMMARIES_PER_DAY = 8;

function parseJson(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

export function alertIdentity(notices) {
  if (!notices.length) return '';
  return hashKey(JSON.stringify(notices.map((notice) => [notice.external_id, notice.title, notice.components || []]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
}

function contentSignature(notices) {
  return hashKey(JSON.stringify(notices.map((notice) => [notice.external_id, notice.title, notice.body || '', notice.components || [], notice.severity]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
}

export function fallbackAlertSentence(notices) {
  const notice = [...notices].sort((a, b) => ({ critical: 3, major: 2, minor: 1 }[b.severity] || 0) - ({ critical: 3, major: 2, minor: 1 }[a.severity] || 0))[0];
  if (!notice) return '';
  const service = notice.components?.[0];
  const title = String(notice.title || 'Campus service incident').replace(/[.!?]+$/, '');
  const sentence = service && !title.toLowerCase().includes(service.toLowerCase()) ? `${title} affects ${service}` : title;
  return `${sentence.slice(0, 200)}.`;
}

export function alertSummaryFor(notices, raw) {
  const saved = parseJson(raw, null);
  return saved?.signature === contentSignature(notices) && saved.status === 'ready'
    ? saved.summary : fallbackAlertSentence(notices);
}

export async function syncAlertSummary(store, { cfEnv = null, now = Date.now() } = {}) {
  const notices = (await store.rows('notice', { where: 'source_id = ?', params: ['uw-status'], limit: 20 }))
    .filter((notice) => ['minor', 'major', 'critical'].includes(notice.severity));
  if (!notices.length) return { status: 'empty' };
  const signature = contentSignature(notices);
  const previous = parseJson(await store.getSetting(SUMMARY_KEY), null);
  if (previous?.signature === signature) {
    if (previous.status === 'ready' || (previous.status === 'limited' && new Date(previous.updated_at).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10))) return { status: previous.status, cached: true };
    if (now - (previous.updated_at || 0) < RETRY_MS) return { status: previous.status, cached: true };
  }
  const date = new Date(now).toISOString().slice(0, 10);
  const usage = parseJson(await store.getSetting(USAGE_KEY), {});
  const count = usage.date === date ? usage.count || 0 : 0;
  if (count >= MAX_AI_SUMMARIES_PER_DAY) {
    await store.setSetting(SUMMARY_KEY, JSON.stringify({ signature, status: 'limited', updated_at: now }));
    return { status: 'limited' };
  }
  await store.setSetting(USAGE_KEY, JSON.stringify({ date, count: count + 1 }));
  await store.setSetting(SUMMARY_KEY, JSON.stringify({ signature, status: 'processing', updated_at: now }));
  try {
    const summary = await summarizeAlertsWithAi({ notices, cfEnv, now, beforeAiCall: aiBudgetGuard(store) });
    const current = parseJson(await store.getSetting(SUMMARY_KEY), null);
    if (current?.signature === signature) await store.setSetting(SUMMARY_KEY, JSON.stringify({ signature, status: 'ready', summary, updated_at: Date.now() }));
    return { status: 'ready', summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = parseJson(await store.getSetting(SUMMARY_KEY), null);
    if (current?.signature === signature) await store.setSetting(SUMMARY_KEY, JSON.stringify({ signature, status: 'failed', error: message, updated_at: Date.now() }));
    return { status: 'failed', error: message };
  }
}

export async function dismissAlert(store, key) {
  const notices = (await store.rows('notice', { where: 'source_id = ?', params: ['uw-status'], limit: 20 }))
    .filter((notice) => ['minor', 'major', 'critical'].includes(notice.severity));
  if (!key || key !== alertIdentity(notices)) return false;
  await store.setSetting(DISMISSED_KEY, key);
  return true;
}

export const ALERT_SUMMARY_SETTING = SUMMARY_KEY;
export const ALERT_DISMISSED_SETTING = DISMISSED_KEY;
