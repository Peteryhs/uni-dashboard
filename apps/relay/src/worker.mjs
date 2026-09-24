/**
 * Cloudflare Worker entrypoint: one deployable that both polls (cron) and serves (fetch),
 * which is what apps/relay/src/server.mjs mirrors locally.
 *
 * Everything below the routing layer is the same code the Node relay runs: the source adapters,
 * the runner, the card builders and the contract schemas. Only the three platform pieces differ:
 *   - storage:        D1Store instead of SqliteStore (same interface)
 *   - scheduling:     scheduled() instead of setInterval + pollDue()
 *   - static assets:  the ASSETS binding instead of a node:fs reader
 *
 * Secrets: Worker secrets land in env, and the source adapters read process.env, so bindings are
 * bridged onto process.env once per request. Nothing else in the tree has to know where it runs.
 */
import { D1Store } from './d1-store.mjs';
import { RUN_RETENTION_MS } from './schema.mjs';
import { runSource } from './runner.mjs';
import { SOURCES, enabledSources, readiness, sourceById } from '#sources/registry.mjs';
import { todayInToronto } from '#sources/food/source.mjs';
import { buildDashboard } from './cards.mjs';
import { buildCalendar, calendarOptions } from './calendar.mjs';
import { rankDailyMenu, DEFAULT_AI_MODEL, POPULAR_MODELS, parseOfficeHoursWithAi } from './ai.mjs';
import { OfficeHoursConfig } from '#contract/office-hours.mjs';
import { buildPreviewOccurrences } from '#sources/office-hours/source.mjs';
import { claimFoodAiRun, cleanFoodProfile, getFoodProfile, getFoodRecommendation, persistManualFoodRecommendation, saveFoodProfile, syncFoodRecommendation } from './food-recommendation.mjs';
import { previewCourseImport, saveCourseResources } from './course-library.mjs';
import { dismissAlert, syncAlertSummary } from './alert-summary.mjs';
import { aiBudgetGuard } from './ai-budget.mjs';
import { syncWeather } from './weather-cache.mjs';
import { isGuidanceRoute, handleGuidanceRoute, readGuidanceJson } from './guidance-api.mjs';

const STARTED_AT = Date.now();

/** Config keys the sources and the AI proxy read from the environment. */
const ENV_KEYS = [
  'PORTAL_ICS_URL',
  'GOOGLE_CALENDAR_ICS_URL',
  'LEARN_ICS_URL',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'RELAY_TOKEN',
];

/**
 * Keys the app is allowed to write, with the shape each one has to match.
 *
 * Validation lives here rather than in the UI because this is the boundary that matters: the value
 * ends up in an environment variable that the adapters read, so anything with whitespace in it could
 * smuggle a second variable, and anything that is not https is not a feed.
 */
const WRITABLE_SETTINGS = {
  PORTAL_ICS_URL: (v) => /^https:\/\/\S+$/.test(v),
  GOOGLE_CALENDAR_ICS_URL: (v) => /^https:\/\/\S+$/.test(v),
  LEARN_ICS_URL: (v) => /^https:\/\/\S+$/.test(v),
  CLOUDFLARE_ACCOUNT_ID: (v) => /^[a-zA-Z0-9_-]+$/.test(v),
  CLOUDFLARE_API_TOKEN: (v) => /^[a-zA-Z0-9_-]+$/.test(v),
  RELAY_TOKEN: (v) => /^[a-zA-Z0-9_-]+$/.test(v),
  OFFICE_HOURS_JSON: (v) => {
    try {
      const parsed = JSON.parse(v);
      return OfficeHoursConfig.safeParse(parsed).success;
    } catch {
      return false;
    }
  },
};

const SETTING_KEYS = Object.keys(WRITABLE_SETTINGS);

/**
 * Apply the settings saved from the app onto process.env, which is where the source adapters read
 * their configuration. Returns which keys came from the database, so the credentials route can say
 * where a value it is reporting actually lives.
 */
async function applySettings(store) {
  const rows = await store.settings();
  const fromDb = [];
  for (const row of rows) {
    if (!SETTING_KEYS.includes(row.name) || !row.value) continue;
    if (row.name === 'OFFICE_HOURS_JSON') continue;
    process.env[row.name] = row.value;
    fromDb.push(row.name);
  }
  return fromDb;
}

/**
 * Bridge Worker bindings onto process.env so the source adapters, which read process.env because
 * they also run under Node, work unchanged. A Worker has one isolate per request, so this cannot
 * leak across requests.
 */
function bridgeEnv(env) {
  for (const key of ENV_KEYS) {
    const value = env?.[key];
    if (typeof value === 'string' && value) process.env[key] = value;
    else delete process.env[key];
  }
}

function storeFor(env) {
  return new D1Store(env.DB);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function scheduleFor(source) {
  const url = typeof source.url === 'function' ? source.url() : source.url;
  return !source.needsSecret || Boolean(url);
}

/**
 * Sources polled per invocation. Workers Free allows 50 D1 queries per invocation, and a full poll
 * of all four sources measures 41 on its own, so a tick takes two and leaves the rest due. The cron
  * runs every minute, which is far more often than the slowest cadence (food, 12 hours), so
 * nothing waits long.
 */
const MAX_SOURCES_PER_TICK = 2;

/**
 * Run every source whose job is due, exactly like the local pollDue() loop:
 * fetch, validate, write, tombstone, record the receipt, then reschedule with backoff.
 *
 * `cap` is the D1 query budget guard described above. Sources left over stay due, and the caller is
 * told which ones were deferred rather than being left to guess.
 */
export async function pollDue(store, now = Date.now(), cap = MAX_SOURCES_PER_TICK, sources = SOURCES) {
  const receipts = [];
  const jobs = await store.jobs();
  const ready = jobs.filter((job) => job.next_due_at <= now).sort((a, b) => a.next_due_at - b.next_due_at)
    .map((j) => sourceById(j.source_id, sources))
    .filter(Boolean)
    .filter(scheduleFor);
  const due = ready.slice(0, cap);
  const deferred = ready.slice(cap).map((s) => s.id);

  for (const source of due) {
    const startedAt = Date.now();
    const receipt = await runSource(source, store, { now: startedAt });
    receipts.push(receipt);
    await store.recordJobResult(source.id, {
      startedAt,
      finishedAt: receipt.finished_at,
      outcome: receipt.outcome,
      httpStatus: receipt.http_status,
      cadenceMs: source.cadenceMs,
      now: Date.now(),
    });
  }

  // Sources that have never run get scheduled on the first pass, so a fresh D1 fills itself.
  for (const source of enabledSources(sources)) {
    if (!jobs.find((j) => j.source_id === source.id)) {
      await store.scheduleJob(source.id, scheduleFor(source) ? Date.now() : Date.now() + 6 * 60 * 60 * 1000);
    }
  }

  // The receipt log is an audit trail, not a history: prune it every cycle so the
  // latest-run-per-source query cannot become a full scan of a table that only grows.
  const pruned = await store.pruneRuns(now - RUN_RETENTION_MS);
  const prunedSnapshots = await store.pruneSnapshots(now - RUN_RETENTION_MS);

  return { receipts, deferred, pruned, prunedSnapshots };
}

async function handleFetch(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/healthz') return json({ ok: true, uptime_s: Math.round((Date.now() - STARTED_AT) / 1000) });

  /**
   * The token gates the data, not the shell: a browser cannot put an Authorization header on the
   * initial document request, so index.html stays public and every /v1 route below stays closed.
   */
  if (!path.startsWith('/v1/')) {
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: 'not found', routes: ['/healthz', '/v1/dashboard', '/v1/calendar', '/v1/health/sources', '/v1/credentials', '/v1/poll?source=<id> (POST)', '/v1/snapshot/<sha>'] }, 404);
  }

  const store = storeFor(env);
  await store.init();

  /**
   * Settings the owner saved from the app are applied before the token check, because RELAY_TOKEN
   * can be one of them: a token set in the UI has to be able to gate the very next request. A value
   * saved from the app wins over a Worker secret, because it is the more recent explicit choice.
   */
  const saved = await applySettings(store);

  const token = process.env.RELAY_TOKEN || env.RELAY_TOKEN || '';
  if (token && request.headers.get('authorization') !== `Bearer ${token}`) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (isGuidanceRoute(path)) {
    const result = await handleGuidanceRoute({ url, method: request.method, readBody: () => readGuidanceJson(request.body), store, cfEnv: env });
    return json(result.body, result.status);
  }

  if (path === '/v1/dashboard') {
    return json(await buildDashboard(store, { now: Date.now() }));
  }

  if (path === '/v1/alerts/dismiss' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
    return (await dismissAlert(store, body?.key)) ? json({ ok: true }) : json({ error: 'alert has changed; refresh the dashboard' }, 409);
  }

  if (path === '/v1/calendar' && request.method === 'GET') {
    const now = Date.now();
    try {
      return json(await buildCalendar(store, { ...calendarOptions(url.searchParams, now), now }));
    } catch (error) {
      if (error instanceof RangeError) return json({ error: error.message }, 400);
      throw error;
    }
  }

  if (path === '/v1/food/recommendation' && request.method === 'GET') {
    return json(await getFoodRecommendation(store, url.searchParams.get('date') || ''));
  }
  if (path === '/v1/food/profile' && request.method === 'GET') return json({ profile: await getFoodProfile(store) });
  if (path === '/v1/food/profile' && request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
    return json({ profile: await saveFoodProfile(store, body) });
  }
  if (path === '/v1/courses/import' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
    if (typeof body?.text !== 'string' || body.text.length > 100_000) return json({ error: 'text must be at most 100 KB' }, 400);
    return json({ resources: previewCourseImport(body.text) });
  }
  const courseResourceMatch = /^\/v1\/courses\/([^/]+)\/resources$/.exec(path);
  if (courseResourceMatch && request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
    try { return json({ resources: await saveCourseResources(store, decodeURIComponent(courseResourceMatch[1]), body.resources) }); }
    catch (error) { if (error instanceof RangeError || error instanceof URIError) return json({ error: error.message }, 400); throw error; }
  }

  if (path === '/v1/health/sources') {
    const [last, jobs, snapshots] = [await store.lastRunPerSource(), await store.jobs(), await store.snapshotCount()];
    return json({
      now: Date.now(),
      sources: readiness(SOURCES).map((r) => {
        const run = last.find((l) => l.source_id === r.id);
        const job = jobs.find((j) => j.source_id === r.id);
        return {
          ...r,
          last_run: run
            ? { at: run.finished_at, outcome: run.outcome, http_status: run.http_status, rows: run.rows_written, bytes: run.bytes, error: run.error, meta: run.meta }
            : null,
          age_s: run ? Math.round((Date.now() - run.finished_at) / 1000) : null,
          job: job ? { next_due_at: job.next_due_at, circuit: job.circuit_state, failures: job.consecutive_failures } : null,
        };
      }),
      snapshots,
    });
  }

  if (path.startsWith('/v1/snapshot/')) {
    const sha = path.split('/').pop();
    if (!/^[a-f0-9]{64}$/.test(sha || '')) return json({ error: 'invalid snapshot id' }, 400);
    const snap = await store.getSnapshot(sha);
    if (!snap) return json({ error: 'no such snapshot' }, 404);
    return new Response(snap.body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="snapshot-${sha}.txt"`, 'x-content-type-options': 'nosniff' } });
  }

  if (path === '/v1/poll' && request.method === 'POST') {
    const id = url.searchParams.get('source');
    if (id) {
      const source = sourceById(id, SOURCES);
      if (!source) return json({ error: `unknown source ${id}` }, 404);
      const receipt = await runSource(source, store, { now: Date.now() });
      await store.recordJobResult(source.id, {
        startedAt: receipt.started_at,
        finishedAt: receipt.finished_at,
        outcome: receipt.outcome,
        httpStatus: receipt.http_status,
        cadenceMs: source.cadenceMs,
        now: Date.now(),
      });
      return json({ receipts: [receipt], deferred: [] });
    }
    // A manual poll obeys the same query budget as the cron, because the cap is a platform limit
    // (50 D1 queries per invocation on Free) and not a property of the scheduled path. Poll one
    // source at a time with ?source=<id> when everything needs to run right now.
    const { receipts, deferred, pruned } = await pollDue(store, Date.now());
    // A two-source poll can nearly exhaust D1's per-invocation query budget. The next minute
    // normally has only status due, so perform the AI cache check on that lighter tick.
    return json({ receipts, deferred, pruned });
  }

  if (path === '/v1/ai/models' && request.method === 'GET') {
    return json({ default_model: DEFAULT_AI_MODEL, models: POPULAR_MODELS });
  }

  if (path === '/v1/ai/rank-food' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid json' }, 400);
    }
    const tasteProfile = body.tasteProfile || {};
    const model = body.model || cleanFoodProfile(tasteProfile).selectedAiModel || DEFAULT_AI_MODEL;
    const now = Date.now();
    const requestedDate = body.date || todayInToronto(now);
    const serviceDate = requestedDate;

    let menuRows = await store.rows('menu_item', { where: 'service_date = ?', params: [serviceDate], limit: 500 });
    if (!menuRows.length) {
      const recent = await store.rows('menu_item', { limit: 100 });
      if (recent.length > 0) {
        menuRows = await store.rows('menu_item', { where: 'service_date = ?', params: [recent[0].service_date], limit: 500 });
      }
    }
    if (!menuRows.length) {
      return json({ error: 'No dining menu items available to evaluate for this date.' }, 404);
    }
    if (!await claimFoodAiRun(store, now)) return json({ error: 'Daily manual dining ranking cap reached; try again after UTC midnight.' }, 429);
    try {
      const recommendation = await rankDailyMenu({
        menuItems: menuRows,
        serviceDate: menuRows[0]?.service_date || serviceDate,
        tasteProfile,
        model,
        force: Boolean(body.force),
        now,
        cfEnv: env, // native env.AI binding: no API key, no REST round trip
        beforeAiCall: aiBudgetGuard(store),
      });
      await persistManualFoodRecommendation(store, {
        recommendation,
        tasteProfile,
        model,
        requestedDate,
        serviceDate: menuRows[0]?.service_date || serviceDate,
        menuItems: menuRows,
        startedAt: now,
      });
      return json(recommendation);
    } catch (err) {
      return json({ error: err.message }, err.status || 502);
    }
  }

  if (path === '/v1/ai/parse-office-hours' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid json' }, 400);
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return json({ error: 'Office hours text cannot be empty' }, 400);
    }
    const course = typeof body.course === 'string' ? body.course.trim() : '';
    const model = body.model || DEFAULT_AI_MODEL;
    const force = Boolean(body.force);
    const now = Date.now();

    try {
      const draft = await parseOfficeHoursWithAi({
        text,
        course,
        model,
        force,
        now,
        cfEnv: env,
        beforeAiCall: aiBudgetGuard(store),
      });
      const preview = buildPreviewOccurrences(draft.rules, { now, count: 6 });
      return json({ draft, preview, model });
    } catch (err) {
      const status = err.status || 502;
      const payload = { error: err.message };
      if (err.raw) payload.raw = err.raw;
      return json(payload, status);
    }
  }

  if (path === '/v1/office-hours' && request.method === 'GET') {
    const raw = await store.getSetting('OFFICE_HOURS_JSON');
    if (!raw) {
      return json({ rules: [], version: 1 });
    }
    try {
      const config = JSON.parse(raw);
      const parsed = OfficeHoursConfig.safeParse(config);
      return json(parsed.success ? parsed.data : { rules: [], version: 1 });
    } catch {
      return json({ rules: [], version: 1 });
    }
  }

  if (path === '/v1/office-hours' && request.method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid json' }, 400);
    }
    const now = Date.now();
    if (body && Array.isArray(body.rules)) {
      body.rules = body.rules.map((r) => ({
        ...r,
        id: r.id || crypto.randomUUID().slice(0, 10),
        created_at: r.created_at || now,
        updated_at: now,
      }));
    }
    const parsed = OfficeHoursConfig.safeParse(body);
    if (!parsed.success) {
      return json({ error: 'Validation failed', details: parsed.error.issues }, 400);
    }
    const config = parsed.data;
    await store.setSetting('OFFICE_HOURS_JSON', JSON.stringify(config), now);

    const source = sourceById('user-office-hours', SOURCES);
    let rowsWritten = 0;
    if (source) {
      const receipt = await runSource(source, store, { now });
      rowsWritten = receipt.rows_written;
    }
    return json({ config, rows_written: rowsWritten });
  }

  /**
   * Credentials, writable from the app.
   *
   * Values are stored as rows in D1 and applied to the environment on every request, so the app can
   * be configured without the dashboard. Two rules keep this honest: a value is validated before it
   * is stored (it ends up in an environment variable), and a value is never echoed back, only
   * whether it is configured and where it came from. A Worker secret still works and is what the
   * app reports when nothing was saved here.
   */
  if (path === '/v1/credentials') {
    const scheduleUrl = process.env.GOOGLE_CALENDAR_ICS_URL || process.env.PORTAL_ICS_URL || '';
    if (request.method === 'GET') {
      return json({
        portal: {
          configured: Boolean(scheduleUrl),
          env_var: process.env.GOOGLE_CALENDAR_ICS_URL ? 'GOOGLE_CALENDAR_ICS_URL' : 'PORTAL_ICS_URL',
          source: saved.includes('GOOGLE_CALENDAR_ICS_URL') || saved.includes('PORTAL_ICS_URL') ? 'saved in the app' : scheduleUrl ? 'Worker secret' : 'not set',
          name: 'Schedule Feed (Google Calendar or UW Portal)',
          role: 'Class timetable, personal events and exams',
        },
        learn: {
          configured: Boolean(process.env.LEARN_ICS_URL),
          env_var: 'LEARN_ICS_URL',
          source: saved.includes('LEARN_ICS_URL') ? 'saved in the app' : process.env.LEARN_ICS_URL ? 'Worker secret' : 'not set',
          name: 'Waterloo LEARN Deadlines Feed',
          role: 'Upcoming assignments, quizzes, homework and project due dates',
        },
        cloudflare: {
          configured: Boolean(env.AI || (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN)),
          account_id: env.AI ? 'native Workers AI binding' : '',
          name: 'Cloudflare Workers AI',
          role: 'Daily menu ranking and dish highlights (bound, no key needed)',
        },
        relay_token: {
          configured: Boolean(process.env.RELAY_TOKEN || env.RELAY_TOKEN),
          source: saved.includes('RELAY_TOKEN') ? 'saved in the app' : process.env.RELAY_TOKEN || env.RELAY_TOKEN ? 'Worker secret' : 'not set',
          role: 'Bearer token that gates every /v1 route',
        },
        writable: true,
        storage: 'd1',
      });
    }

    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }

      const stored = [];
      for (const [name, value] of Object.entries(body)) {
        if (!SETTING_KEYS.includes(name)) continue;
        if (typeof value !== 'string') return json({ error: `${name} must be a string` }, 400);
        const trimmed = value.trim();
        if (!trimmed) {
          await store.deleteSetting(name); // an empty value clears it, same as the local .env path
          delete process.env[name];
          stored.push({ name, cleared: true });
          continue;
        }
        if (!WRITABLE_SETTINGS[name](trimmed)) {
          return json(
            { error: name === 'PORTAL_ICS_URL' || name === 'GOOGLE_CALENDAR_ICS_URL' || name === 'LEARN_ICS_URL' ? `${name} must be an https URL with no whitespace` : `${name} must contain only letters, numbers, underscores and hyphens` },
            400,
          );
        }
        await store.setSetting(name, trimmed, Date.now());
        if (name !== 'OFFICE_HOURS_JSON') {
          process.env[name] = trimmed;
        }
        stored.push({ name, cleared: false });
      }

      // A new feed URL should show up now, not on the next cron tick.
      const changed = stored.some((s) => !s.cleared);
      let polled = [];
      if (changed) {
        const { receipts } = await pollDue(store, Date.now(), 1);
        polled = receipts.map((r) => `${r.source_id}:${r.outcome}`);
      }

      return json({
        ok: true,
        stored,
        polled,
        portal_configured: Boolean(process.env.PORTAL_ICS_URL || process.env.GOOGLE_CALENDAR_ICS_URL),
        learn_configured: Boolean(process.env.LEARN_ICS_URL),
      });
    }

    return json({ error: `method ${request.method} not allowed` }, 405);
  }

  return json(
    {
      error: 'not found',
      routes: ['/healthz', '/v1/dashboard', '/v1/calendar', '/v1/health/sources', '/v1/credentials', '/v1/poll?source=<id> (POST)', '/v1/snapshot/<sha>'],
    },
    404,
  );
}

export default {
  async fetch(request, env, ctx) {
    bridgeEnv(env);
    try {
      return await handleFetch(request, env);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },

  /**
   * Cron trigger. Runs the due jobs and reschedules them; the job table carries the cadence and the
   * backoff, so the cron interval only sets how often the table is consulted.
   */
  async scheduled(event, env, ctx) {
    bridgeEnv(env);
    const store = storeFor(env);
    await store.init();
    // settings saved from the app first: the cron polls the feeds the app was configured with
    await applySettings(store);
    const { receipts, deferred, pruned } = await pollDue(store, Date.now());
    // Keep the expensive AI cache check on a lighter tick to preserve the D1 query budget.
    const alerts = receipts.length < MAX_SOURCES_PER_TICK
      ? await syncAlertSummary(store, { cfEnv: env })
      : { status: 'deferred' };
    const food = receipts.length < MAX_SOURCES_PER_TICK
      ? await syncFoodRecommendation(store, { cfEnv: env })
      : { status: 'deferred' };
    const weather = receipts.length < MAX_SOURCES_PER_TICK ? await syncWeather(store) : { status: 'deferred' };
    const summary = receipts.map((r) => `${r.source_id}:${r.outcome}`).join(' ');
    console.log(
      `[cron] ${event.cron} ran=${receipts.length} ${summary} alerts_ai=${alerts.status} food_ai=${food.status} weather=${weather.status}` +
        `${deferred.length ? ` deferred=${deferred.join(',')}` : ''}` +
        `${pruned ? ` pruned=${pruned}` : ''}`,
    );
  },
};
