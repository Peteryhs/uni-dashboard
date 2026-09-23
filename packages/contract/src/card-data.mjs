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

export const FollowingCommitment = z.object({
  title: z.string(),
  kind: z.enum(['class', 'exam', 'deadline', 'event', 'office_hours']).optional(),
  location: z.string().default(''),
  starts_at: EPOCH_MS.optional(),
  ends_at: EPOCH_MS.optional(),
  all_day: z.boolean().optional(),
});

export const NextCommitmentData = z.object({
  title: z.string(),
  subtitle: z.string().default(''),
  kind: z.enum(['class', 'exam', 'deadline', 'event', 'office_hours']).optional(),
  location: z.string().default(''),
  starts_at: EPOCH_MS.optional(),
  ends_at: EPOCH_MS.optional(),
  all_day: z.boolean().optional(),
  weather: WeatherSlice.nullable().optional(),
  following: FollowingCommitment.nullable().optional(),
});

export const DueSoonLink = z.object({
  label: z.string(),
  url: z.string(),
  kind: z.string(),
});

export const DueSoonItem = z.object({
  title: z.string(),
  starts_at: EPOCH_MS,
  kind: z.string().optional(),
  url: z.string().optional(),
  /** the course the feed itself states, when it states one */
  course: z.string().optional(),
  /** a room or venue; for LEARN tasks the course arrives in LOCATION, so this is usually empty */
  location: z.string().optional(),
  /** the instructions, with the link plumbing stripped out */
  description: z.string().optional(),
  /** every link the feed carried, most useful first */
  links: z.array(DueSoonLink).default([]),
  uid: z.string().optional(),
  occurrence_id: z.string().optional(),
  phase: z.enum(['due', 'opens']).optional(),
  all_day: z.boolean().optional(),
  significant: z.boolean().optional(),
  group_scope: z
    .object({
      section: z.number().nullable(),
      groups: z.tuple([z.number(), z.number()]).nullable(),
    })
    .optional(),
});

export const DueSoonAheadGroup = z.object({
  week_start: EPOCH_MS,
  label: z.string(),
  items: z.array(DueSoonItem),
});

export const DueSoonData = z.object({
  count: z.number().int().nonnegative(),
  nearest_at: EPOCH_MS.nullable(),
  window_days: z.number().int().positive(),
  /** the same tasks in time order, which is the order the card reads them in */
  items: z.array(DueSoonItem).default([]),
  courses: z.array(
    z.object({
      course: z.string(),
      count: z.number().int().nonnegative(),
      items: z.array(DueSoonItem),
    }),
  ),
  due: z.array(DueSoonItem).default([]),
  opens: z.array(DueSoonItem).default([]) ,
  ahead: z.array(DueSoonAheadGroup).default([]),
  next_major: z
    .object({
      title: z.string(),
      course: z.string().optional(),
      starts_at: EPOCH_MS,
    })
    .nullable()
    .optional(),
  error: z.string().optional(),
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
  error: z.string().optional(),
});

export const FoodAiHighlight = z.object({
  dish: z.string(),
  why: z.string(),
});

export const FoodAiRankedOutlet = z.object({
  outlet: z.string(),
  rank: z.number().int().positive(),
  match_score: z.number().int().min(0).max(100),
  verdict: z.string(),
  highlights: z.array(FoodAiHighlight).default([]),
});

export const FoodAiRecommendation = z.object({
  service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  model: z.string().default('@cf/google/gemma-4-26b-a4b-it'),
  headline: z.string(),
  top_outlet: z.string(),
  ranked_outlets: z.array(FoodAiRankedOutlet),
  tip: z.string().default(''),
  generated_at: EPOCH_MS,
});

export const AlertData = z.object({
  count: z.number().int().nonnegative(),
  summary: z.string().default(''),
  key: z.string().default(''),
  dismissed: z.boolean().default(false),
  /** when the status source last reported, so a client can render an old all clear as old */
  checked_at: EPOCH_MS.nullable().optional(),
  notices: z.array(
    z.object({
      severity: z.string(),
      title: z.string(),
      body: z.string().default(''),
      components: z.array(z.string()).default([]),
      incident_status: z.string().default(''),
      url: z.string().default(''),
    }),
  ),
});

export const CARD_DATA_SCHEMAS = {
  next_commitment: NextCommitmentData,
  due_soon: DueSoonData,
  food: FoodData,
  alert: AlertData,
  food_ai_recommendation: FoodAiRecommendation,
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
