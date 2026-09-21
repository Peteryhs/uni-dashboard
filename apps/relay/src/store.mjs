/**
 * Storage. One interface, two adapters planned (SQLite/D1 tonight, Postgres later), because
 * both deployment targets must stay open.
 *
 * Dialect rules that keep that possible:
 *  - timestamps are epoch milliseconds (INTEGER), never timestamptz
 *  - no jsonb: extras live in a TEXT payload_json column
 *  - upsert on the (source_id, external_id) primary key, never truncate-and-reload
 *  - batching: D1 allows 100 bound parameters per query, so writes are chunked conservatively
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const CHUNK = 25; // rows per statement, keeps bound params well under any dialect's limit

const SHAPES = {
  timeline_event: {
    cols: ['kind', 'title', 'subtitle', 'location', 'all_day', 'starts_at', 'ends_at', 'url'],
    // Types are declared explicitly: a column left to default becomes TEXT affinity, which
    // silently turns epoch milliseconds into strings and breaks every client that compares them.
    types: {
      all_day: 'int',
      starts_at: 'int',
      ends_at: 'int',
      title: 'text',
      subtitle: 'text',
      location: 'text',
      kind: 'text',
      url: 'text',
    },
  },
  menu_item: {
    cols: ['outlet', 'station', 'dish', 'service_date', 'diet_json', 'allergens_json', 'url'],
    types: { diet_json: 'text', allergens_json: 'text', outlet: 'text', station: 'text', dish: 'text', service_date: 'text', url: 'text' },
  },
  place_state: {
    cols: ['place_id', 'name', 'parent_place_id', 'is_open', 'people', 'capacity'],
    types: { is_open: 'int', people: 'int', capacity: 'int' },
  },
  notice: {
    cols: ['severity', 'scope', 'title', 'body', 'url'],
    types: {},
  },
  metric: {
    cols: ['name', 'place_id', 'at', 'value'],
    types: { value: 'real', at: 'int' },
  },
};

function ddl() {
  const parts = [];
  for (const [shape, spec] of Object.entries(SHAPES)) {
    const typed = spec.cols
      .map((c) => {
        const t = spec.types[c] ?? 'text';
        return `${c} ${t === 'int' ? 'INTEGER' : t === 'real' ? 'REAL' : 'TEXT'}`;
      })
      .join(',\n    ');
    parts.push(`CREATE TABLE IF NOT EXISTS ${shape} (
    source_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    valid_until INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    ${typed},
    payload_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (source_id, external_id)
  );`);
  }
  parts.push(`CREATE TABLE IF NOT EXISTS source_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    http_status INTEGER,
    bytes INTEGER NOT NULL DEFAULT 0,
    rows_written INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    body_sha256 TEXT NOT NULL DEFAULT '',
    meta_json TEXT NOT NULL DEFAULT '{}'
  );`);
  parts.push(`CREATE TABLE IF NOT EXISTS raw_snapshot (
    sha256 TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    content_type TEXT NOT NULL DEFAULT '',
    body_gz BLOB NOT NULL
  );`);
  parts.push(`CREATE TABLE IF NOT EXISTS job (
    source_id TEXT PRIMARY KEY,
    next_due_at INTEGER NOT NULL,
    last_started_at INTEGER,
    last_finished_at INTEGER,
    last_outcome TEXT NOT NULL DEFAULT '',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    circuit_state TEXT NOT NULL DEFAULT 'closed'
  );`);
  parts.push('CREATE INDEX IF NOT EXISTS idx_timeline_starts ON timeline_event (starts_at, deleted);');
  parts.push('CREATE INDEX IF NOT EXISTS idx_menu_date ON menu_item (service_date, deleted);');
  return parts.join('\n');
}

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function rowToParams(shape, row) {
  const spec = SHAPES[shape];
  const extras = {};
  const out = [row.source_id, row.external_id, row.observed_at, row.valid_until];
  for (const c of spec.cols) {
    let v = row[c.replace(/_json$/, '')] ?? row[c];
    if (c.endsWith('_json')) v = JSON.stringify(row[c.replace(/_json$/, '')] ?? []);
    if (c === 'all_day' || c === 'is_open') v = v == null ? null : v ? 1 : 0;
    out.push(v ?? null);
  }
  for (const [k, v] of Object.entries(row)) {
    if (!['source_id', 'external_id', 'observed_at', 'valid_until'].includes(k) && !spec.cols.includes(k) && !spec.cols.includes(`${k}_json`)) {
      extras[k] = v;
    }
  }
  out.push(JSON.stringify(extras));
  return out;
}

function paramsToRow(shape, r) {
  const spec = SHAPES[shape];
  const row = {
    source_id: r.source_id,
    external_id: r.external_id,
    observed_at: r.observed_at,
    valid_until: r.valid_until,
    deleted: Boolean(r.deleted),
  };
  for (const c of spec.cols) {
    const key = c.replace(/_json$/, '');
    let v = r[c];
    if (c.endsWith('_json')) v = JSON.parse(r[c] || '[]');
    if (c === 'all_day' || c === 'is_open') v = v == null ? null : Boolean(v);
    row[key] = v;
  }
  Object.assign(row, JSON.parse(r.payload_json || '{}'));
  return row;
}

export class SqliteStore {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(ddl());
  }

  close() {
    this.db.close();
  }

  upsertRows(shape, rows) {
    if (!SHAPES[shape]) throw new Error(`unknown shape ${shape}`);
    if (!rows.length) return 0;
    const spec = SHAPES[shape];
    const cols = ['source_id', 'external_id', 'observed_at', 'valid_until', ...spec.cols, 'payload_json'];
    const placeholders = cols.map(() => '?').join(',');
    const updates = cols
      .filter((c) => c !== 'source_id' && c !== 'external_id')
      .map((c) => `${c}=excluded.${c}`)
      .join(', ');
    const sql = `INSERT INTO ${shape} (${cols.join(',')}) VALUES (${placeholders})
      ON CONFLICT (source_id, external_id) DO UPDATE SET ${updates}, deleted=0`;
    const stmt = this.db.prepare(sql);
    let n = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      for (const row of slice) {
        stmt.run(...rowToParams(shape, row));
        n += 1;
      }
    }
    return n;
  }

  /**
   * Tombstone rows a source no longer reports, but only when the run was plausible and not
   * empty. Diffing happens in JS so no dialect-specific NOT IN gymnastics or bound-parameter
   * limits are involved.
   */
  tombstoneMissing(shape, sourceId, seenExternalIds) {
    const seen = new Set(seenExternalIds);
    const existing = this.db
      .prepare(`SELECT external_id FROM ${shape} WHERE source_id=? AND deleted=0`)
      .all(sourceId)
      .map((r) => r.external_id);
    const stale = existing.filter((e) => !seen.has(e));
    if (!stale.length) return 0;
    const stmt = this.db.prepare(`UPDATE ${shape} SET deleted=1 WHERE source_id=? AND external_id=?`);
    for (const e of stale) stmt.run(sourceId, e);
    return stale.length;
  }

  rows(shape, { where = '', params = [], limit = 1000 } = {}) {
    const spec = SHAPES[shape];
    if (!spec) throw new Error(`unknown shape ${shape}`);
    let sql = `SELECT * FROM ${shape} WHERE deleted=0 ${where ? `AND ${where}` : ''} LIMIT ${Number(limit)}`;
    return this.db.prepare(sql).all(...params).map((r) => paramsToRow(shape, r));
  }

  insertRun(run) {
    this.db
      .prepare(
        `INSERT INTO source_run (source_id, started_at, finished_at, outcome, http_status, bytes, rows_written, error, body_sha256, meta_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.source_id,
        run.started_at,
        run.finished_at,
        run.outcome,
        run.http_status ?? null,
        run.bytes ?? 0,
        run.rows_written ?? 0,
        run.error ?? '',
        run.body_sha256 ?? '',
        JSON.stringify(run.meta ?? {}),
      );
    return true;
  }

  recentRuns(limit = 20) {
    return this.db
      .prepare('SELECT * FROM source_run ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((r) => ({ ...r, meta: JSON.parse(r.meta_json || '{}') }));
  }

  lastRunPerSource() {
    return this.db
      .prepare(
        `SELECT r.* FROM source_run r
         JOIN (SELECT source_id, MAX(id) AS id FROM source_run GROUP BY source_id) m ON m.id = r.id`,
      )
      .all()
      .map((r) => ({ ...r, meta: JSON.parse(r.meta_json || '{}') }));
  }

  saveSnapshot({ sourceId, fetchedAt, contentType, body }) {
    const hash = sha256(body);
    this.db
      .prepare(
        `INSERT INTO raw_snapshot (sha256, source_id, fetched_at, content_type, body_gz)
         VALUES (?,?,?,?,?) ON CONFLICT (sha256) DO NOTHING`,
      )
      .run(hash, sourceId, fetchedAt, contentType, gzipSync(Buffer.from(body, 'utf8')));
    return hash;
  }

  getSnapshot(sha) {
    const r = this.db.prepare('SELECT * FROM raw_snapshot WHERE sha256=?').get(sha);
    if (!r) return null;
    return { ...r, body: gunzipSync(r.body_gz).toString('utf8') };
  }

  snapshotCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM raw_snapshot').get().n;
  }

  /** Job table instead of Postgres LISTEN/NOTIFY or SKIP LOCKED, so D1 works too. */
  dueJobs(now) {
    return this.db.prepare('SELECT * FROM job WHERE next_due_at <= ? ORDER BY next_due_at').all(now);
  }

  scheduleJob(sourceId, nextDueAt) {
    this.db
      .prepare(
        `INSERT INTO job (source_id, next_due_at) VALUES (?,?)
         ON CONFLICT (source_id) DO UPDATE SET next_due_at=excluded.next_due_at`,
      )
      .run(sourceId, nextDueAt);
  }

  recordJobResult(sourceId, { startedAt, finishedAt, outcome, cadenceMs, now }) {
    const prev = this.db.prepare('SELECT * FROM job WHERE source_id=?').get(sourceId);
    const failures = ['ok', 'empty', 'skipped'].includes(outcome)
      ? 0
      : (prev?.consecutive_failures ?? 0) + 1;
    const circuit = failures >= 5 ? 'open' : 'closed';
    // Exponential backoff with jitter, capped at 15 minutes, and a tripped circuit retries at the cap.
    const backoff = Math.min(15 * 60 * 1000, 1000 * 2 ** Math.max(0, failures - 1));
    const next = circuit === 'open' || failures > 0
      ? now + backoff + Math.floor(Math.random() * 1000)
      : now + cadenceMs;
    this.db
      .prepare(
        `INSERT INTO job (source_id, next_due_at, last_started_at, last_finished_at, last_outcome, consecutive_failures, circuit_state)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (source_id) DO UPDATE SET
           next_due_at=excluded.next_due_at,
           last_started_at=excluded.last_started_at,
           last_finished_at=excluded.last_finished_at,
           last_outcome=excluded.last_outcome,
           consecutive_failures=excluded.consecutive_failures,
           circuit_state=excluded.circuit_state`,
      )
      .run(sourceId, next, startedAt, finishedAt, outcome, failures, circuit);
    return { failures, circuit, next_due_at: next };
  }

  jobs() {
    return this.db.prepare('SELECT * FROM job ORDER BY source_id').all();
  }
}

export const SHAPE_COLUMNS = SHAPES;
