/**
 * Relay client.
 *
 * Two things here are load-bearing rather than incidental:
 *
 * 1. The last good bundle is persisted to localStorage on every success. With the relay stopped the
 *    client still renders real data with the age ladder showing its true age, and never a spinner.
 *    A dashboard that goes blank when the network does is worse than one that admits it is old.
 * 2. The bundle is validated against the server's own schema on arrival. The project has already
 *    shipped a bug where epoch milliseconds arrived as the string "1789997400000.0"; validating at
 *    this boundary turns that class of bug into a visible error instead of a wrong-looking card.
 *
 * Auth is a bearer token in a header, never a query parameter, so it cannot land in a log or a
 * Referer. The token is optional: the relay only demands one when RELAY_TOKEN is set.
 */
import {
  validateBundle,
  type Bundle,
  type HealthResponse,
  type FoodAiRecommendation,
  type OfficeHoursConfig,
  type ParseOfficeHoursResponse,
  validateCalendar,
  type CalendarData,
  type CourseResource,
  type CourseSyllabus,
  type CourseSyllabusPreview,
  type CourseSyllabusPreviewRequest,
  validateRecommendations,
  type RecommendationResponse,
} from './contract';

const BUNDLE_CACHE_KEY = 'uni-dashboard:last-bundle:v1';
const CALENDAR_CACHE_KEY = 'uni-dashboard:last-calendar:v1';
const TOKEN_KEY = 'uni-dashboard:relay-token';
const RECOMMENDATIONS_CACHE_KEY = 'uni-dashboard:last-recommendations:v1';

/** Build-time default, overridable at runtime so a device can be paired without a rebuild. */
const BUILD_TOKEN = (import.meta.env.VITE_RELAY_TOKEN as string | undefined) ?? '';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? BUILD_TOKEN;
  } catch {
    return BUILD_TOKEN;
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the token simply does not persist */
  }
}

function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    signal,
    headers: { accept: 'application/json', ...authHeaders() },
    cache: 'no-store',
  });
  if (res.status === 401) {
    throw new RelayError('relay rejected the device token', 401);
  }
  if (!res.ok) {
    throw new RelayError(`relay returned ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Last good bundle, so offline is a state and not a blank screen.
// ---------------------------------------------------------------------------

export interface CachedBundle {
  bundle: Bundle;
  /** When this client received it. Distinct from the card's own observed_at. */
  received_at: number;
}

export function readCachedBundle(): CachedBundle | null {
  try {
    const raw = localStorage.getItem(BUNDLE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedBundle;
    // Validate on the way out too. A cache written by an older, buggier build must not be trusted
    // just because it is local.
    return { bundle: validateBundle(parsed.bundle), received_at: parsed.received_at };
  } catch {
    return null;
  }
}

function writeCachedBundle(bundle: Bundle): void {
  try {
    localStorage.setItem(
      BUNDLE_CACHE_KEY,
      JSON.stringify({ bundle, received_at: Date.now() } satisfies CachedBundle),
    );
  } catch {
    /* quota or private mode: caching is an optimisation, not a requirement */
  }
}

export async function fetchBundle(signal?: AbortSignal): Promise<Bundle> {
  const raw = await getJson<unknown>('/v1/dashboard', signal);
  const bundle = validateBundle(raw);
  writeCachedBundle(bundle);
  return bundle;
}

function recommendationsCacheKey(section: number | null, group: number | null): string {
  return `${RECOMMENDATIONS_CACHE_KEY}:${section ?? 'all'}:${group ?? 'all'}`;
}

export function readCachedRecommendations(section: number | null = null, group: number | null = null): RecommendationResponse | undefined {
  try {
    const raw = localStorage.getItem(recommendationsCacheKey(section, group));
    return raw ? validateRecommendations(JSON.parse(raw)) : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchRecommendations(section: number | null = null, group: number | null = null, signal?: AbortSignal): Promise<RecommendationResponse> {
  const params = new URLSearchParams();
  if (section !== null) params.set('section', String(section));
  if (group !== null) params.set('group', String(group));
  const response = validateRecommendations(await getJson<unknown>(`/v1/recommendations${params.size ? `?${params}` : ''}`, signal));
  try { localStorage.setItem(recommendationsCacheKey(section, group), JSON.stringify(response)); } catch { /* storage is optional */ }
  return response;
}

export interface PostedMenu {
  requested_date: string;
  service_date: string | null;
  status: 'today' | 'previous' | 'unavailable';
  items: { outlet: string; station: string; dish: string; diet: string[]; allergens: string[]; url: string }[];
}

export function fetchPostedMenu(signal?: AbortSignal): Promise<PostedMenu> {
  return getJson<PostedMenu>('/v1/menu', signal);
}

export function fetchCurrentWeather(signal?: AbortSignal): Promise<{ temp_c: number | null; observed_at: number | null; state: string }> {
  return getJson('/v1/weather/current', signal);
}

export async function saveRecommendationAction(id: string, action: 'done' | 'undo' | 'snooze', until?: number): Promise<void> {
  const res = await fetch('/v1/recommendations/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ id, action, ...(until ? { until } : {}) }),
  });
  if (!res.ok) throw new RelayError(`Could not update recommendation (${res.status})`, res.status);
}

export async function fetchCalendar(start: string, days = 7, section: number | null = null, group: number | null = null, signal?: AbortSignal): Promise<CalendarData> {
  const params = new URLSearchParams({ start, days: String(days) });
  if (section !== null) params.set('section', String(section));
  if (group !== null) params.set('group', String(group));
  const calendar = validateCalendar(await getJson<unknown>(`/v1/calendar?${params}`, signal));
  try {
    localStorage.setItem(CALENDAR_CACHE_KEY, JSON.stringify({ calendar, section, group }));
  } catch {
    // Calendar remains usable when storage is unavailable.
  }
  return calendar;
}

export function readCachedCalendar(start: string, section: number | null, group: number | null): CalendarData | null {
  try {
    const raw = localStorage.getItem(CALENDAR_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { calendar: unknown; section: number | null; group: number | null };
    const calendar = validateCalendar(cached.calendar);
    return calendar.start === start && cached.section === section && cached.group === group ? calendar : null;
  } catch {
    return null;
  }
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return getJson<HealthResponse>('/v1/health/sources', signal);
}

export interface HealthzResponse {
  ok: boolean;
  uptime_s: number;
}

export async function fetchHealthz(signal?: AbortSignal): Promise<HealthzResponse> {
  return getJson<HealthzResponse>('/healthz', signal);
}

/** Ask the relay to poll now. Used by the manual refresh control. */
export async function triggerPoll(sourceId?: string): Promise<void> {
  const qs = sourceId ? `?source=${encodeURIComponent(sourceId)}` : '';
  const res = await fetch(`/v1/poll${qs}`, {
    method: 'POST',
    headers: { accept: 'application/json', ...authHeaders() },
  });
  if (!res.ok) throw new RelayError(`poll failed with ${res.status}`, res.status);
}

export interface CredentialFeedInfo {
  configured: boolean;
  env_var: string;
  name: string;
  role: string;
  feed_url_preview?: string;
}

export interface CredentialsStatus {
  portal: CredentialFeedInfo;
  learn: CredentialFeedInfo;
  cloudflare?: {
    configured: boolean;
    account_id: string;
    name: string;
    role: string;
  };
}

export async function fetchCredentialsStatus(signal?: AbortSignal): Promise<CredentialsStatus> {
  return getJson<CredentialsStatus>('/v1/credentials', signal);
}

export async function updateCredentials(
  creds: {
    PORTAL_ICS_URL?: string;
    GOOGLE_CALENDAR_ICS_URL?: string;
    LEARN_ICS_URL?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_API_TOKEN?: string;
  },
  signal?: AbortSignal,
): Promise<{ ok: boolean; portal_configured: boolean; learn_configured: boolean; cloudflare_configured?: boolean }> {
  const res = await fetch('/v1/credentials', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new RelayError(`failed to update credentials: ${res.status}`, res.status);
  return res.json();
}

export interface AiJob<Result> {
  id?: string;
  kind?: 'food' | 'office_hours' | 'syllabus';
  scope?: string;
  status: 'idle' | 'processing' | 'ready' | 'failed';
  created_at?: number;
  updated_at?: number;
  result?: Result;
  error?: string;
}

export async function fetchAiJob<Result>(kind: 'office_hours' | 'syllabus', scope: string): Promise<AiJob<Result>> {
  return getJson<AiJob<Result>>(`/v1/ai/jobs?kind=${encodeURIComponent(kind)}&scope=${encodeURIComponent(scope)}`);
}

export async function clearAiJob(kind: 'office_hours' | 'syllabus', scope: string): Promise<void> {
  const res = await fetch(`/v1/ai/jobs?kind=${encodeURIComponent(kind)}&scope=${encodeURIComponent(scope)}`, {
    method: 'DELETE', headers: authHeaders(),
  });
  if (!res.ok) throw new RelayError(`could not clear AI draft: ${res.status}`, res.status);
}

export async function requestFoodRanking(date: string): Promise<AiJob<FoodAiRecommendation>> {
  const res = await fetch('/v1/ai/rank-food', {
    method: 'POST',
    keepalive: true,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ date }),
  });
  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    throw new RelayError(errJson.error || `AI ranking failed with ${res.status}`, res.status);
  }
  return res.json() as Promise<AiJob<FoodAiRecommendation>>;
}

export async function saveFoodTasteProfile(profile: unknown): Promise<void> {
  const res = await fetch('/v1/food/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(profile),
  });
  if (!res.ok) throw new RelayError(`failed to save taste profile: ${res.status}`, res.status);
}

export async function getFoodTasteProfile(): Promise<{ profile: (Record<string, unknown> & { dietaryFilter?: string }) | null }> {
  const res = await fetch('/v1/food/profile', { headers: authHeaders() });
  if (!res.ok) throw new RelayError(`failed to load taste profile: ${res.status}`, res.status);
  return res.json();
}

export async function fetchFoodRecommendation(date: string): Promise<{
  status: string;
  recommendation: FoodAiRecommendation | null;
  ranking_job?: AiJob<FoodAiRecommendation>;
  stale?: boolean;
  limit_reason?: string;
  error?: string;
}> {
  const res = await fetch(`/v1/food/recommendation?date=${encodeURIComponent(date)}`, { headers: authHeaders() });
  if (!res.ok) throw new RelayError(`failed to load AI ranking: ${res.status}`, res.status);
  return res.json();
}

export interface AiUsageStatus {
  day: string;
  budget_neurons: number;
  reserved_neurons: number;
  remaining_neurons: number;
  calls: number;
  resets_at: number;
  accounting: string;
}

export function fetchAiUsage(signal?: AbortSignal): Promise<AiUsageStatus> {
  return getJson<AiUsageStatus>('/v1/ai/usage', signal);
}

export async function dismissAlert(key: string): Promise<void> {
  const res = await fetch('/v1/alerts/dismiss', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ key }) });
  if (!res.ok) throw new RelayError(`could not dismiss alert: ${res.status}`, res.status);
}

export async function previewCourseImport(text: string): Promise<CourseResource[]> {
  const res = await fetch('/v1/courses/import', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new RelayError(`could not read course links: ${res.status}`, res.status);
  return (await res.json()).resources;
}

export async function saveCourseResources(course: string, resources: CourseResource[]): Promise<CourseResource[]> {
  const res = await fetch(`/v1/courses/${encodeURIComponent(course)}/resources`, { method: 'PUT', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ resources }) });
  if (!res.ok) throw new RelayError(`could not save course links: ${res.status}`, res.status);
  return (await res.json()).resources;
}

export async function fetchCourseSyllabus(course: string, signal?: AbortSignal): Promise<CourseSyllabus | null> {
  const response = await getJson<{ syllabus: CourseSyllabus | null }>(`/v1/courses/${encodeURIComponent(course)}/syllabus`, signal);
  return response.syllabus;
}

export async function previewCourseSyllabus(
  course: string,
  input: CourseSyllabusPreviewRequest,
  signal?: AbortSignal,
): Promise<CourseSyllabusPreview | AiJob<CourseSyllabusPreview>> {
  const body = JSON.stringify(input);
  const res = await fetch(`/v1/courses/${encodeURIComponent(course)}/syllabus/preview`, {
    method: 'POST',
    signal: input.use_ai ? undefined : signal,
    keepalive: input.use_ai === true && body.length <= 60_000,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders() },
    body,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({})) as { error?: string };
    throw new RelayError(payload.error || `could not preview syllabus: ${res.status}`, res.status);
  }
  return res.json() as Promise<CourseSyllabusPreview | AiJob<CourseSyllabusPreview>>;
}

export async function saveCourseSyllabus(course: string, syllabus: CourseSyllabus): Promise<CourseSyllabus> {
  const res = await fetch(`/v1/courses/${encodeURIComponent(course)}/syllabus`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders() },
    body: JSON.stringify(syllabus),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({})) as { error?: string };
    throw new RelayError(payload.error || `could not save syllabus: ${res.status}`, res.status);
  }
  const response = await res.json() as { syllabus: CourseSyllabus };
  return response.syllabus;
}

export interface AiModelInfo {
  id: string;
  name: string;
  tag?: string;
}

export interface AiModelsResponse {
  default_model: string;
  models: AiModelInfo[];
}

export async function fetchAiModels(signal?: AbortSignal): Promise<AiModelsResponse> {
  return getJson<AiModelsResponse>('/v1/ai/models', signal);
}

export async function parseOfficeHours(
  text: string,
  opts: { course?: string; model?: string; force?: boolean } = {},
): Promise<AiJob<ParseOfficeHoursResponse>> {
  const body = JSON.stringify({ text, ...opts });
  const res = await fetch('/v1/ai/parse-office-hours', {
    method: 'POST',
    keepalive: body.length <= 60_000,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...authHeaders(),
    },
    body,
  });
  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    const message = errJson.error || `Parsing failed with status ${res.status}`;
    const err = new RelayError(message, res.status);
    if (errJson.raw) {
      (err as any).raw = errJson.raw;
    }
    throw err;
  }
  return res.json() as Promise<AiJob<ParseOfficeHoursResponse>>;
}

export async function getOfficeHours(signal?: AbortSignal): Promise<OfficeHoursConfig> {
  return getJson<OfficeHoursConfig>('/v1/office-hours', signal);
}

export async function putOfficeHours(
  config: OfficeHoursConfig,
  signal?: AbortSignal,
): Promise<{ config: OfficeHoursConfig; rows_written: number }> {
  const res = await fetch('/v1/office-hours', {
    method: 'PUT',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    throw new RelayError(errJson.error || `Saving office hours failed with status ${res.status}`, res.status);
  }
  return res.json() as Promise<{ config: OfficeHoursConfig; rows_written: number }>;
}
