import { z } from 'zod';

export const SyllabusDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && Number(value.slice(0, 4)) >= 2000 && Number(value.slice(0, 4)) <= 2100;
}, 'must be a real calendar date between 2000 and 2100');

const SafeUrl = z.string().max(2000).refine((value) => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}, 'must be an HTTPS URL without credentials');

export const SyllabusEntry = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(['topic', 'assessment', 'reading']),
  title: z.string().trim().min(1).max(300),
  start_date: SyllabusDate,
  end_date: SyllabusDate,
  due_at: z.number().int().nonnegative().nullable().default(null),
  topics: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  readings: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  url: SafeUrl.nullable().default(null),
  effort: z.enum(['large', 'small', 'unknown']).default('unknown'),
  estimated_minutes: z.number().int().min(1).max(6000).nullable().default(null),
  evidence: z.string().trim().min(1).max(2000),
}).superRefine((entry, ctx) => {
  if (entry.end_date < entry.start_date) ctx.addIssue({ code: 'custom', message: 'end_date must be on or after start_date', path: ['end_date'] });
  if (Date.parse(entry.end_date) - Date.parse(entry.start_date) > 370 * 86_400_000) ctx.addIssue({ code: 'custom', message: 'date range must be at most one year', path: ['end_date'] });
  if (entry.due_at != null && (entry.due_at < Date.parse(entry.start_date) - 86_400_000 || entry.due_at >= Date.parse(entry.end_date) + 2 * 86_400_000)) ctx.addIssue({ code: 'custom', message: 'due_at must fall within the entry date range', path: ['due_at'] });
});

export const CourseSyllabus = z.object({
  course: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  term_start: SyllabusDate.nullable().default(null),
  entries: z.array(SyllabusEntry).max(200),
  warnings: z.array(z.string().max(400)).max(30).default([]),
  updated_at: z.number().int().nonnegative(),
}).superRefine((document, ctx) => {
  if (new Set(document.entries.map((entry) => entry.id)).size !== document.entries.length) ctx.addIssue({ code: 'custom', message: 'entry IDs must be unique', path: ['entries'] });
});

export const SyllabusPreview = z.object({ syllabus: CourseSyllabus, method: z.enum(['rules', 'ai']), warnings: z.array(z.string()) });

export function validateSyllabus(document) { return CourseSyllabus.parse(document); }
