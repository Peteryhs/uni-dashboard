/**
 * Per-card payload schemas.
 *
 * Why these exist: the canonical rows are validated at the write boundary, but the card payload is
 * what clients actually render, and it is computed. Without a schema here, a wrong type reaches the
 * UI quietly. It did on the first live run: a column with TEXT affinity turned epoch milliseconds
 * into the string "1789997400000.0", and `next_commitment.data.starts_at` was a string. A schema
 * that says "integer" turns that class of bug into a loud failure in the run, not a broken card.
 */
import { z } from 'zod';
import { EPOCH_MS } from './canonical.mjs';

export const WeatherSlice = z.object({
  hour: EPOCH_MS.optional(),
  temp_c: z.number().nullable().optional(),
  feels_c: z.number().nullable().optional(),
  precip_prob: z.number().nullable().optional(),
  precip_mm: z.number().nullable().optional(),
  wind_kmh: z.number().nullable().optional(),
  show: z.boolean().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
}).partial();

export const NextCommitmentData = z.object({
  title: z.string(),
  subtitle: z.string().default(''),
  kind: z.enum(['class', 'exam', 'deadline', 'event']).optional(),
  location: z.string().default(''),
  starts_at: EPOCH_MS.optional(),
  ends_at: EPOCH_MS.optional(),
  all_day: z.boolean().optional(),
  walk_minutes: z.number().nullable().optional(),
  leave_by: EPOCH_MS.nullable().optional(),
  from_building: z.string().optional(),
  from_location: z.string().optional(),
  from_source: z.string().optional(),
  nav_url: z.string().nullable().optional(),
  weather: WeatherSlice.nullable().optional(),
});

export const DueSoonData = z.object({
  count: z.number().int().nonnegative(),
  nearest_at: EPOCH_MS.nullable(),
  window_days: z.number().int().positive(),
  courses: z.array(
    z.object({
      course: z.string(),
      count: z.number().int().nonnegative(),
      items: z.array(
        z.object({
          title: z.string(),
          starts_at: EPOCH_MS,
          kind: z.string().optional(),
          url: z.string().optional(),
        }),
      ),
    }),
  ),
});

export const FoodData = z.object({
  service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pinned: z.array(
    z.object({
      outlet: z.string(),
      pinned: z.literal(true),
      serving: z.boolean(),
      dish_count: z.number().int().nonnegative(),
      dishes: z.array(
        z.object({
          dish: z.string(),
          diet: z.array(z.string()).default([]),
          url: z.string().default(''),
        }),
      ),
      hidden_dishes: z.number().int().nonnegative().default(0),
    }),
  ),
  others: z.array(
    z.object({
      outlet: z.string(),
      pinned: z.literal(false),
      serving: z.boolean(),
      dish_count: z.number().int().nonnegative(),
    }),
  ),
  others_count: z.number().int().nonnegative(),
  total_dishes: z.number().int().nonnegative(),
});

export const AlertData = z.object({
  count: z.number().int().nonnegative(),
  notices: z.array(
    z.object({
      severity: z.string(),
      title: z.string(),
      url: z.string().default(''),
    }),
  ),
});

export const CARD_DATA_SCHEMAS = {
  next_commitment: NextCommitmentData,
  due_soon: DueSoonData,
  food: FoodData,
  alert: AlertData,
};

export function validateCardData(type, data) {
  const schema = CARD_DATA_SCHEMAS[type];
  if (!schema) return data; // an unknown type is the client's problem to skip, not ours to reject
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`card ${type} payload rejected at ${issue.path.join('.') || '<root>'}: ${issue.message}`);
  }
  return parsed.data;
}
