#!/usr/bin/env node
/**
 * Dump a readable summary of what the relay has actually fetched and stored, straight from
 * SqliteStore, so a human can sanity check data without hand-writing SQL.
 *
 *   node tools/inspect-db.mjs                 summary of every shape, recent runs, jobs
 *   node tools/inspect-db.mjs menu_item        full rows for one shape
 *   node tools/inspect-db.mjs --db other.db    point at a different SQLite file
 *   node tools/inspect-db.mjs --limit 50 menu_item
 */
import { SqliteStore, SHAPE_COLUMNS } from '../apps/relay/src/store.mjs';

const args = process.argv.slice(2);
const flags = {};
const rest = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--db') flags.db = args[++i];
  else if (a === '--limit') flags.limit = Number(args[++i]);
  else rest.push(a);
}
const dbPath = flags.db ?? process.env.RELAY_DB ?? 'relay.db';
const limit = flags.limit ?? 20;
const shapeFilter = rest[0];

const store = new SqliteStore(dbPath);

function fmtAge(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function printTable(rows, cols) {
  if (!rows.length) {
    console.log('  (no rows)');
    return;
  }
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  console.log('  ' + line(cols));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log('  ' + line(cols.map((c) => r[c])));
}

if (shapeFilter) {
  if (!SHAPE_COLUMNS[shapeFilter]) {
    console.error(`unknown shape "${shapeFilter}". known shapes: ${Object.keys(SHAPE_COLUMNS).join(', ')}`);
    process.exit(1);
  }
  const rows = store.rows(shapeFilter, { limit });
  console.log(`${shapeFilter} — ${rows.length} row(s) shown (limit ${limit}, deleted excluded)\n`);
  for (const r of rows) {
    console.log(JSON.stringify(r, null, 2));
  }
  store.close();
  process.exit(0);
}

console.log(`db: ${dbPath}\n`);

console.log('== rows per shape (deleted excluded) ==');
const summary = Object.keys(SHAPE_COLUMNS).map((shape) => ({
  shape,
  rows: store.rows(shape, { limit: 100000 }).length,
}));
printTable(summary, ['shape', 'rows']);

console.log('\n== last run per source ==');
const runs = store.lastRunPerSource?.() ?? [];
if (runs.length) {
  printTable(
    runs
      .sort((a, b) => a.source_id.localeCompare(b.source_id))
      .map((r) => ({
        source_id: r.source_id,
        outcome: r.outcome,
        http: r.http_status ?? '-',
        rows: r.rows_written,
        bytes: r.bytes,
        when: fmtAge(r.finished_at),
        error: r.error || '',
      })),
    ['source_id', 'outcome', 'http', 'rows', 'bytes', 'when', 'error'],
  );
} else {
  console.log('  (no runs recorded)');
}

console.log('\n== job / circuit state ==');
const jobs = store.jobs();
printTable(
  jobs.map((j) => ({
    source_id: j.source_id,
    circuit: j.circuit_state,
    failures: j.consecutive_failures,
    last_outcome: j.last_outcome,
    next_due: j.next_due_at ? new Date(j.next_due_at).toISOString() : '-',
  })),
  ['source_id', 'circuit', 'failures', 'last_outcome', 'next_due'],
);

console.log(`\n== raw snapshots stored: ${store.snapshotCount()} ==`);

console.log(`\ntip: node tools/inspect-db.mjs <shape> to see full rows. shapes: ${Object.keys(SHAPE_COLUMNS).join(', ')}`);

store.close();
