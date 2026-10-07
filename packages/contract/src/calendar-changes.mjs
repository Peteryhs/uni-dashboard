import { z } from 'zod';
import { EPOCH_MS } from './canonical.mjs';

export const CHANGE_KINDS = ['room', 'unusual_room', 'time', 'deadline', 'cancelled', 'removed', 'tutorial_work'];

/**
 * The structured "before → after" of a change, so clients draw [PSE 535] → [PSE 545] or
 * [10:30] → [11:30] instead of a sentence. Empty location / null time means "not part of this change".
 */
export const ChangeDetail = z.object({
  kind: z.enum(CHANGE_KINDS),
  previous_location: z.string(),
  location: z.string(),
  previous_at: EPOCH_MS.nullable().default(null),
  current_at: EPOCH_MS.nullable().default(null),
  all_day: z.boolean().default(false),
  confidence: z.enum(['confirmed', 'check']),
});

export const CalendarChangeAlert = z.object({
  id: z.string().min(1), event_id: z.string().nullable(),
  kind: z.enum(CHANGE_KINDS),
  title: z.string(), body: z.string(), course: z.string().nullable(),
  starts_at: EPOCH_MS, ends_at: EPOCH_MS, observed_at: EPOCH_MS,
  location: z.string(), previous_location: z.string(),
  previous_at: EPOCH_MS.nullable().default(null), current_at: EPOCH_MS.nullable().default(null), all_day: z.boolean().default(false),
  url: z.string().nullable(),
  confidence: z.enum(['confirmed', 'check']), evidence: z.string(), source_label: z.string(),
  state: z.enum(['live', 'ageing', 'stale', 'dead']),
});

/** The ChangeDetail view of an alert. */
export function changeDetail(alert) {
  return {
    kind: alert.kind, previous_location: alert.previous_location || '', location: alert.location || '',
    previous_at: alert.previous_at ?? null, current_at: alert.current_at ?? null, all_day: Boolean(alert.all_day), confidence: alert.confidence,
  };
}
