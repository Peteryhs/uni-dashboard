/**
 * The bridge to packages/contract.
 *
 * The age ladder, the card envelope and the skip-unknown rule are imported from the server's own
 * contract rather than restated here. That is the point: two clients that each own a copy of the
 * ladder will disagree within a month, and the disagreement will be silent.
 */
// The contract is plain .mjs with no declaration file. TypeScript infers what it can from the
// JavaScript via allowJs; the exported shapes are pinned to explicit types below so the rest of the
// app is fully typed even though the source of truth is untyped.
import {
  ageDescriptor as ageDescriptorJs,
  ageState as ageStateJs,
  validateBundle as validateBundleJs,
  renderableCards as renderableCardsJs,
  CARD_STATES as CARD_STATES_JS,
  SCHEMA_VERSION as SCHEMA_VERSION_JS,
} from '#contract/cards.mjs';
import { validateCalendar as validateCalendarJs } from '#contract/calendar.mjs';
import { validateRecommendations as validateRecommendationsJs } from '#contract/recommendations.mjs';

export interface RecommendationItem {
  id: string;
  revision: string;
  kind: 'class' | 'task' | 'learning' | 'office_hours' | 'focus' | 'conflict' | 'food' | 'weather';
  priority: number;
  title: string;
  body: string;
  course: string | null;
  starts_at: number | null;
  ends_at: number | null;
  due_at: number | null;
  scheduled_date: string | null;
  time_label: 'Due' | 'Starts' | 'Scheduled' | null;
  effort: 'large' | 'small' | 'unknown';
  estimated_minutes: number | null;
  available_minutes: number | null;
  action: { label: string; url: string } | null;
  topics: string[];
  readings: string[];
  reason: string;
  evidence: string;
  source_label: string;
  state: 'live' | 'ageing' | 'stale' | 'dead';
  can_complete: boolean;
}

export interface RecommendationResponse {
  schema_version: 1;
  generated_at: number;
  timezone: string;
  refresh_after_ms: number;
  headline: string;
  items: RecommendationItem[];
  tasks: { large: RecommendationItem[]; small: RecommendationItem[] };
  warnings: string[];
}

export const validateRecommendations = validateRecommendationsJs as (value: unknown) => RecommendationResponse;

export type CardState =
  | 'live'
  | 'ageing'
  | 'stale'
  | 'dead'
  | 'empty'
  | 'degraded'
  | 'failed';

/** Drives motion, dashed hairlines and amber. The honesty channel, in one object. */
export interface AgeDescriptor {
  hairline: 'accent' | 'faded' | 'amber' | 'none';
  motion: boolean;
  muted: boolean;
  dash: boolean;
  dot: boolean;
}

export interface Card<TData = Record<string, unknown>> {
  id: string;
  type: string;
  priority: number;
  state: CardState;
  observed_at: number | null;
  valid_until: number | null;
  source_id: string;
  data: TData;
}

export interface Bundle {
  schema_version: number;
  min_client_version: number;
  generated_at: number;
  cards: Card[];
}

export const CARD_STATES = CARD_STATES_JS as CardState[];
export const SCHEMA_VERSION = SCHEMA_VERSION_JS as number;

export const ageDescriptor = ageDescriptorJs as (state: CardState) => AgeDescriptor;
export const ageState = ageStateJs as (
  observedAt: number | null,
  cadenceMs: number,
  now?: number,
) => CardState;

/** Throws with the offending path when the server sends something the contract rejects. */
export const validateBundle = validateBundleJs as (bundle: unknown) => Bundle;

export const renderableCards = renderableCardsJs as (
  bundle: Bundle,
  knownTypes: string[],
) => { rendered: Card[]; skipped: number };

export interface CalendarEvent {
  id: string;
  occurrence_id: string;
  uid: string | null;
  source_id: string;
  source_label: string;
  kind: string;
  category: 'class' | 'deadline' | 'opens' | 'exam' | 'office_hours' | 'event';
  phase: 'due' | 'opens' | null;
  title: string;
  subtitle: string;
  course: string | null;
  location: string;
  description: string;
  url: string | null;
  links: { label: string; url: string; kind: string }[];
  topics?: string[];
  readings?: string[];
  syllabus_evidence?: string[];
  syllabus_scope?: 'date' | 'period' | null;
  starts_at: number;
  ends_at: number;
  all_day: boolean;
  continues_from_previous: boolean;
  continues_next_day: boolean;
  group_scope: { section: number | null; groups: [number, number] | null };
  observed_at: number;
  state: 'live' | 'ageing' | 'stale' | 'dead';
}

export interface CalendarData {
  schema_version: 1;
  timezone: string;
  generated_at: number;
  start: string;
  end: string;
  days: { date: string; events: CalendarEvent[] }[];
  courses: { course: string; learn_url: string | null; event_ids: string[]; class_count: number; deadline_count: number; office_hours_count: number; resources: CourseResource[] }[];
  count: number;
  truncated: boolean;
  sources: { id: string; status: 'ok' | 'unconfigured' | 'pending' | 'failed'; last_run_at: number | null }[];
}

export interface CourseResource { title: string; url: string; kind: 'learn' | 'textbook' | 'resource' }

export const validateCalendar = validateCalendarJs as (value: unknown) => CalendarData;

// ---------------------------------------------------------------------------
// Course syllabus schedule, saved for backend calendar and recommendation use.
// ---------------------------------------------------------------------------

export type SyllabusEntryKind = 'topic' | 'assessment' | 'reading';

export interface SyllabusEntry {
  id: string;
  kind: SyllabusEntryKind;
  title: string;
  start_date: string;
  end_date: string;
  due_at: number | null;
  topics: string[];
  readings: string[];
  url: string | null;
  effort: 'large' | 'small' | 'unknown';
  estimated_minutes: number | null;
  evidence: string;
}

export interface CourseSyllabus {
  course: string;
  title: string;
  term_start: string | null;
  entries: SyllabusEntry[];
  warnings: string[];
  updated_at: number;
}

export interface CourseSyllabusPreview {
  syllabus: CourseSyllabus;
  method: 'rules' | 'ai';
  warnings: string[];
}

export interface CourseSyllabusPreviewRequest {
  text: string;
  term_start?: string;
  year?: number;
  use_ai: boolean;
}

// ---------------------------------------------------------------------------
// Per-card payload types. These mirror packages/contract/src/card-data.mjs.
// ---------------------------------------------------------------------------

export interface WeatherSlice {
  hour?: number;
  temp_c?: number | null;
  feels_c?: number | null;
  precip_prob?: number | null;
  precip_mm?: number | null;
  wind_kmh?: number | null;
  show?: boolean;
  reason?: string;
  error?: string;
}

export interface FollowingCommitment {
  title: string;
  kind?: 'class' | 'exam' | 'deadline' | 'event' | 'office_hours';
  location: string;
  starts_at?: number;
  ends_at?: number;
  all_day?: boolean;
}

export interface NextCommitmentData {
  title: string;
  subtitle: string;
  kind?: 'class' | 'exam' | 'deadline' | 'event' | 'office_hours';
  location: string;
  starts_at?: number;
  ends_at?: number;
  all_day?: boolean;
  weather?: WeatherSlice | null;
  following?: FollowingCommitment | null;
}

// ---------------------------------------------------------------------------
// Office Hours types
// ---------------------------------------------------------------------------

export type WeekdayCode = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
export type OfficeHourKind = 'office_hours' | 'tutorial' | 'help_session' | 'other';

export interface OfficeHourRule {
  id: string;
  course: string;
  label: string;
  kind: OfficeHourKind;
  host: string;
  location: string;
  byday: WeekdayCode[];
  start_local: string;
  end_local: string;
  starts_on: string | null;
  until: string | null;
  notes: string;
  confidence: number;
  source_text: string;
  created_at: number;
  updated_at: number;
}

export interface OfficeHoursConfig {
  rules: OfficeHourRule[];
  version: 1;
}

export type OfficeHoursDraftRule = Omit<OfficeHourRule, 'id' | 'created_at' | 'updated_at'>;

export interface OfficeHoursDraft {
  rules: OfficeHoursDraftRule[];
  warnings: string[];
}

export interface PreviewOccurrence {
  rule_index: number;
  starts_at: number;
  ends_at: number;
  label: string;
  location: string;
}

export interface ParseOfficeHoursResponse {
  draft: OfficeHoursDraft;
  preview: PreviewOccurrence[];
  model: string;
}

export interface DueSoonLink {
  label: string;
  url: string;
  kind: string;
}

export interface DueSoonItem {
  title: string;
  starts_at: number;
  kind?: string;
  url?: string;
  /** the course the feed states, e.g. "ECE 198" */
  course?: string;
  /** a room or venue; usually empty for LEARN tasks, where LOCATION holds the course instead */
  location?: string;
  /** the task's own instructions, link plumbing removed */
  description?: string;
  /** every link the feed carried, most useful first (dropbox and quiz before "view event") */
  links?: DueSoonLink[];
  uid?: string;
  occurrence_id?: string;
  phase?: 'due' | 'opens';
  all_day?: boolean;
  significant?: boolean;
  group_scope?: {
    section: number | null;
    groups: [number, number] | null;
  };
}

export interface DueSoonAheadGroup {
  week_start: number;
  label: string;
  items: DueSoonItem[];
}

export interface DueSoonData {
  count: number;
  nearest_at: number | null;
  window_days: number;
  /** the same tasks in time order, which is the order the card reads them in */
  items?: DueSoonItem[];
  courses: { course: string; count: number; items: DueSoonItem[] }[];
  due?: DueSoonItem[];
  opens?: DueSoonItem[];
  ahead?: DueSoonAheadGroup[];
  next_major?: {
    title: string;
    course?: string;
    starts_at: number;
  } | null;
  error?: string;
}

export interface FoodDish {
  dish: string;
  diet: string[];
  url: string;
}

export interface FoodOutletPinned {
  outlet: string;
  pinned: true;
  serving: boolean;
  dish_count: number;
  dishes: FoodDish[];
  hidden_dishes: number;
}

export interface FoodOutletOther {
  outlet: string;
  pinned: false;
  serving: boolean;
  dish_count: number;
}

export interface FoodData {
  service_date: string;
  pinned: FoodOutletPinned[];
  others: FoodOutletOther[];
  others_count: number;
  total_dishes: number;
  error?: string;
}

export interface FoodAiHighlight {
  dish: string;
  why: string;
}

export interface FoodAiRankedOutlet {
  outlet: string;
  rank: number;
  match_score: number;
  verdict: string;
  highlights: FoodAiHighlight[];
}

export interface FoodAiRecommendation {
  service_date: string;
  model: string;
  headline: string;
  top_outlet: string;
  ranked_outlets: FoodAiRankedOutlet[];
  tip: string;
  generated_at: number;
}

export interface AlertData {
  count: number;
  summary: string;
  key: string;
  dismissed: boolean;
  /** when the status source last reported, so an old all clear can be rendered as old */
  checked_at?: number | null;
  notices: { severity: string; title: string; body: string; components: string[]; incident_status: string; url: string }[];
}

// ---------------------------------------------------------------------------
// Health surface (/v1/health/sources)
// ---------------------------------------------------------------------------

export interface SourceHealth {
  id: string;
  role?: string;
  shape: string;
  cadence_ms: number;
  needs_secret: boolean;
  env_var: string | null;
  ready: boolean;
  blocked_by: string;
  last_run: {
    at: number;
    outcome: string;
    http_status: number | null;
    rows: number;
    bytes: number;
    error: string;
    meta?: Record<string, unknown>;
  } | null;
  age_s: number | null;
  job: { next_due_at: number; circuit: string; failures: number } | null;
}

export interface HealthResponse {
  now: number;
  sources: SourceHealth[];
  snapshots: number;
}
