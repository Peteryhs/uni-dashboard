/**
 * The relay: one process that both polls and serves, mirroring the single-Worker Cloudflare
 * target (cron handler + fetch handler in one deployable). Locally the "cron" is an interval.
 *
 * Auth: a bearer token per device when RELAY_TOKEN is set. Without it the server refuses to start
 * unless DEV_ALLOW_OPEN=1, so an unauthenticated instance is a decision, not an accident.
 */
import http from 'node:http';
import { SqliteStore } from './store.mjs';
import { runSource } from './runner.mjs';
import { SOURCES, enabledSources, readiness, sourceById } from '#sources/registry.mjs';
import { buildDashboard } from './cards.mjs';

export function createServer({ store, sources = SOURCES, token = process.env.RELAY_TOKEN ?? '', log = console.log }) {
  const started = Date.now();
  let polling = false;

  async function pollDue(now = Date.now()) {
    if (polling) return [];
    polling = true;
    const receipts = [];
    try {
      const jobs = store.dueJobs(now);
      const due = jobs
        .map((j) => sourceById(j.source_id, sources))
        .filter(Boolean)
        .filter((s) => !s.needsSecret || (typeof s.url === 'function' ? s.url() : s.url));
      for (const source of due) {
        const startedAt = Date.now();
        const receipt = await runSource(source, store, { now: startedAt });
        receipts.push(receipt);
        const job = store.recordJobResult(source.id, {
          startedAt,
          finishedAt: receipt.finished_at,
          outcome: receipt.outcome,
          cadenceMs: source.cadenceMs,
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
    } finally {
      polling = false;
    }
    return receipts;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const send = (code, obj, type = 'application/json') => {
      const body = type === 'application/json' ? JSON.stringify(obj, null, 2) : String(obj);
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };

    if (url.pathname === '/healthz') return send(200, { ok: true, uptime_s: Math.round((Date.now() - started) / 1000) });

    if (token) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
    }

    try {
      if (url.pathname === '/v1/dashboard') {
        const bundle = await buildDashboard(store, { now: Date.now() });
        return send(200, bundle);
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
        const snap = store.getSnapshot(sha);
        if (!snap) return send(404, { error: 'no such snapshot' });
        return send(200, snap.body, snap.content_type || 'text/plain');
      }
      if (url.pathname === '/v1/poll' && req.method === 'POST') {
        const id = url.searchParams.get('source');
        const targets = id ? [sourceById(id, sources)].filter(Boolean) : enabledSources(sources);
        const receipts = [];
        for (const s of targets) {
          const r = await runSource(s, store, { now: Date.now() });
          store.recordJobResult(s.id, { startedAt: r.started_at, finishedAt: r.finished_at, outcome: r.outcome, cadenceMs: s.cadenceMs, now: Date.now() });
          receipts.push(r);
        }
        return send(200, { receipts });
      }
      return send(404, { error: 'not found', routes: ['/healthz', '/v1/dashboard', '/v1/health/sources', '/v1/poll?source=<id> (POST)', '/v1/snapshot/<sha>'] });
    } catch (e) {
      return send(500, { error: e.message, stack: e.stack?.split('\n').slice(0, 4) });
    }
  });

  return { server, pollDue, store };
}

export async function start({ port = 8787, dbPath = 'relay.db', intervalMs = 30 * 1000, token = process.env.RELAY_TOKEN ?? '', log = console.log } = {}) {
  const store = new SqliteStore(dbPath);
  const { server, pollDue } = createServer({ store, token, log });

  log('sources:');
  for (const r of readiness(enabledSources())) {
    log(`  ${r.ready ? 'ready  ' : 'blocked'} ${r.id.padEnd(20)} shape=${String(r.shape).padEnd(15)} cadence=${Math.round(r.cadence_ms / 1000)}s ${r.ready ? '' : `(${r.blocked_by})`}`);
  }

  await pollDue(Date.now());
  const timer = setInterval(() => {
    pollDue(Date.now()).catch((e) => log(`[poll] error: ${e.message}`));
  }, intervalMs);
  timer.unref?.();

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  log(`relay listening on http://127.0.0.1:${port}${token ? ' (bearer auth on)' : ' (OPEN, no token set)'}`);
  return { server, store, pollDue, close: () => { clearInterval(timer); server.close(); store.close(); } };
}
