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
import { ApiTokenInputError, createApiToken, listApiTokens, revokeApiToken } from './mcp/tokens.mjs';

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
    const value = v !== undefined
      ? v
      : rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    // --header is repeatable: a remote MCP endpoint needs both Access service-token headers.
    if (k === 'header') (flags.header ??= []).push(value);
    else flags[k] = value;
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
      const r = await runSource(s, store, { now: Date.now(), date: flags.date ?? null, dryRun: Boolean(flags['dry-run']), holdLease: true });
      if (r.claim_token) {
        try {
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
            claimToken: r.claim_token,
          });
        } finally {
          store.releaseSource(s.id, r.claim_token, Date.now());
        }
      }
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

  case 'mcp': {
    const { runStdio } = await import('./mcp/stdio.mjs');
    const headerValues = flags.header === undefined ? [] : Array.isArray(flags.header) ? flags.header : [flags.header];
    await runStdio({
      dbPath,
      url: typeof flags.url === 'string' ? flags.url : null,
      headers: headerValues.filter((value) => typeof value === 'string'),
    });
    break;
  }

  case 'mcp-token': {
    // Local database only. The deployed Worker has its own /v1/mcp-tokens routes because it owns
    // the remote D1 database; this command is for the local relay and for tests.
    const subcommand = positional[0] ?? 'list';
    const store = new SqliteStore(dbPath);
    try {
      if (subcommand === 'create') {
        const scopeFlag = typeof flags.scope === 'string' ? flags.scope.split(/[\s,]+/).filter(Boolean) : undefined;
        const created = await createApiToken(store, {
          name: typeof flags.name === 'string' ? flags.name : '',
          scopes: scopeFlag,
          expiresInDays: flags.days === undefined ? null : numberFlag('days', 90, { min: 1, max: 3650 }),
        });
        out(created);
      } else if (subcommand === 'list') {
        out({ tokens: await listApiTokens(store) });
      } else if (subcommand === 'revoke') {
        const ok = await revokeApiToken(store, typeof flags.id === 'string' ? flags.id : '');
        out({ ok, id: typeof flags.id === 'string' ? flags.id : '' });
        if (!ok) process.exitCode = 1;
      } else {
        out('usage: cli.mjs mcp-token <create|list|revoke> [--name laptop] [--days 90] [--scope mcp:read] [--id <id>]');
        process.exitCode = 2;
      }
    } catch (error) {
      if (error instanceof ApiTokenInputError) {
        console.error(`error: ${error.message}`);
        process.exitCode = 2;
      } else {
        throw error;
      }
    } finally {
      store.close();
    }
    break;
  }

  default:
    out(`usage: cli.mjs <sources|poll|bundle|health|runs|serve|mcp|mcp-token> [args]
  flags take --name=value or --name value
  mcp:       --url=<deployed /mcp> --header "CF-Access-Client-Id: ..." (or an API key via RELAY_TOKEN env)
  mcp-token: create|list|revoke  --name <label> [--days 90] [--scope mcp:read] [--id <id>]
  SOURCES=${SOURCES.length} enabled=${enabledSources().length}`);
}
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(2);
}
