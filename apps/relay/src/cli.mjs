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
try {
  process.loadEnvFile?.();
} catch {}

import { SqliteStore } from './store.mjs';
import { runSource } from './runner.mjs';
import { SOURCES, enabledSources, readiness, sourceById, dedupeGoogleSources } from '#sources/registry.mjs';
import { buildDashboard } from './cards.mjs';

const [, , cmd = 'help', ...rest] = process.argv;

/**
 * Flags accept both `--flag=value` and `--flag value`. The space form was silently broken once:
 * `serve --port 8791` produced port `true`, which Number() turned into 1, and the server died on
 * EACCES binding port 1 instead of saying anything useful.
 */
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (arg.startsWith('--')) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (v !== undefined) flags[k] = v;
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) flags[k] = rest[++i];
    else flags[k] = true;
  } else {
    positional.push(arg);
  }
}

function numberFlag(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  if (raw === true) throw new Error(`--${name} needs a value, e.g. --${name}=${fallback}`);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`--${name} must be a number between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}
const dbPath = flags.db ?? process.env.RELAY_DB ?? 'relay.db';

function out(obj) {
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

try {
switch (cmd) {
  case 'sources':
    out(readiness(enabledSources()));
    break;

  case 'poll': {
    const store = new SqliteStore(dbPath);
    const targets = positional.length
      ? [sourceById(positional[0])].filter(Boolean)
      : dedupeGoogleSources(enabledSources());
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
    out(store.recentRuns(numberFlag('limit', 10)));
    store.close();
    break;
  }

  case 'serve': {
    const { start } = await import('./server.mjs');
    const handle = await start({
      port: numberFlag('port', 8787, { min: 1, max: 65535 }),
      dbPath,
      intervalMs: numberFlag('interval', 30000, { min: 1000 }),
      pollEnabled: flags.poll === true || /^(1|true|yes)$/i.test(String(flags.poll ?? ''))
        ? true
        : /^(0|false|no)$/i.test(String(flags.poll ?? '')) ? false : undefined,
      // 127.0.0.1 by default. --host 0.0.0.0 is for the case where the relay runs on one machine and
      // you want to click it from another, which is the normal case here: the box has the fixtures
      // and the browser is on a different device.
      host: typeof flags.host === 'string' ? flags.host : '127.0.0.1',
    });
    process.on('SIGINT', () => {
      handle.close();
      process.exit(0);
    });
    break;
  }

  default:
    out(`usage: cli.mjs <sources|poll|bundle|health|runs|serve> [args]\n  flags take --name=value or --name value\n  SOURCES=${SOURCES.length} enabled=${enabledSources().length}`);
}
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(2);
}
