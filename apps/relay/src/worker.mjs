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
import { rankDailyMenu, DEFAULT_AI_MODEL, POPULAR_MODELS } from './ai.mjs';

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
 * runs every 15 minutes, which is far more often than the slowest cadence (food, 12 hours), so
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
  const jobs = await store.dueJobs(now);
  const ready = jobs
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
      cadenceMs: source.cadenceMs,
      now: Date.now(),
    });
  }

  // Sources that have never run get scheduled on the first pass, so a fresh D1 fills itself.
  for (const source of enabledSources(SOURCES)) {
    if (!jobs.find((j) => j.source_id === source.id)) {
      await store.scheduleJob(source.id, scheduleFor(source) ? Date.now() : Date.now() + 6 * 60 * 60 * 1000);
    }
  }

  // The receipt log is an audit trail, not a history: prune it every cycle so the
  // latest-run-per-source query cannot become a full scan of a table that only grows.
  const pruned = await store.pruneRuns(now - RUN_RETENTION_MS);

  return { receipts, deferred, pruned };
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
    return json({ error: 'not found', routes: ['/healthz', '/v1/dashboard', '/v1/health/sources', '/v1/credentials', '/v1/poll?source=<id> (POST)', '/v1/snapshot/<sha>'] }, 404);
  }

  const token = env.RELAY_TOKEN || '';
  if (token && request.headers.get('authorization') !== `Bearer ${token}`) {
    return json({ error: 'unauthorized' }, 401);
  }

  const store = storeFor(env);
  await store.init();

  if (path === '/v1/dashboard') {
    return json(await buildDashboard(store, { now: Date.now() }));
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
    const snap = await store.getSnapshot(sha);
    if (!snap) return json({ error: 'no such snapshot' }, 404);
    return new Response(snap.body, { headers: { 'content-type': snap.content_type || 'text/plain' } });
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
        cadenceMs: source.cadenceMs,
        now: Date.now(),
      });
      return json({ receipts: [receipt], deferred: [] });
    }
    // A manual poll obeys the same query budget as the cron, because the cap is a platform limit
    // (50 D1 queries per invocation on Free) and not a property of the scheduled path. Poll one
    // source at a time with ?source=<id> when everything needs to run right now.
    const { receipts, deferred, pruned } = await pollDue(store, Date.now());
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
    const model = body.model || DEFAULT_AI_MODEL;
    const now = Date.now();
    const serviceDate = body.date || todayInToronto(now);

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
    try {
      const recommendation = await rankDailyMenu({
        menuItems: menuRows,
        serviceDate: menuRows[0]?.service_date || serviceDate,
        tasteProfile,
        model,
        force: Boolean(body.force),
        now,
        cfEnv: env, // native env.AI binding: no API key, no REST round trip
      });
      return json(recommendation);
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }

  /**
   * Credentials are read-only on Workers. A .env file is the local write path; a Worker secret is
   * set with `wrangler secret put`, so the POST that works locally is refused here on purpose
   * rather than silently pretending it saved something.
   */
  if (path === '/v1/credentials') {
    const scheduleUrl = process.env.GOOGLE_CALENDAR_ICS_URL || process.env.PORTAL_ICS_URL || '';
    if (request.method === 'GET') {
      return json({
        portal: {
          configured: Boolean(scheduleUrl),
          env_var: process.env.GOOGLE_CALENDAR_ICS_URL ? 'GOOGLE_CALENDAR_ICS_URL' : 'PORTAL_ICS_URL',
          name: 'Schedule Feed (Google Calendar or UW Portal)',
          role: 'Class timetable, personal events and exams',
        },
        learn: {
          configured: Boolean(process.env.LEARN_ICS_URL),
          env_var: 'LEARN_ICS_URL',
          name: 'Waterloo LEARN Deadlines Feed',
          role: 'Upcoming assignments, quizzes, homework and project due dates',
        },
        cloudflare: {
          configured: Boolean(env.AI || (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN)),
          account_id: env.AI ? 'native Workers AI binding' : '',
          name: 'Cloudflare Workers AI',
          role: 'Daily menu ranking and dish highlights (bound, no key needed)',
        },
        writable: false,
      });
    }
    return json(
      {
        error: 'credentials are read-only on this deployment',
        detail: 'set them as Worker secrets: npx wrangler secret put PORTAL_ICS_URL (and LEARN_ICS_URL)',
      },
      501,
    );
  }

  return json(
    {
      error: 'not found',
      routes: ['/healthz', '/v1/dashboard', '/v1/health/sources', '/v1/credentials', '/v1/poll?source=<id> (POST)', '/v1/snapshot/<sha>'],
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
    const { receipts, deferred, pruned } = await pollDue(store, Date.now());
    const summary = receipts.map((r) => `${r.source_id}:${r.outcome}`).join(' ');
    console.log(
      `[cron] ${event.cron} ran=${receipts.length} ${summary}` +
        `${deferred.length ? ` deferred=${deferred.join(',')}` : ''}` +
        `${pruned ? ` pruned=${pruned}` : ''}`,
    );
  },
};
