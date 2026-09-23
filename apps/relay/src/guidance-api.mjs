/** Shared routes for daily guidance, syllabus import and AI allowance on both runtimes. */
import { calendarOptions } from './calendar.mjs';
import { buildRecommendations, saveRecommendationAction } from './recommendations.mjs';
import { getCourseSyllabus, previewSyllabus, saveCourseSyllabus } from './syllabus.mjs';
import { aiBudgetGuard, aiBudgetStatus } from './ai-budget.mjs';
import { getCachedWeather } from './weather-cache.mjs';

export function isGuidanceRoute(path) {
  return path === '/v1/recommendations' || path === '/v1/recommendations/actions' || path === '/v1/ai/usage' ||
    /^\/v1\/courses\/[^/]+\/syllabus(?:\/preview)?$/.test(path);
}

/** Bounded body reader usable with Web streams and Node IncomingMessage async iterators. */
export async function readGuidanceJson(stream) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream || []) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    size += bytes.byteLength;
    if (size > 300_000) {
      const error = new RangeError('Import is too large; paste a syllabus of at most 60,000 characters.');
      error.status = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new RangeError('Body must be a JSON object'); }
}

export async function handleGuidanceRoute({ url, method, readBody, store, cfEnv = null, now = Date.now() }) {
  try {
    if (url.pathname === '/v1/recommendations' && method === 'GET') {
      const { section, group } = calendarOptions(url.searchParams, now);
      const weather = await getCachedWeather(store, { now });
      return { status: 200, body: await buildRecommendations(store, { now, section, group, weather }) };
    }
    if (url.pathname === '/v1/recommendations/actions' && method === 'POST') {
      const result = await saveRecommendationAction(store, await readBody(), { now });
      return { status: 200, body: { ok: true, ...result } };
    }
    if (url.pathname === '/v1/ai/usage' && method === 'GET') {
      return { status: 200, body: await aiBudgetStatus(store, now) };
    }
    const match = /^\/v1\/courses\/([^/]+)\/syllabus(\/preview)?$/.exec(url.pathname);
    if (match) {
      const course = decodeURIComponent(match[1]);
      if (match[2] && method === 'POST') {
        const input = await readBody();
        return { status: 200, body: await previewSyllabus(store, { ...input, course }, { cfEnv, now, beforeAiCall: aiBudgetGuard(store) }) };
      }
      if (!match[2] && method === 'GET') return { status: 200, body: { syllabus: await getCourseSyllabus(store, course) } };
      if (!match[2] && method === 'PUT') return { status: 200, body: { syllabus: await saveCourseSyllabus(store, course, await readBody(), { now }) } };
    }
    return { status: 405, body: { error: 'Method not allowed' } };
  } catch (error) {
    if (error instanceof RangeError || error instanceof URIError || error.name === 'ZodError' || error.status) {
      return { status: error.status || 400, body: { error: error.message } };
    }
    throw error;
  }
}
