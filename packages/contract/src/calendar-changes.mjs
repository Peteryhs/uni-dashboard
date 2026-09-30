import { z } from 'zod';
import { EPOCH_MS } from './canonical.mjs';

export const CalendarChangeAlert = z.object({
  id: z.string().min(1), event_id: z.string().nullable(),
  kind: z.enum(['room', 'unusual_room', 'time', 'deadline', 'cancelled', 'removed', 'tutorial_work']),
  title: z.string(), body: z.string(), course: z.string().nullable(),
  starts_at: EPOCH_MS, ends_at: EPOCH_MS, observed_at: EPOCH_MS,
  location: z.string(), previous_location: z.string(), url: z.string().nullable(),
  confidence: z.enum(['confirmed', 'check']), evidence: z.string(), source_label: z.string(),
  state: z.enum(['live', 'ageing', 'stale', 'dead']),
});
