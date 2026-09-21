#!/usr/bin/env node
/**
 * Relay CLI. Exists so every claim in the dev log is reproducible with one command, and so the
 * container target can poll from cron without running the HTTP server.
 *
 *   node apps/relay/src/cli.mjs sources
 *   node apps/relay/src/cli.mjs poll [sourceId] [--date YYYY-MM-DD]
 *   node apps/relay/src/cli.mjs bundle [--no-weather]
 *   node apps/relay/src/cli.mjs health
 *   node apps/relay/src/cli.mjs serve [--port 8787]
 *   node apps/relay/src/cli.mjs runs [--limit 10]
 */
import { SqliteStore } from './store.mjs';
import { runSource } from './runner.mjs';
import { SOURCES, enabledSources, readiness, sourceById } from '#sources/registry.mjs';
import { buildDashboard } from './cards.mjs';

const [, , cmd = 'help', ...rest] = process.argv;
const flags = Object.fromEntries(
  rest
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    }),
);
const positional = rest.filter((a) => !a.startsWith('--'));
const dbPath = flags.db ?? process.env.RELAY_DB ?? 'relay.db';

function out(obj) {
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

switch (cmd) {
  case 'sources':
    out(readiness(enabledSources()));
    break;

  case 'poll': {
    const store = new SqliteStore(dbPath);
    const targets = positional.length ? [sourceById(positional[0])].filter(Boolean) : enabledSources();
    if (!targets.length) {
      out(`no such source: ${positional[0]}`);
      process.exit(2);
    }
    const receipts = [];
    for (const s of targets) {
      const r = await runSource(s, store, { now: Date.now(), date: flags.date ?? null, dryRun: Boolean(flags['dry-run']) });
      receipts.push(r);
    }
    out(
      receipts.map((r) => ({
        source: r.source_id,
        outcome: r.outcome,
        http: r.http_status,
        bytes: r.bytes,
        parsed: r.rows_parsed ?? null,
        written: r.rows_written,
        tombstones: r.tombstones ?? 0,
        error: r.error || undefined,
        meta: r.meta,
      })),
    );
    store.close();
    break;
  }

  case 'bundle': {
    const store = new SqliteStore(dbPath);
    const bundle = await buildDashboard(store, { now: Date.now(), useWeather: !flags['no-weather'] });
    out(bundle);
    store.close();
    break;
  }

  case 'health': {
    const store = new SqliteStore(dbPath);
    const last = store.lastRunPerSource();
    out({
      sources: readiness(enabledSources()).map((r) => {
        const run = last.find((l) => l.source_id === r.id);
        return {
          id: r.id,
          ready: r.ready,
          blocked_by: r.blocked_by || undefined,
          last_outcome: run?.outcome ?? null,
          age_s: run ? Math.round((Date.now() - run.finished_at) / 1000) : null,
          rows: run?.rows_written ?? null,
          error: run?.error || undefined,
        };
      }),
      snapshots: store.snapshotCount(),
    });
    store.close();
    break;
  }

  case 'runs': {
    const store = new SqliteStore(dbPath);
    out(store.recentRuns(Number(flags.limit ?? 10)));
    store.close();
    break;
  }

  case 'serve': {
    const { start } = await import('./server.mjs');
    const handle = await start({ port: Number(flags.port ?? 8787), dbPath, intervalMs: Number(flags.interval ?? 30000) });
    process.on('SIGINT', () => {
      handle.close();
      process.exit(0);
    });
    break;
  }

  default:
    out(`usage: cli.mjs <sources|poll|bundle|health|runs|serve> [args]\n SOURCES=${SOURCES.length} enabled=${enabledSources().length}`);
}
