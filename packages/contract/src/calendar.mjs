/** Unified calendar response, validated at the API and client boundaries. */
import { z } from 'zod';
import { EPOCH_MS } from './canonical.mjs';

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const CalendarEvent = z.object({
  id: z.string().min(1),
  occurrence_id: z.string().min(1),
  uid: z.string().nullable(),
  source_id: z.string().min(1),
  source_label: z.string().min(1),
  kind: z.string().min(1),
  category: z.enum(['class', 'deadline', 'opens', 'exam', 'office_hours', 'event']),
  phase: z.enum(['due', 'opens']).nullable(),
  title: z.string(),
  subtitle: z.string(),
  course: z.string().nullable(),
  location: z.string(),
  description: z.string(),
  url: z.string().nullable(),
  links: z.array(z.object({ label: z.string(), url: z.string(), kind: z.string() })),
  starts_at: EPOCH_MS,
  ends_at: EPOCH_MS,
  all_day: z.boolean(),
  continues_from_previous: z.boolean(),
  continues_next_day: z.boolean(),
  group_scope: z.object({ section: z.number().int().nullable(), groups: z.tuple([z.number().int(), z.number().int()]).nullable() }),
  observed_at: EPOCH_MS,
  state: z.enum(['live', 'ageing', 'stale', 'dead']),
  topics: z.array(z.string()).default([]),
  readings: z.array(z.string()).default([]),
  syllabus_evidence: z.array(z.string()).default([]),
  syllabus_scope: z.enum(['date', 'period']).nullable().default(null),
  due_at: EPOCH_MS.nullable().optional().default(null),
});

export const CalendarLearning = z.object({
  course: z.string(), title: z.string(), topics: z.array(z.string()), readings: z.array(z.string()),
  evidence: z.string(), start_date: DateOnly, end_date: DateOnly,
});

export const CalendarResponse = z.object({
  schema_version: z.literal(1),
  timezone: z.string(),
  generated_at: EPOCH_MS,
  start: DateOnly,
  end: DateOnly,
  days: z.array(z.object({ date: DateOnly, events: z.array(CalendarEvent), learning: z.array(CalendarLearning).default([]) })),
  courses: z.array(z.object({
    course: z.string(),
    learn_url: z.string().nullable(),
    event_ids: z.array(z.string()),
    class_count: z.number().int().nonnegative(),
    deadline_count: z.number().int().nonnegative(),
    office_hours_count: z.number().int().nonnegative(),
    resources: z.array(z.object({ title: z.string(), url: z.string(), kind: z.enum(['learn', 'textbook', 'resource']) })),
  })).default([]),
  count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  sources: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(['ok', 'unconfigured', 'pending', 'failed']),
    last_run_at: EPOCH_MS.nullable(),
  })),
});

export function validateCalendar(value) {
  return CalendarResponse.parse(value);
}
