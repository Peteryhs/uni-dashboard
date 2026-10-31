import { z } from 'zod';
import { CourseSyllabus } from '#contract/syllabus.mjs';
import { FoodAiRecommendation } from '#contract/card-data.mjs';

const menu = z.object({ requested_date: z.string(), service_date: z.string().nullable(), status: z.enum(['today', 'upcoming', 'previous', 'unavailable']), observed_at: z.number().nullable().optional(), valid_until: z.number().nullable().optional(), cadence_ms: z.number().optional(), state: z.string().optional(), items: z.array(z.object({ outlet: z.string(), station: z.string(), dish: z.string(), diet: z.array(z.string()), allergens: z.array(z.string()), url: z.string() })) });
const weather = z.object({ temp_c: z.number().nullable(), observed_at: z.number().nullable(), state: z.string() });
const ranking = z.object({ status: z.string(), recommendation: FoodAiRecommendation.nullable(), stale: z.boolean().optional(), error: z.string().optional() });
function schema(path: string) {
  if (path.startsWith('/v1/menu')) return menu;
  if (path === '/v1/weather/current') return weather;
  if (path.startsWith('/v1/food/recommendation?')) return ranking;
  if (/^\/v1\/courses\/[^/]+\/syllabus$/.test(path)) return z.object({ syllabus: CourseSyllabus.nullable() });
  return null;
}
const prefix = 'uni-dashboard:saved-read:v1:';
export function saveRead(path: string, value: unknown) {
  const validator = schema(path); if (!validator) return;
  try {
    localStorage.setItem(prefix + path, JSON.stringify({ at: Date.now(), value: validator.parse(value) }));
    const keys = Object.keys(localStorage).filter(k => k.startsWith(prefix));
    if (keys.length > 40) keys.sort((a, b) => JSON.parse(localStorage.getItem(a) || '{}').at - JSON.parse(localStorage.getItem(b) || '{}').at).slice(0, keys.length - 40).forEach(k => localStorage.removeItem(k));
  } catch { /* A full or disabled cache does not interrupt a successful request. */ }
}
export function savedRead(path: string): unknown | undefined {
  const validator = schema(path); if (!validator) return;
  try {
    const raw = localStorage.getItem(prefix + path); if (!raw) return;
    const record = JSON.parse(raw); if (!Number.isFinite(record.at) || record.at > Date.now()) return;
    const value = validator.parse(record.value);
    if ('state' in value) return { ...value, state: 'stale' };
    if ('recommendation' in value) return { ...value, stale: true };
    return value;
  } catch { return; }
}
