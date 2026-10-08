/**
 * Table shapes, DDL and row converters, shared by both storage adapters.
 *
 * This module imports nothing on purpose. SqliteStore needs `node:sqlite` and D1Store needs the
 * Cloudflare binding, but a Worker bundle must not resolve `node:sqlite` at all, so everything the
 * two adapters agree on lives here and is imported by both.
 */

const CHUNK = 25; // rows per statement, keeps bound params well under any dialect's limit
const INDEXES = ['idx_timeline_starts', 'idx_menu_date', 'idx_source_run_source_id', 'idx_source_run_finished', 'idx_source_run_body_sha', 'idx_raw_snapshot_fetched', 'idx_calendar_change_observed'];

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

function ddlStatements() {
  const parts = [];
  parts.push(`CREATE TABLE IF NOT EXISTS calendar_change (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, observed_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );`);
  parts.push('CREATE INDEX IF NOT EXISTS idx_calendar_change_observed ON calendar_change (observed_at);');
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
    circuit_state TEXT NOT NULL DEFAULT 'closed',
    lease_token TEXT,
    lease_expires_at INTEGER
  );`);
  // Configuration the owner can change from the app. Deliberately its own table rather than a
  // SHAPES entry: settings carry no freshness envelope and no source_id, they are not observations.
  parts.push(`CREATE TABLE IF NOT EXISTS setting (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );`);
  parts.push(`CREATE TABLE IF NOT EXISTS ai_usage (
    day TEXT PRIMARY KEY,
    reserved_neurons INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0
  );`);
  parts.push('CREATE INDEX IF NOT EXISTS idx_timeline_starts ON timeline_event (starts_at, deleted);');
  parts.push('CREATE INDEX IF NOT EXISTS idx_menu_date ON menu_item (service_date, deleted);');
  parts.push('CREATE INDEX IF NOT EXISTS idx_source_run_source_id ON source_run (source_id, id DESC);');
  parts.push('CREATE INDEX IF NOT EXISTS idx_source_run_finished ON source_run (finished_at);');
  parts.push('CREATE INDEX IF NOT EXISTS idx_source_run_body_sha ON source_run (body_sha256);');
  parts.push('CREATE INDEX IF NOT EXISTS idx_raw_snapshot_fetched ON raw_snapshot (fetched_at);');
  return parts;
}

/**
 * The statements one by one, and joined. Both forms exist because the two adapters take different
 * paths to the same schema: node:sqlite accepts the whole script in one `exec()`, while D1's
 * `exec()` runs a statement per line, so a wrapped CREATE TABLE arrives truncated. D1Store
 * therefore prepares each statement and runs them as one `batch()`.
 */
function ddl() {
  return ddlStatements().join('\n');
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

/**
 * Rows per INSERT statement. D1 allows 100 bound parameters per statement, so a multi-row VALUES
 * statement is what keeps the query count per invocation low: one statement per row would spend 21
 * of a Worker's 50 D1 queries on a single day of menus.
 */
function rowsPerStatement(shape) {
  const paramsPerRow = 4 + SHAPES[shape].cols.length + 1; // envelope + shape columns + payload_json
  return Math.max(1, Math.floor(100 / paramsPerRow));
}

/**
 * The upsert statement for a shape, sized to exactly `rowCount` rows.
 *
 * Sizing matters: a statement built for 8 rows and executed with 3 rows' parameters fails the
 * NOT NULL constraints, so the trailing chunk of any batch gets its own statement. Generated SQL is
 * cached per shape and row count, because preparing the same text repeatedly costs Worker CPU.
 */
const upsertSqlCache = new Map();

function upsertSql(shape, rowCount = null) {
  if (!SHAPES[shape]) throw new Error(`unknown shape ${shape}`);
  const perStatement = rowsPerStatement(shape);
  const count = Math.max(1, Math.min(rowCount ?? perStatement, perStatement));
  const cacheKey = `${shape}:${count}`;
  const cached = upsertSqlCache.get(cacheKey);
  if (cached) return cached;

  const cols = ['source_id', 'external_id', 'observed_at', 'valid_until', ...SHAPES[shape].cols, 'payload_json'];
  const tuple = `(${cols.map(() => '?').join(',')})`;
  const values = Array.from({ length: count }, () => tuple).join(',');
  const updates = cols
    .filter((c) => c !== 'source_id' && c !== 'external_id')
    .map((c) => `${c}=excluded.${c}`)
    .join(', ');
  const sql = `INSERT INTO ${shape} (${cols.join(',')}) VALUES ${values}
      ON CONFLICT (source_id, external_id) DO UPDATE SET ${updates}, deleted=0`;

  const built = { sql, perStatement, cols, rowCount: count };
  upsertSqlCache.set(cacheKey, built);
  return built;
}

/**
 * How long the run receipt log is kept. source_run is an audit trail, not a history: left to grow
 * it turns the "latest run per source" query into a full table scan on every dashboard load, which
 * is a rows-read cost against a daily free-tier budget.
 *
 * Retention bounds the table, but it does not make the lookup cheap. Measured on a table holding a
 * 7 day window of receipts (11,123 rows, of which 10,080 are the 60 s status source): the grouped
 * form below walks 11,122 rows to return 6, because SQLite cannot skip ahead through
 * `MAX(id) ... GROUP BY source_id` even with `idx_source_run_source_id` present. One dashboard read
 * asked for that answer seven times and every cron tick asked once, so the scan - not the polling
 * cadence - is what spent the free tier's 5M rows read per day.
 */
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The exhaustive receipt queries: correct, and a full scan of source_run. */
const RECEIPTS_PER_SOURCE = {
  latest: `SELECT r.* FROM source_run r
    JOIN (SELECT source_id, MAX(id) AS id FROM source_run GROUP BY source_id) m ON m.id = r.id`,
  successful: `SELECT r.* FROM source_run r
    JOIN (SELECT source_id, MAX(id) AS id FROM source_run WHERE outcome IN ('ok', 'empty')
      GROUP BY source_id) m ON m.id = r.id`,
};

/** Above this many sources the statement would approach D1's 100 bound-parameter limit. */
const MAX_LOOKUP_SOURCES = 40;

/**
 * The source ids a caller named, or null for "no list given".
 *
 * An unusable list falls back to null rather than to an empty result: every caller reads no rows as
 * "this source has never run", which would quietly degrade a healthy source to an empty card.
 */
function lookupIds(sourceIds) {
  if (!Array.isArray(sourceIds)) return null;
  const ids = [...new Set(sourceIds.filter((id) => typeof id === 'string' && id))];
  if (!ids.length || ids.length > MAX_LOOKUP_SOURCES) return null;
  return ids;
}

/**
 * Latest receipt per named source, through `idx_source_run_source_id (source_id, id DESC)`: one
 * index seek per source, six rows read instead of eleven thousand, and one statement, so the 50
 * queries per invocation budget is unchanged. Returns null when no usable list was given, and the
 * caller runs the exhaustive query instead.
 */
function receiptLookup(sourceIds, { successful = false } = {}) {
  const ids = lookupIds(sourceIds);
  if (!ids) return null;
  const perSource = successful
    ? `SELECT MAX(id) AS id FROM source_run WHERE source_id = ? AND outcome IN ('ok', 'empty')`
    : 'SELECT MAX(id) AS id FROM source_run WHERE source_id = ?';
  return { sql: `SELECT * FROM source_run WHERE id IN (${ids.map(() => perSource).join(' UNION ALL ')})`, params: ids };
}

const SHAPE_COLUMNS = SHAPES;

/**
 * Every table this schema expects. D1Store compares this list against `sqlite_master` before it runs
 * any DDL, so a database created by an older version picks up tables added later. Probing one known
 * table would have missed exactly that case: the table exists, the new one does not, and the DDL
 * never runs again.
 */
const TABLES = [...Object.keys(SHAPES), 'source_run', 'raw_snapshot', 'job', 'setting', 'ai_usage', 'calendar_change'];

export { SHAPES, SHAPE_COLUMNS, ddl, ddlStatements, rowToParams, paramsToRow, rowsPerStatement, upsertSql, RUN_RETENTION_MS, RECEIPTS_PER_SOURCE, receiptLookup, lookupIds, MAX_LOOKUP_SOURCES, TABLES, INDEXES, CHUNK };
