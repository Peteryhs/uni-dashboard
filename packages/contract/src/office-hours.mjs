/**
 * Contract schemas for office hours rules and AI draft responses.
 *
 * Stored as a single JSON blob under setting key 'OFFICE_HOURS_JSON'.
 * The source 'user-office-hours' expands these rules into canonical TimelineEvent rows.
 */
import { z } from 'zod';
import { EPOCH_MS } from './canonical.mjs';

export const WeekdayCode = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

export const OfficeHourKind = z.enum(['office_hours', 'tutorial', 'help_session', 'other']);

/** Base fields shared by draft rules and persisted rules */
export const OfficeHourRuleBase = {
  course: z.string().default(''),
  label: z.string().default('Office hours'),
  kind: OfficeHourKind.default('office_hours'),
  host: z.string().default(''),
  location: z.string().default(''),
  byday: z.array(WeekdayCode).min(1),
  /** 24h wall-clock string "HH:MM", never epoch */
  start_local: z.string().regex(/^\d{2}:\d{2}$/),
  /** 24h wall-clock string "HH:MM", never epoch */
  end_local: z.string().regex(/^\d{2}:\d{2}$/),
  /** Inclusive start date YYYY-MM-DD or null (starts immediately) */
  starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  /** Inclusive end date YYYY-MM-DD or null (+120 days default) */
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  notes: z.string().default(''),
  confidence: z.number().min(0).max(1).default(1),
  source_text: z.string().default(''),
};

export const OfficeHourRule = z.object({
  id: z.string().min(1),
  ...OfficeHourRuleBase,
  created_at: EPOCH_MS,
  updated_at: EPOCH_MS,
});

export const OfficeHoursConfig = z.object({
  rules: z.array(OfficeHourRule).default([]),
  version: z.literal(1).default(1),
});

export const OfficeHoursDraftRule = z.object({
  ...OfficeHourRuleBase,
});

export const OfficeHoursDraft = z.object({
  rules: z.array(OfficeHoursDraftRule).default([]),
  warnings: z.array(z.string()).default([]),
});

export const PreviewOccurrence = z.object({
  rule_index: z.number().int().nonnegative(),
  starts_at: EPOCH_MS,
  ends_at: EPOCH_MS,
  label: z.string(),
  location: z.string().default(''),
});

/**
 * JSON Schema definition for Cloudflare AI constrained decoding.
 */
export const OFFICE_HOURS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          course: { type: 'string' },
          label: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['office_hours', 'tutorial', 'help_session', 'other'],
          },
          host: { type: 'string' },
          location: { type: 'string' },
          byday: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'],
            },
          },
          start_local: { type: 'string' },
          end_local: { type: 'string' },
          starts_on: { type: ['string', 'null'] },
          until: { type: ['string', 'null'] },
          notes: { type: 'string' },
          confidence: { type: 'number' },
          source_text: { type: 'string' },
        },
        required: ['label', 'kind', 'byday', 'start_local', 'end_local'],
      },
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['rules', 'warnings'],
};
