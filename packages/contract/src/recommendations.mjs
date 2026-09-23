/** Backend-ranked, explainable recommendations shared by web and mobile clients. */
import { z } from 'zod';
import { EPOCH_MS } from './canonical.mjs';

export const RecommendationItem = z.object({
  id: z.string().min(1).max(240),
  revision: z.string(),
  kind: z.enum(['class', 'task', 'learning', 'office_hours', 'focus', 'conflict', 'food', 'weather']),
  priority: z.number(),
  title: z.string(),
  body: z.string(),
  course: z.string().nullable(),
  starts_at: EPOCH_MS.nullable(),
  ends_at: EPOCH_MS.nullable(),
  due_at: EPOCH_MS.nullable(),
  scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  time_label: z.enum(['Due', 'Starts', 'Scheduled']).nullable(),
  effort: z.enum(['large', 'small', 'unknown']),
  estimated_minutes: z.number().int().positive().nullable(),
  available_minutes: z.number().int().positive().nullable(),
  action: z.object({ label: z.string(), url: z.string().url() }).nullable(),
  topics: z.array(z.string()),
  readings: z.array(z.string()),
  reason: z.string(),
  evidence: z.string(),
  source_label: z.string(),
  state: z.enum(['live', 'ageing', 'stale', 'dead']),
  can_complete: z.boolean(),
});

export const RecommendationResponse = z.object({
  schema_version: z.literal(1),
  generated_at: EPOCH_MS,
  timezone: z.string(),
  refresh_after_ms: z.number().int().positive(),
  headline: z.string(),
  items: z.array(RecommendationItem),
  tasks: z.object({ large: z.array(RecommendationItem), small: z.array(RecommendationItem) }),
  warnings: z.array(z.string()),
});

export function validateRecommendations(value) { return RecommendationResponse.parse(value); }
