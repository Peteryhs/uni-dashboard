/**
 * Canonical shapes. Every source maps onto one of these or it does not get built.
 *
 * Four columns are non-negotiable on every row: source_id, external_id, observed_at,
 * valid_until. They are what make honest staleness, caching and offline possible.
 *
 * Dialect-neutral on purpose: timestamps are epoch milliseconds (integers), never
 * timestamptz strings, so the same code runs on SQLite/D1 and Postgres.
 */
import { z } from 'zod';

export const EPOCH_MS = z.number().int().nonnegative();

/** Columns every canonical row carries. */
export const RowBase = {
  source_id: z.string().min(1),
  external_id: z.string().min(1),
  observed_at: EPOCH_MS,
  valid_until: EPOCH_MS,
};

export const TimelineEvent = z.object({
  ...RowBase,
  kind: z.enum(['class', 'exam', 'deadline', 'event', 'office_hours']),
  title: z.string(),
  subtitle: z.string().default(''),
  location: z.string().default(''),
  all_day: z.boolean().default(false),
  starts_at: EPOCH_MS,
  ends_at: EPOCH_MS,
  url: z.string().default(''),
  /**
   * The feed's own text for this event. It matters more than it looks: LEARN puts the task's links
   * and instructions in DESCRIPTION and nothing in the URL property, so dropping this field drops
   * the only route from a deadline to the dropbox or quiz it belongs to. Zod strips unknown keys, so
   * a field that is not declared here never reaches storage at all.
   */
  description: z.string().default(''),
});

export const MenuItem = z.object({
  ...RowBase,
  outlet: z.string().min(1),
  station: z.string().default(''),
  dish: z.string().min(1),
  service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  diet: z.array(z.string()).default([]),
  allergens: z.array(z.string()).default([]),
  url: z.string().default(''),
});

export const PlaceState = z.object({
  ...RowBase,
  place_id: z.string().min(1),
  name: z.string().default(''),
  parent_place_id: z.string().default(''),
  is_open: z.boolean().nullable().default(null),
  people: z.number().int().nonnegative().nullable().default(null),
  capacity: z.number().int().nonnegative().nullable().default(null),
});

export const Notice = z.object({
  ...RowBase,
  severity: z.enum(['info', 'minor', 'major', 'critical', 'credential']),
  scope: z.string().default('campus'),
  title: z.string(),
  body: z.string().default(''),
  url: z.string().default(''),
});

export const Metric = z.object({
  ...RowBase,
  name: z.string().min(1),
  place_id: z.string().default(''),
  at: EPOCH_MS,
  value: z.number(),
});

export const SourceRun = z.object({
  source_id: z.string().min(1),
  started_at: EPOCH_MS,
  finished_at: EPOCH_MS,
  outcome: z.enum(['ok', 'empty', 'failed', 'implausible', 'skipped']),
  http_status: z.number().int().nullable().default(null),
  bytes: z.number().int().nonnegative().default(0),
  rows_written: z.number().int().nonnegative().default(0),
  error: z.string().default(''),
  body_sha256: z.string().default(''),
});

export const CANONICAL = {
  timeline_event: TimelineEvent,
  menu_item: MenuItem,
  place_state: PlaceState,
  notice: Notice,
  metric: Metric,
};

/** Fails loudly with the first offending path, which is what an adapter wants at the boundary. */
export function validateRow(schemaName, row) {
  const schema = CANONICAL[schemaName];
  if (!schema) throw new Error(`unknown canonical shape: ${schemaName}`);
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${schemaName} row rejected at ${issue.path.join('.') || '<root>'}: ${issue.message}`,
    );
  }
  return parsed.data;
}

export function validateRows(schemaName, rows) {
  return rows.map((r) => validateRow(schemaName, r));
}
