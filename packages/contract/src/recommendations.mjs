/** Backend-ranked, explainable recommendations shared by web and mobile clients. */
import { z } from 'zod';
import { EPOCH_MS } from './canonical.mjs';
import { ChangeDetail } from './calendar-changes.mjs';

export const RecommendationItem = z.object({
  id: z.string().min(1).max(240),
  revision: z.string(),
  kind: z.enum(['class', 'task', 'learning', 'office_hours', 'focus', 'conflict', 'food', 'weather', 'change']),
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
  /** Set on `change` items, and on `class` items whose session has a room or tutorial notice. */
  change: ChangeDetail.nullable().default(null),
});

/** A trace of actual server decisions, without source URLs or raw imported descriptions. */
export const RecommendationDiagnostics = z.object({
  version: z.literal(1),
  policy: z.object({
    schedule_notice_hours: z.number().int().positive(),
    deadline_change_hours: z.number().int().positive(),
    tutorial_work_notice_hours: z.number().int().positive().default(72),
    task_horizon_days: z.number().int().positive(),
    small_task_feed_days: z.number().int().positive(),
    max_feed_items: z.number().int().positive(),
  }),
  summary: z.object({ shown: z.number().int().nonnegative(), deferred: z.number().int().nonnegative(), suppressed: z.number().int().nonnegative() }),
  candidates: z.array(z.object({
    id: z.string(),
    kind: RecommendationItem.shape.kind,
    title: z.string(),
    course: z.string().nullable(),
    starts_at: EPOCH_MS.nullable(),
    due_at: EPOCH_MS.nullable(),
    scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    priority: z.number(),
    status: z.enum(['shown', 'deferred', 'suppressed']),
    reason: z.string(),
    eligible_at: EPOCH_MS.nullable(),
    position: z.number().int().positive().nullable(),
    course_penalty: z.number().int().nonnegative(),
    ranking_score: z.number().nullable(),
    /** Keep structured before/after details available for deferred and capped changes. */
    change: ChangeDetail.nullable().default(null),
  })),
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
  diagnostics: RecommendationDiagnostics.optional(),
});

export function validateRecommendations(value) { return RecommendationResponse.parse(value); }
