/**
 * The client contract: one bundle, card-shaped.
 *
 * Rules that exist so two clients can never disagree:
 *  - every card carries its own observed_at and valid_until (the freshness envelope)
 *  - a card that cannot be built is still sent, with state 'empty' | 'degraded'
 *  - unknown card types are skipped and counted by the client, never fatal
 *  - ordering is server-computed priority, so web and Android agree without a release
 */
import { z } from 'zod';
import { EPOCH_MS } from './canonical.mjs';

export const SCHEMA_VERSION = 1;

export const CARD_STATES = ['live', 'ageing', 'stale', 'dead', 'empty', 'degraded', 'failed'];

export const Card = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  priority: z.number(),
  state: z.enum(CARD_STATES),
  observed_at: EPOCH_MS.nullable(),
  valid_until: EPOCH_MS.nullable(),
  /** which source this card's data came from, for the admin surface */
  source_id: z.string().default(''),
  /** free-form per card type; each type declares its own schema in cards/*.mjs */
  data: z.record(z.string(), z.unknown()).default({}),
});

export const Bundle = z.object({
  schema_version: z.number().int(),
  min_client_version: z.number().int(),
  generated_at: EPOCH_MS,
  cards: z.array(Card),
});

/**
 * The age ladder. Age is measured against the source's own cadence, not the clock, so a
 * four-minute-old menu is fresh and a four-minute-old live value is not.
 *
 *   within 1x cadence -> live
 *   1x to 3x          -> ageing
 *   3x to 6x          -> stale
 *   beyond 6x         -> dead
 */
export function ageState(observedAt, cadenceMs, now = Date.now()) {
  if (observedAt == null || !Number.isFinite(observedAt)) return 'empty';
  if (!Number.isFinite(cadenceMs) || cadenceMs <= 0) return 'live';
  const age = Math.max(0, now - observedAt);
  if (age <= cadenceMs) return 'live';
  if (age <= cadenceMs * 3) return 'ageing';
  if (age <= cadenceMs * 6) return 'stale';
  return 'dead';
}

/** Motion, dashed hairlines and amber are driven off this, so it is the honesty channel. */
export function ageDescriptor(state) {
  switch (state) {
    case 'live':
      return { hairline: 'accent', motion: true, muted: false, dash: false, dot: false };
    case 'ageing':
      return { hairline: 'faded', motion: true, muted: false, dash: false, dot: false };
    case 'stale':
      return { hairline: 'amber', motion: false, muted: true, dash: true, dot: false };
    case 'dead':
      return { hairline: 'amber', motion: false, muted: true, dash: true, dot: true };
    default:
      return { hairline: 'none', motion: false, muted: true, dash: false, dot: false };
  }
}

export function buildBundle(cards, now = Date.now()) {
  return Bundle.parse({
    schema_version: SCHEMA_VERSION,
    min_client_version: 1,
    generated_at: now,
    cards: [...cards].sort((a, b) => b.priority - a.priority),
  });
}

/** Client-side rule: skip what you do not understand, count it, never crash. */
export function renderableCards(bundle, knownTypes) {
  const known = new Set(knownTypes);
  const rendered = [];
  let skipped = 0;
  for (const card of bundle.cards) {
    if (known.has(card.type)) rendered.push(card);
    else skipped += 1;
  }
  return { rendered, skipped };
}

export function validateBundle(bundle) {
  const parsed = Bundle.safeParse(bundle);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`bundle rejected at ${issue.path.join('.') || '<root>'}: ${issue.message}`);
  }
  return parsed.data;
}
