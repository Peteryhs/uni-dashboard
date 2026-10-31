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
 * Deployed dashboards use the browser's same-origin Cloudflare Access cookie. A local relay may
 * additionally require a bearer token when RELAY_TOKEN is set; it is never put in a URL.
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
import { checkRelayResponse, localRelayToken, readRelayJson, RelayError } from './relay-response.mjs';
import type { McpToken, McpTokenList } from './mcp-tokens';
import { isOffline, setReachable } from './connectivity';
import { Commute, TransitStop } from '#contract/transit.mjs';
import type { CommuteDraft } from './transit';
import { savedRead, saveRead } from './offline-cache';
export { RelayError } from './relay-response.mjs';

const BUNDLE_CACHE_KEY = 'uni-dashboard:last-bundle:v1';
const CALENDAR_CACHE_KEY = 'uni-dashboard:last-calendar:v1';
const TOKEN_KEY = 'uni-dashboard:relay-token';
const RECOMMENDATIONS_CACHE_KEY = 'uni-dashboard:last-recommendations:v1';

export function getToken(): string {
  const origin = window.location.origin;
  try {
    return localRelayToken(localStorage.getItem(TOKEN_KEY) ?? '', origin);
  } catch {
    return '';
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

async function fetchRelay(path: string, options: RequestInit = {}): Promise<Response> {
  if (isOffline() && options.method && !['GET', 'HEAD'].includes(options.method)) throw new RelayError('You are offline. Changes require a connection.', 0);
  let res: Response;
  try { res = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...authHeaders(), ...options.headers },
  }); setReachable(true); }
  catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setReachable(false); throw error; }
  await checkRelayResponse(res, Boolean(getToken()));
  return res;
}

export async function fetchTransitStops(q: string, origin = '', signal?: AbortSignal) {
  const result = await getJson<{ stops: unknown[] }>(`/v1/transit/stops?${new URLSearchParams({ q, origin })}`, signal);
  return result.stops.map(stop => TransitStop.parse(stop));
}
export async function fetchCommutes(signal?: AbortSignal) {
  const result = await getJson<{ commutes: unknown[] }>('/v1/transit/commutes', signal);
  return result.commutes.map(commute => Commute.parse(commute));
}
export async function saveCommute(input: CommuteDraft, id?: string) {
  return readRelayJson(await fetchRelay(`/v1/transit/commutes${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
}
export async function deleteCommute(id: string) { return readRelayJson(await fetchRelay(`/v1/transit/commutes/${encodeURIComponent(id)}`, { method: 'DELETE' })); }
export async function activateCommute(id: string, section: number | null, group: number | null) {
  const query = new URLSearchParams(); if (section != null) query.set('section', String(section)); if (group != null) query.set('group', String(group));
  return readRelayJson(await fetchRelay(`/v1/transit/activation?${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commute_id: id }) }));
}
export async function cancelCommute() { return readRelayJson(await fetchRelay('/v1/transit/activation', { method: 'DELETE' })); }
export async function refreshTransit() { return readRelayJson(await fetchRelay('/v1/transit/refresh', { method: 'POST' })); }

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (isOffline()) { const saved = savedRead(path); if (saved !== undefined) return saved as T; }
  try {
  const res = await fetchRelay(path, {
    signal,
    headers: { accept: 'application/json', ...authHeaders() },
    cache: 'no-store',
  });
  const value = await readRelayJson(res); saveRead(path, value); return value as T;
  } catch (error) {
    if (isOffline() && !(error instanceof DOMException && error.name === 'AbortError')) { const saved = savedRead(path); if (saved !== undefined) return saved as T; }
    throw error;
  }
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

/** One dish from /v1/menu. `station` is the counter inside the outlet ("Hot Dish"); '' if unnamed. */
export interface MenuDish { outlet: string; station: string; dish: string; diet: string[]; allergens: string[]; url: string }

export interface PostedMenu {
  requested_date: string;
  service_date: string | null;
  status: 'today' | 'upcoming' | 'previous' | 'unavailable';
  observed_at?: number | null;
  valid_until?: number | null;
  cadence_ms?: number;
  state?: string;
  /** Every dish for the day, in page order (which is station order within an outlet). */
  items: MenuDish[];
}

export function fetchPostedMenu(date?: string, signal?: AbortSignal): Promise<PostedMenu> {
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  return getJson<PostedMenu>(`/v1/menu${query}`, signal);
}

export function fetchCurrentWeather(signal?: AbortSignal): Promise<{ temp_c: number | null; observed_at: number | null; state: string }> {
  return getJson('/v1/weather/current', signal);
}

export async function saveRecommendationAction(id: string, action: 'done' | 'undo' | 'snooze' | 'dismiss', until?: number): Promise<void> {
  const res = await fetchRelay('/v1/recommendations/actions', {
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
    if (cached.section !== section || cached.group !== group) return null;
    if (calendar.start === start) return calendar;
    if (calendar.days.some(day => day.date === start)) {
      const days = calendar.days.filter(day => day.date >= start);
      return { ...calendar, start, days, count: days.reduce((n, day) => n + day.events.length, 0) };
    }
    return null;
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

export interface PollResult {
  receipts: Array<{ source_id: string; outcome: string; error?: string }>;
  deferred?: string[];
  weather?: { status: string; cached?: boolean };
}

/** Ask the relay to poll now and report which sources completed. */
export async function triggerPoll(sourceId?: string): Promise<PollResult> {
  const qs = sourceId ? `?source=${encodeURIComponent(sourceId)}` : '';
  const res = await fetchRelay(`/v1/poll${qs}`, {
    method: 'POST',
    headers: { accept: 'application/json', ...authHeaders() },
  });
  return (await readRelayJson(res)) as PollResult;
}

export interface CredentialFeedInfo {
  configured: boolean;
  env_var: string;
  name: string;
  role: string;
  source?: string;
  feed_url_preview?: string;
}

export interface CredentialsStatus {
  portal: CredentialFeedInfo;
  google_calendar?: CredentialFeedInfo;
  learn: CredentialFeedInfo;
  cloudflare?: {
    configured: boolean;
    account_id: string;
    name: string;
    role: string;
    mode?: 'binding' | 'api';
  };
}

export async function fetchCredentialsStatus(signal?: AbortSignal): Promise<CredentialsStatus> {
  return getJson<CredentialsStatus>('/v1/credentials', signal);
}

export interface SetupStatus {
  data_empty: boolean;
  first_run: boolean;
  setup_needed: boolean;
  schedule_configured: boolean;
  learn_configured: boolean;
  schedule_synced: boolean;
  learn_synced: boolean;
}

export function fetchSetupStatus(signal?: AbortSignal): Promise<SetupStatus> {
  return getJson<SetupStatus>('/v1/setup', signal);
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
): Promise<{ ok: boolean; portal_configured: boolean; google_calendar_configured?: boolean; learn_configured: boolean; cloudflare_configured?: boolean }> {
  const res = await fetchRelay('/v1/credentials', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(creds),
  });
  return readRelayJson(res);
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
  const res = await fetchRelay(`/v1/ai/jobs?kind=${encodeURIComponent(kind)}&scope=${encodeURIComponent(scope)}`, {
    method: 'DELETE', headers: authHeaders(),
  });
  if (!res.ok) throw new RelayError(`could not clear AI draft: ${res.status}`, res.status);
}

export async function requestFoodRanking(date: string): Promise<AiJob<FoodAiRecommendation>> {
  const res = await fetchRelay('/v1/ai/rank-food', {
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
  const res = await fetchRelay('/v1/food/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(profile),
  });
  if (!res.ok) throw new RelayError(`failed to save taste profile: ${res.status}`, res.status);
}

export async function getFoodTasteProfile(): Promise<{ profile: (Record<string, unknown> & { dietaryFilter?: string }) | null }> {
  const res = await fetchRelay('/v1/food/profile', { headers: authHeaders() });
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
  return getJson(`/v1/food/recommendation?date=${encodeURIComponent(date)}`);
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
  const res = await fetchRelay('/v1/alerts/dismiss', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ key }) });
  if (!res.ok) throw new RelayError(`could not dismiss alert: ${res.status}`, res.status);
}

export async function previewCourseImport(text: string): Promise<CourseResource[]> {
  const res = await fetchRelay('/v1/courses/import', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new RelayError(`could not read course links: ${res.status}`, res.status);
  return (await res.json()).resources;
}

export async function saveCourseResources(course: string, resources: CourseResource[]): Promise<CourseResource[]> {
  const res = await fetchRelay(`/v1/courses/${encodeURIComponent(course)}/resources`, { method: 'PUT', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ resources }) });
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
  const res = await fetchRelay(`/v1/courses/${encodeURIComponent(course)}/syllabus/preview`, {
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
  const res = await fetchRelay(`/v1/courses/${encodeURIComponent(course)}/syllabus`, {
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
  const res = await fetchRelay('/v1/ai/parse-office-hours', {
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
  const res = await fetchRelay('/v1/office-hours', {
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

// ---------------------------------------------------------------------------
// MCP API keys. The owner-only routes return the plaintext exactly once, on create.
// ---------------------------------------------------------------------------

export interface CreatedMcpToken extends McpToken {
  token: string;
  warning?: string;
}

export function fetchMcpTokens(signal?: AbortSignal): Promise<McpTokenList> {
  return getJson<McpTokenList>('/v1/mcp-tokens', signal);
}

export async function createMcpToken(input: { name: string; expiresInDays: number | null }): Promise<CreatedMcpToken> {
  const res = await fetchRelay('/v1/mcp-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: input.name, expires_in_days: input.expiresInDays }),
  });
  return readRelayJson(res);
}

export async function revokeMcpToken(id: string): Promise<void> {
  const res = await fetchRelay(`/v1/mcp-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await readRelayJson(res);
}
