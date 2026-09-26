/**
 * The relay: one process that both serves and can poll, mirroring the single-Worker Cloudflare
 * target (cron handler + fetch handler in one deployable). Automatic local polling is opt-in so a
 * deployed Worker and a laptop do not both fetch a private Google Calendar subscription.
 *
 * Auth: a bearer token per device when RELAY_TOKEN is set. Without it the server refuses to start
 * unless DEV_ALLOW_OPEN=1, so an unauthenticated instance is a decision, not an accident.
 */
try {
  process.loadEnvFile?.();
} catch {}

import http from 'node:http';
import { SqliteStore } from './store.mjs';
import { runSource } from './runner.mjs';
import { SOURCES, enabledSources, readiness, sourceById, dedupeGoogleSources } from '#sources/registry.mjs';
import { todayInToronto } from '#sources/food/source.mjs';
import { buildDashboard } from './cards.mjs';
import { buildCalendar, calendarOptions } from './calendar.mjs';
import { createStaticHandler, webRootExists, WEB_ROOT } from './static.mjs';
import { RUN_RETENTION_MS } from './schema.mjs';
import { DEFAULT_AI_MODEL, POPULAR_MODELS, getAvailableAiModels } from './ai.mjs';
import { OfficeHoursConfig } from '#contract/office-hours.mjs';
import { getFoodProfile, getFoodRecommendation, saveFoodProfile, syncFoodRecommendation } from './food-recommendation.mjs';
import { clearAiJob, getAiJob, processAiJob, publicAiJob, queueAiJob, restartStalledAiJob } from './ai-jobs.mjs';
import { previewCourseImport, saveCourseResources } from './course-library.mjs';
import { dismissAlert, syncAlertSummary } from './alert-summary.mjs';
import { getCachedWeather, syncWeather } from './weather-cache.mjs';
import { isGuidanceRoute, handleGuidanceRoute, readGuidanceJson } from './guidance-api.mjs';
import { buildRecommendations } from './recommendations.mjs';

export function createServer({
  store,
  sources = SOURCES,
  token = process.env.RELAY_TOKEN ?? '',
  log = console.log,
  webRoot = WEB_ROOT,
  serveWeb = true,
  automaticPolling = true,
}) {
  const started = Date.now();
  let polling = false;
  const startAiJob = (job) => {
    void processAiJob(store, job).catch((error) => log(`[ai-job] ${job.kind} ${error.message}`));
  };
  const resumeAiJobs = async () => {
    const job = await restartStalledAiJob(store, await store.settings());
    if (job) startAiJob(job);
    return job;
  };

  async function pollDue(now = Date.now()) {
    if (polling) return [];
    polling = true;
    const receipts = [];
    try {
      const jobs = store.jobs();
      const due = dedupeGoogleSources(jobs.filter((job) => job.next_due_at <= now).sort((a, b) => a.next_due_at - b.next_due_at)
        .map((j) => sourceById(j.source_id, sources))
        .filter(Boolean)
        .filter((s) => !s.needsSecret || (typeof s.url === 'function' ? s.url() : s.url)));
      for (const source of due) {
        const startedAt = Date.now();
        const receipt = await runSource(source, store, { now: startedAt });
        receipts.push(receipt);
        const job = store.recordJobResult(source.id, {
          startedAt,
          finishedAt: receipt.finished_at,
          outcome: receipt.outcome,
          httpStatus: receipt.http_status,
          retryAfterMs: receipt.retry_after_ms,
          cadenceMs: source.cadenceMs,
          rateLimitMinMs: source.rateLimitMinMs,
          rateLimitMaxMs: source.rateLimitMaxMs,
          now: Date.now(),
        });
        log(
          `[poll] ${source.id} -> ${receipt.outcome} rows=${receipt.rows_written}` +
            `${receipt.tombstones ? ` tombstones=${receipt.tombstones}` : ''}` +
            `${receipt.error ? ` error="${receipt.error}"` : ''} next_in=${Math.round((job.next_due_at - Date.now()) / 1000)}s circuit=${job.circuit}`,
        );
      }
      // sources that are still unscheduled get scheduled on first pass
      for (const source of enabledSources(sources)) {
        if (!jobs.find((j) => j.source_id === source.id)) {
          const ready = !source.needsSecret || (typeof source.url === 'function' ? source.url() : source.url);
          store.scheduleJob(source.id, ready ? Date.now() : Date.now() + 6 * 60 * 60 * 1000);
        }
      }
      // Same retention sweep as the Worker cron: receipts are an audit trail, not a history.
      const pruned = await store.pruneRuns(now - RUN_RETENTION_MS);
      if (pruned) log(`[poll] pruned ${pruned} run receipts older than ${Math.round(RUN_RETENTION_MS / 86_400_000)}d`);
      const prunedSnapshots = await store.pruneSnapshots(now - RUN_RETENTION_MS);
      if (prunedSnapshots) log(`[poll] pruned ${prunedSnapshots} unreferenced snapshots`);
      void syncFoodRecommendation(store)
        .then((food) => { if (food.status === 'failed' && !food.cached) log(`[food-ai] ${food.error}`); })
        .catch((error) => log(`[food-ai] ${error.message}`));
      void syncAlertSummary(store)
        .then((alert) => { if (alert.status === 'failed' && !alert.cached) log(`[alert-ai] ${alert.error}`); })
        .catch((error) => log(`[alert-ai] ${error.message}`));
      void syncWeather(store)
        .then((weather) => { if (weather.status === 'failed') log(`[weather] ${weather.error}`); })
        .catch((error) => log(`[weather] ${error.message}`));
    } finally {
      polling = false;
    }
    return receipts;
  }

  const serveStatic = serveWeb ? createStaticHandler({ root: webRoot }) : null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const send = (code, obj, type = 'application/json') => {
      const body = type === 'application/json' ? JSON.stringify(obj, null, 2) : String(obj);
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };

    if (url.pathname === '/healthz') return send(200, { ok: true, uptime_s: Math.round((Date.now() - started) / 1000) });

    /**
     * The token gates the data, not the shell.
     *
     * A browser cannot attach an Authorization header to the initial document request, so gating
     * index.html on a bearer token would make the app unopenable. The app shell is therefore public
     * and every /v1 route below stays authenticated. Nothing personal lives in the bundle: it is an
     * empty renderer until /v1/dashboard answers, and that call carries the header.
     */
    if (serveStatic && !url.pathname.startsWith('/v1/')) {
      if (await serveStatic(req, res, url.pathname)) return;
    }

    if (token) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
    }

    try {
      // Local relay only: the temporary Vite diagnostics page can move the clock without
      // changing production Worker routes or fetching new data for a hypothetical date.
      if (url.pathname === '/v1/recommendations/preview') {
        if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
        const values = url.searchParams.getAll('at');
        if (values.length !== 1 || !/^\d{13}$/.test(values[0])) return send(400, { error: 'at must be one epoch-millisecond timestamp' });
        const selectedAt = Number(values[0]);
        const evaluatedAt = Date.now();
        const dayMs = 86_400_000;
        if (!Number.isSafeInteger(selectedAt) || selectedAt < evaluatedAt - 8 * dayMs || selectedAt > evaluatedAt + 15 * dayMs) {
          return send(400, { error: 'preview time must be within about one week before or two weeks after today' });
        }
        let filters;
        try { filters = calendarOptions(url.searchParams, selectedAt); }
        catch (error) { if (error instanceof RangeError) return send(400, { error: error.message }); throw error; }
        const weather = await getCachedWeather(store, { now: evaluatedAt });
        const feed = await buildRecommendations(store, { now: selectedAt, freshnessNow: evaluatedAt, section: filters.section, group: filters.group, weather });
        return send(200, { ...feed, preview: { selected_at: selectedAt, evaluated_at: evaluatedAt, uses_current_saved_data: true } });
      }
      if (isGuidanceRoute(url.pathname)) {
        const result = await handleGuidanceRoute({ url, method: req.method, readBody: () => readGuidanceJson(req), store, startAiJob });
        return send(result.status, result.body);
      }
      if (url.pathname === '/v1/dashboard') {
        const bundle = await buildDashboard(store, { now: Date.now() });
        return send(200, bundle);
      }
      if (url.pathname === '/v1/alerts/dismiss' && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'invalid json' }); }
        return (await dismissAlert(store, body?.key)) ? send(200, { ok: true }) : send(409, { error: 'alert has changed; refresh the dashboard' });
      }
      if (url.pathname === '/v1/calendar' && req.method === 'GET') {
        const now = Date.now();
        let options;
        try {
          options = calendarOptions(url.searchParams, now);
        } catch (error) {
          if (error instanceof RangeError) return send(400, { error: error.message });
          throw error;
        }
        return send(200, await buildCalendar(store, { ...options, now }));
      }
      if (url.pathname === '/v1/food/recommendation' && req.method === 'GET') {
        const date = url.searchParams.get('date') || '';
        const result = await getFoodRecommendation(store, date);
        return send(200, { ...result, ranking_job: date ? await getAiJob(store, 'food', date) : { status: 'idle' } });
      }
      if (url.pathname === '/v1/food/profile' && req.method === 'GET') return send(200, { profile: await getFoodProfile(store) });
      if (url.pathname === '/v1/food/profile' && req.method === 'PUT') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'invalid json' }); }
        return send(200, { profile: await saveFoodProfile(store, body) });
      }
      if (url.pathname === '/v1/courses/import' && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'invalid json' }); }
        if (typeof body?.text !== 'string' || body.text.length > 100_000) return send(400, { error: 'text must be at most 100 KB' });
        return send(200, { resources: previewCourseImport(body.text) });
      }
      const courseResourceMatch = /^\/v1\/courses\/([^/]+)\/resources$/.exec(url.pathname);
      if (courseResourceMatch && req.method === 'PUT') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'invalid json' }); }
        try { return send(200, { resources: await saveCourseResources(store, decodeURIComponent(courseResourceMatch[1]), body.resources) }); }
        catch (error) { if (error instanceof RangeError || error instanceof URIError) return send(400, { error: error.message }); throw error; }
      }
      if (url.pathname === '/v1/health/sources') {
        const last = store.lastRunPerSource();
        return send(200, {
          now: Date.now(),
          sources: readiness(sources).map((r) => {
            const run = last.find((l) => l.source_id === r.id);
            const job = store.jobs().find((j) => j.source_id === r.id);
            return {
              ...r,
              last_run: run
                ? { at: run.finished_at, outcome: run.outcome, http_status: run.http_status, rows: run.rows_written, bytes: run.bytes, error: run.error, meta: run.meta }
                : null,
              age_s: run ? Math.round((Date.now() - run.finished_at) / 1000) : null,
              job: job ? { next_due_at: job.next_due_at, circuit: job.circuit_state, failures: job.consecutive_failures } : null,
            };
          }),
          snapshots: store.snapshotCount(),
        });
      }
      if (url.pathname.startsWith('/v1/snapshot/')) {
        const sha = url.pathname.split('/').pop();
        if (!/^[a-f0-9]{64}$/.test(sha || '')) return send(400, { error: 'invalid snapshot id' });
        const snap = store.getSnapshot(sha);
        if (!snap) return send(404, { error: 'no such snapshot' });
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="snapshot-${sha}.txt"`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        });
        return res.end(snap.body);
      }
      if (url.pathname === '/v1/poll' && req.method === 'POST') {
        const id = url.searchParams.get('source');
        const targets = id
          ? [sourceById(id, sources)].filter(Boolean)
          : dedupeGoogleSources(enabledSources(sources));
        const receipts = [];
        for (const s of targets) {
          const r = await runSource(s, store, { now: Date.now() });
          store.recordJobResult(s.id, {
            startedAt: r.started_at,
            finishedAt: r.finished_at,
            outcome: r.outcome,
            httpStatus: r.http_status,
            retryAfterMs: r.retry_after_ms,
            cadenceMs: s.cadenceMs,
            rateLimitMinMs: s.rateLimitMinMs,
            rateLimitMaxMs: s.rateLimitMaxMs,
            now: Date.now(),
          });
          receipts.push(r);
        }
        return send(200, { receipts });
      }

      if (url.pathname === '/v1/ai/models' && req.method === 'GET') {
        const models = await getAvailableAiModels({
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
          apiToken: process.env.CLOUDFLARE_API_TOKEN,
        });
        return send(200, {
          default_model: DEFAULT_AI_MODEL,
          models,
        });
      }

      if (url.pathname === '/v1/ai/jobs' && req.method === 'GET') {
        try { return send(200, await getAiJob(store, url.searchParams.get('kind'), url.searchParams.get('scope') || '')); }
        catch (error) { return send(400, { error: error.message }); }
      }
      if (url.pathname === '/v1/ai/jobs' && req.method === 'DELETE') {
        try {
          await clearAiJob(store, url.searchParams.get('kind'), url.searchParams.get('scope') || '');
          return send(200, { ok: true });
        } catch (error) { return send(400, { error: error.message }); }
      }

      if (url.pathname === '/v1/ai/rank-food' && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(400, { error: 'invalid json' });
        }
        const date = body.date || todayInToronto(Date.now());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(400, { error: 'invalid menu date' });
        if (!store.rows('menu_item', { where: 'service_date = ?', params: [date], limit: 1 }).length) return send(404, { error: 'No dining menu items available for this date.' });
        const queued = await queueAiJob(store, { kind: 'food', scope: date, input: { date } });
        if (queued.started) startAiJob(queued.job);
        return send(202, publicAiJob(queued.job));
      }

      if (url.pathname === '/v1/ai/parse-office-hours' && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(400, { error: 'invalid json' });
        }
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text || text.length > 100_000) return send(400, { error: 'Office hours text must contain 1 to 100,000 characters.' });
        const course = typeof body.course === 'string' ? body.course.trim() : '';
        const model = body.model || DEFAULT_AI_MODEL;
        const force = Boolean(body.force);
        const queued = await queueAiJob(store, { kind: 'office_hours', scope: 'latest', input: { text, course, model, force } });
        if (queued.started) startAiJob(queued.job);
        return send(202, publicAiJob(queued.job));
      }

      if (url.pathname === '/v1/office-hours' && req.method === 'GET') {
        const raw = store.getSetting('OFFICE_HOURS_JSON');
        if (!raw) {
          return send(200, { rules: [], version: 1 });
        }
        try {
          const config = JSON.parse(raw);
          const parsed = OfficeHoursConfig.safeParse(config);
          return send(200, parsed.success ? parsed.data : { rules: [], version: 1 });
        } catch {
          return send(200, { rules: [], version: 1 });
        }
      }

      if (url.pathname === '/v1/office-hours' && req.method === 'PUT') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(400, { error: 'invalid json' });
        }
        const now = Date.now();
        if (body && Array.isArray(body.rules)) {
          body.rules = body.rules.map((r) => ({
            ...r,
            id: r.id || globalThis.crypto.randomUUID().slice(0, 10),
            created_at: r.created_at || now,
            updated_at: now,
          }));
        }
        const parsed = OfficeHoursConfig.safeParse(body);
        if (!parsed.success) {
          return send(400, { error: 'Validation failed', details: parsed.error.issues });
        }
        const config = parsed.data;
        store.setSetting('OFFICE_HOURS_JSON', JSON.stringify(config), now);

        const source = sourceById('user-office-hours', sources);
        let rowsWritten = 0;
        if (source) {
          const receipt = await runSource(source, store, { now });
          rowsWritten = receipt.rows_written;
        }
        return send(200, { config, rows_written: rowsWritten });
      }

      /**
       * Credential input validation. The value is written into .env line by line, so anything with
       * whitespace in it can inject extra lines (a newline plus `RELAY_TOKEN=` is a whole other
       * secret), and anything that is not an https URL is not a feed.
       */
      const looksLikeIcsUrl = (v) => typeof v === 'string' && /^https:\/\/\S+$/.test(v.trim());
      const looksLikeToken = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]+$/.test(v.trim());

      if (url.pathname === '/v1/credentials') {
        if (req.method === 'GET') {
          const scheduleUrl = process.env.GOOGLE_CALENDAR_ICS_URL || process.env.PORTAL_ICS_URL || '';
          return send(200, {
            portal: {
              configured: Boolean(scheduleUrl),
              env_var: process.env.GOOGLE_CALENDAR_ICS_URL ? 'GOOGLE_CALENDAR_ICS_URL' : 'PORTAL_ICS_URL',
              name: 'Schedule Feed (Google Calendar or UW Portal)',
              role: 'Class timetable, personal events, exams & walk countdowns',
            },
            learn: {
              configured: Boolean(process.env.LEARN_ICS_URL),
              env_var: 'LEARN_ICS_URL',
              name: 'Waterloo LEARN Deadlines Feed',
              role: 'Upcoming assignments, quizzes, homework & project due dates',
            },
            cloudflare: {
              configured: Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN),
              account_id: process.env.CLOUDFLARE_ACCOUNT_ID
                ? `${process.env.CLOUDFLARE_ACCOUNT_ID.slice(0, 4)}...${process.env.CLOUDFLARE_ACCOUNT_ID.slice(-4)}`
                : '',
              name: 'Cloudflare Workers AI (Gemma 4)',
              role: 'Powers daily menu ranking and dish highlights (optional for local dev, automatic on Workers)',
            },
          });
        }
        if (req.method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString('utf8');
          let body = {};
          try {
            body = JSON.parse(raw);
          } catch {
            return send(400, { error: 'invalid json' });
          }
          const { PORTAL_ICS_URL, GOOGLE_CALENDAR_ICS_URL, LEARN_ICS_URL, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = body;
          for (const [name, value] of Object.entries({ PORTAL_ICS_URL, GOOGLE_CALENDAR_ICS_URL, LEARN_ICS_URL })) {
            if (value === undefined || value === '') continue;
            if (!looksLikeIcsUrl(value)) {
              return send(400, { error: `${name} must be an https URL with no whitespace` });
            }
          }
          for (const [name, value] of Object.entries({ CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN })) {
            if (value === undefined || value === '') continue;
            if (!looksLikeToken(value)) {
              return send(400, { error: `${name} must contain only letters, numbers, underscores and hyphens` });
            }
          }
          let changed = false;
          const scheduleInput = GOOGLE_CALENDAR_ICS_URL !== undefined ? GOOGLE_CALENDAR_ICS_URL : PORTAL_ICS_URL;
          if (typeof scheduleInput === 'string') {
            const trimmed = scheduleInput.trim();
            if (trimmed) {
              process.env.PORTAL_ICS_URL = trimmed;
              process.env.GOOGLE_CALENDAR_ICS_URL = trimmed;
              changed = true;
            } else if (scheduleInput === '') {
              delete process.env.PORTAL_ICS_URL;
              delete process.env.GOOGLE_CALENDAR_ICS_URL;
              changed = true;
            }
          }
          if (typeof LEARN_ICS_URL === 'string') {
            const trimmed = LEARN_ICS_URL.trim();
            if (trimmed) {
              process.env.LEARN_ICS_URL = trimmed;
              changed = true;
            } else if (LEARN_ICS_URL === '') {
              delete process.env.LEARN_ICS_URL;
              changed = true;
            }
          }
          if (typeof CLOUDFLARE_ACCOUNT_ID === 'string') {
            const trimmed = CLOUDFLARE_ACCOUNT_ID.trim();
            if (trimmed) {
              process.env.CLOUDFLARE_ACCOUNT_ID = trimmed;
              changed = true;
            } else if (CLOUDFLARE_ACCOUNT_ID === '') {
              delete process.env.CLOUDFLARE_ACCOUNT_ID;
              changed = true;
            }
          }
          if (typeof CLOUDFLARE_API_TOKEN === 'string') {
            const trimmed = CLOUDFLARE_API_TOKEN.trim();
            if (trimmed) {
              process.env.CLOUDFLARE_API_TOKEN = trimmed;
              changed = true;
            } else if (CLOUDFLARE_API_TOKEN === '') {
              delete process.env.CLOUDFLARE_API_TOKEN;
              changed = true;
            }
          }

          // Persist to .env in project root
          try {
            const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
            const { resolve } = await import('node:path');
            const envPath = resolve(process.cwd(), '.env');
            let content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
            if (process.env.PORTAL_ICS_URL) {
              if (/^PORTAL_ICS_URL=/m.test(content)) {
                content = content.replace(/^PORTAL_ICS_URL=.*$/m, `PORTAL_ICS_URL=${process.env.PORTAL_ICS_URL}`);
              } else {
                content += `\nPORTAL_ICS_URL=${process.env.PORTAL_ICS_URL}`;
              }
              if (/^GOOGLE_CALENDAR_ICS_URL=/m.test(content)) {
                content = content.replace(/^GOOGLE_CALENDAR_ICS_URL=.*$/m, `GOOGLE_CALENDAR_ICS_URL=${process.env.PORTAL_ICS_URL}`);
              } else {
                content += `\nGOOGLE_CALENDAR_ICS_URL=${process.env.PORTAL_ICS_URL}`;
              }
            }
            if (process.env.LEARN_ICS_URL) {
              if (/^LEARN_ICS_URL=/m.test(content)) {
                content = content.replace(/^LEARN_ICS_URL=.*$/m, `LEARN_ICS_URL=${process.env.LEARN_ICS_URL}`);
              } else {
                content += `\nLEARN_ICS_URL=${process.env.LEARN_ICS_URL}`;
              }
            }
            if (process.env.CLOUDFLARE_ACCOUNT_ID) {
              if (/^CLOUDFLARE_ACCOUNT_ID=/m.test(content)) {
                content = content.replace(/^CLOUDFLARE_ACCOUNT_ID=.*$/m, `CLOUDFLARE_ACCOUNT_ID=${process.env.CLOUDFLARE_ACCOUNT_ID}`);
              } else {
                content += `\nCLOUDFLARE_ACCOUNT_ID=${process.env.CLOUDFLARE_ACCOUNT_ID}`;
              }
            }
            if (process.env.CLOUDFLARE_API_TOKEN) {
              if (/^CLOUDFLARE_API_TOKEN=/m.test(content)) {
                content = content.replace(/^CLOUDFLARE_API_TOKEN=.*$/m, `CLOUDFLARE_API_TOKEN=${process.env.CLOUDFLARE_API_TOKEN}`);
              } else {
                content += `\nCLOUDFLARE_API_TOKEN=${process.env.CLOUDFLARE_API_TOKEN}`;
              }
            }
            writeFileSync(envPath, content.trim() + '\n', 'utf8');
          } catch (e) {
            log(`[credentials] warning: could not write .env: ${e.message}`);
          }

          // Schedule and trigger immediate poll if calendar URLs changed
          if (changed && automaticPolling) {
            setTimeout(() => {
              pollDue(Date.now()).catch((e) => log(`[poll] post-credential poll error: ${e.message}`));
            }, 50);
          }

          return send(200, {
            ok: true,
            portal_configured: Boolean(process.env.PORTAL_ICS_URL || process.env.GOOGLE_CALENDAR_ICS_URL),
            learn_configured: Boolean(process.env.LEARN_ICS_URL),
            cloudflare_configured: Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN),
          });
        }
      }
      return send(404, {
        error: 'not found',
        routes: ['/healthz', '/v1/dashboard', '/v1/calendar', '/v1/health/sources', '/v1/credentials', '/v1/poll?source=<id> (POST)', '/v1/snapshot/<sha>'],
        web: serveStatic ? 'GET / serves apps/web/dist when it has been built' : 'web client disabled',
      });
    } catch (e) {
      return send(500, { error: e.message, stack: e.stack?.split('\n').slice(0, 4) });
    }
  });

  return { server, pollDue, resumeAiJobs, store };
}

export async function start({
  port = 8787,
  host = '127.0.0.1',
  dbPath = 'relay.db',
  intervalMs = 30 * 1000,
  token = process.env.RELAY_TOKEN ?? '',
  log = console.log,
  webRoot = WEB_ROOT,
  serveWeb = true,
  pollEnabled = /^(1|true|yes)$/i.test(process.env.RELAY_POLL_ENABLED ?? ''),
} = {}) {
  const store = new SqliteStore(dbPath);
  const { server, pollDue, resumeAiJobs } = createServer({ store, token, log, webRoot, serveWeb, automaticPolling: pollEnabled });

  log('sources:');
  for (const r of readiness(enabledSources())) {
    log(`  ${r.ready ? 'ready  ' : 'blocked'} ${r.id.padEnd(20)} shape=${String(r.shape).padEnd(15)} cadence=${Math.round(r.cadence_ms / 1000)}s ${r.ready ? '' : `(${r.blocked_by})`}`);
  }

  const hasWeb = serveWeb && (await webRootExists(webRoot));
  if (serveWeb && !hasWeb) {
    log(`web client not built: run "npm --prefix apps/web run build" to serve the dashboard at /`);
  }

  if (pollEnabled) await pollDue(Date.now());
  const timer = pollEnabled
    ? setInterval(() => {
      pollDue(Date.now()).catch((e) => log(`[poll] error: ${e.message}`));
    }, intervalMs)
    : null;
  timer?.unref?.();
  const aiRecoveryTimer = setInterval(() => {
    resumeAiJobs().catch((error) => log(`[ai-job] recovery error: ${error.message}`));
  }, 60_000);
  aiRecoveryTimer.unref?.();

  await new Promise((resolve) => server.listen(port, host, resolve));
  log(`relay listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}${token ? ' (bearer auth on)' : ' (OPEN, no token set)'}`);
  if (!pollEnabled) log('automatic polling disabled; the deployed Worker cron is the canonical poller (set RELAY_POLL_ENABLED=1 for a standalone local relay)');
  if (host === '0.0.0.0') log(`reachable from another device on this network at http://<this-box-ip>:${port}/`);
  if (hasWeb) log(`dashboard at  http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
  return { server, store, pollDue, close: () => { if (timer) clearInterval(timer); clearInterval(aiRecoveryTimer); server.close(); store.close(); } };
}
