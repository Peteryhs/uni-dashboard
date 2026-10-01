/**
 * Storage. One interface, two adapters (SQLite/D1 here, Postgres later), because both deployment
 * targets must stay open.
 *
 * Dialect rules that keep that possible:
 *  - timestamps are epoch milliseconds (INTEGER), never timestamptz
 *  - no jsonb: extras live in a TEXT payload_json column
 *  - upsert on the (source_id, external_id) primary key, never truncate-and-reload
 *  - batching: D1 allows 100 bound parameters per query, so writes are chunked conservatively
 *
 * The table shapes, the DDL and the row converters live in `schema.mjs`, which imports nothing, so
 * the D1 adapter can share them without dragging `node:sqlite` into a Worker bundle.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { SHAPES, SHAPE_COLUMNS, ddl, rowToParams, paramsToRow, upsertSql, CHUNK } from './schema.mjs';
import { CHANGE_RETENTION_MS } from './calendar-changes.mjs';

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function hideLeaseFields(row) {
  if (!row) return row;
  for (const key of ['lease_token', 'lease_expires_at']) {
    if (!(key in row)) continue;
    const value = row[key];
    Object.defineProperty(row, key, { value, enumerable: false, configurable: true, writable: true });
  }
  return row;
}

export class SqliteStore {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(ddl());
    this._migrate();
  }

  _migrate() {
    try {
      const cols = this.db.prepare('PRAGMA table_info(setting)').all().map((c) => c.name);
      if (cols.includes('key') && !cols.includes('name')) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS setting_migrated (
            name TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
          INSERT OR IGNORE INTO setting_migrated (name, value, updated_at)
          SELECT key, value_json, updated_at FROM setting;
          DROP TABLE setting;
          ALTER TABLE setting_migrated RENAME TO setting;
        `);
      }
    } catch {}
    // Poll leases were added after the first relay schema shipped. SQLite does not support adding
    // more than one column in a single ALTER, so keep this deliberately small and idempotent.
    try {
      const cols = new Set(this.db.prepare('PRAGMA table_info(job)').all().map((c) => c.name));
      if (!cols.has('lease_token')) this.db.exec('ALTER TABLE job ADD COLUMN lease_token TEXT');
      if (!cols.has('lease_expires_at')) this.db.exec('ALTER TABLE job ADD COLUMN lease_expires_at INTEGER');
    } catch {}
  }

  close() {
    this.db.close();
  }

  /** Same method surface as D1Store, so the runner can await either adapter. */
  sha256(s) {
    return sha256(s);
  }

  upsertRows(shape, rows) {
    if (!SHAPES[shape]) throw new Error(`unknown shape ${shape}`);
    if (!rows.length) return 0;
    const { perStatement } = upsertSql(shape);
    for (let i = 0; i < rows.length; i += perStatement) {
      const slice = rows.slice(i, i + perStatement);
      const { sql } = upsertSql(shape, slice.length);
      this.db.prepare(sql).run(...slice.flatMap((row) => rowToParams(shape, row)));
    }
    return rows.length;
  }

  /**
   * Tombstone rows a source no longer reports, but only when the run was plausible and not
   * empty. Diffing happens in JS so no dialect-specific NOT IN gymnastics or bound-parameter
   * limits are involved.
   *
   * `scope` limits the sweep to the partition this run actually covered (`column` + `values`).
   * A run that only fetched today's menu must not be allowed to judge rows for tomorrow, because
   * "missing from this run" would then mean "belongs to another day", not "is gone".
   */
  tombstoneMissing(shape, sourceId, seenExternalIds, { column = null, values = [] } = {}) {
    const seen = new Set(seenExternalIds);
    const scoped = column && values.length > 0;
    const scopeWhere = scoped ? ` AND ${column} IN (${values.map(() => '?').join(',')})` : '';
    const existing = this.db
      .prepare(`SELECT external_id FROM ${shape} WHERE source_id=? AND deleted=0${scopeWhere}`)
      .all(sourceId, ...(scoped ? values : []))
      .map((r) => r.external_id);
    const stale = existing.filter((e) => !seen.has(e));
    if (!stale.length) return 0;
    const stmt = this.db.prepare(`UPDATE ${shape} SET deleted=1 WHERE source_id=? AND external_id=?`);
    for (const e of stale) stmt.run(sourceId, e);
    return stale.length;
  }

  rows(shape, { where = '', params = [], limit = 1000, orderBy = null } = {}) {
    const spec = SHAPES[shape];
    if (!spec) throw new Error(`unknown shape ${shape}`);
    if (orderBy && !['source_id', 'external_id', 'observed_at', 'valid_until', ...spec.cols].includes(orderBy)) {
      throw new Error(`invalid order column ${orderBy} for ${shape}`);
    }
    const ordering = orderBy ? ` ORDER BY ${orderBy} ASC, external_id ASC` : '';
    const sql = `SELECT * FROM ${shape} WHERE deleted=0 ${where ? `AND ${where}` : ''}${ordering} LIMIT ${Number(limit)}`;
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

  lastSuccessfulRun(sourceId) {
    const row = this.db
      .prepare(
        `SELECT * FROM source_run WHERE source_id = ? AND outcome IN ('ok', 'empty') ORDER BY id DESC LIMIT 1`,
      )
      .get(sourceId);
    return row ? { ...row, meta: JSON.parse(row.meta_json || '{}') } : null;
  }

  lastRun(sourceId) {
    const row = this.db.prepare('SELECT * FROM source_run WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(sourceId);
    return row ? { ...row, meta: JSON.parse(row.meta_json || '{}') } : null;
  }

  calendarChanges(since) {
    return this.db.prepare('SELECT payload_json FROM calendar_change WHERE observed_at >= ? ORDER BY observed_at DESC LIMIT 1000')
      .all(since).map(row => JSON.parse(row.payload_json));
  }

  /**
   * True when this exact body is already archived. The caller checks first, because gzipping a
   * 290 KB menu page on every poll is CPU a Worker does not have to spend: on Workers Free an
   * invocation gets 10 ms, and the body is identical between menu changes.
   */
  hasSnapshot(sha) {
    return Boolean(this.db.prepare('SELECT 1 AS x FROM raw_snapshot WHERE sha256=?').get(sha));
  }

  saveSnapshot({ sourceId, fetchedAt, contentType, body }) {
    const hash = sha256(body);
    if (this.hasSnapshot(hash)) return hash;
    this.db
      .prepare(
        `INSERT INTO raw_snapshot (sha256, source_id, fetched_at, content_type, body_gz)
         VALUES (?,?,?,?,?) ON CONFLICT (sha256) DO NOTHING`,
      )
      .run(hash, sourceId, fetchedAt, contentType, gzipSync(Buffer.from(body, 'utf8')));
    return hash;
  }

  /** Retention sweep for the run receipts. Returns how many rows went. */
  pruneRuns(beforeMs) {
    return this.db.prepare('DELETE FROM source_run WHERE finished_at < ?').run(beforeMs).changes;
  }

  pruneSnapshots(beforeMs) {
    return this.db.prepare(`DELETE FROM raw_snapshot WHERE fetched_at < ?
      AND NOT EXISTS (SELECT 1 FROM source_run WHERE body_sha256 = raw_snapshot.sha256)`).run(beforeMs).changes;
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
    return this.db.prepare('SELECT * FROM job WHERE next_due_at <= ? ORDER BY next_due_at').all(now).map(hideLeaseFields);
  }

  /**
   * Claim one source across every local process that can see this database. The conditional
   * upsert is the lock: two cron/manual callers may read the same due row, but only one can win
   * the lease update. A released token remains as the last generation, so a late completion can
   * still be rejected when a newer claim has superseded it.
   */
  claimSource(sourceId, { now = Date.now(), leaseMs = 2 * 60_000, leaseNow = now } = {}) {
    const token = randomUUID();
    const row = this.db.prepare(`
      INSERT INTO job (source_id, next_due_at, last_started_at, lease_token, lease_expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (source_id) DO UPDATE SET
        last_started_at=excluded.last_started_at,
        lease_token=excluded.lease_token,
        lease_expires_at=excluded.lease_expires_at
      WHERE job.lease_token IS NULL OR job.lease_expires_at IS NULL OR job.lease_expires_at <= ?
      RETURNING lease_token, last_started_at, lease_expires_at
    `).get(sourceId, now, now, token, leaseNow + Math.max(1, leaseMs), leaseNow);
    return row ? { token: row.lease_token, startedAt: row.last_started_at, expiresAt: row.lease_expires_at } : null;
  }

  sourceLeaseOwned(sourceId, token, now = Date.now()) {
    if (!token) return false;
    return Boolean(this.db.prepare(
      'SELECT 1 AS claimed FROM job WHERE source_id=? AND lease_token=? AND lease_expires_at > ?',
    ).get(sourceId, token, now));
  }

  releaseSource(sourceId, token, now = Date.now()) {
    if (!token) return false;
    return this.db.prepare(
      'UPDATE job SET lease_expires_at=? WHERE source_id=? AND lease_token=? AND lease_expires_at > ?',
    ).run(now, sourceId, token, now).changes > 0;
  }

  /**
   * Apply one complete poll while holding SQLite's write lock. The lease predicate is checked
   * after BEGIN IMMEDIATE, so a competing claim cannot slip between the check and any row,
   * tombstone, snapshot, or receipt write.
   */
  commitSourceResult({
    sourceId,
    leaseToken,
    leaseNow = Date.now(),
    shape,
    rows = [],
    seenExternalIds = [],
    tombstone = false,
    tombstoneScope = {},
    snapshot = null,
    calendarChanges = [],
    receipt,
  }) {
    if (!leaseToken) return { applied: false, written: 0, tombstones: 0 };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.sourceLeaseOwned(sourceId, leaseToken, leaseNow)) {
        this.db.exec('ROLLBACK');
        return { applied: false, written: 0, tombstones: 0 };
      }
      const written = rows.length ? this.upsertRows(shape, rows) : 0;
      if (calendarChanges.length) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO calendar_change (id, source_id, observed_at, payload_json) VALUES (?,?,?,?)');
        for (const change of calendarChanges) insert.run(change.id, sourceId, change.observed_at, JSON.stringify(change));
      }
      if (shape === 'timeline_event' && ['ok', 'empty'].includes(receipt.outcome)) {
        this.db.prepare('DELETE FROM calendar_change WHERE observed_at < ?').run(receipt.started_at - CHANGE_RETENTION_MS);
      }
      if (!this.sourceLeaseOwned(sourceId, leaseToken, Date.now())) {
        this.db.exec('ROLLBACK');
        return { applied: false, written: 0, tombstones: 0 };
      }
      const tombstones = tombstone
        ? this.tombstoneMissing(shape, sourceId, seenExternalIds, tombstoneScope)
        : 0;
      if (!this.sourceLeaseOwned(sourceId, leaseToken, Date.now())) {
        this.db.exec('ROLLBACK');
        return { applied: false, written: 0, tombstones: 0 };
      }
      if (snapshot?.body) this.saveSnapshot(snapshot);
      if (!this.sourceLeaseOwned(sourceId, leaseToken, Date.now())) {
        this.db.exec('ROLLBACK');
        return { applied: false, written: 0, tombstones: 0 };
      }
      receipt.rows_written = written;
      receipt.tombstones = tombstones;
      this.insertRun(receipt);
      if (!this.sourceLeaseOwned(sourceId, leaseToken, Date.now())) {
        this.db.exec('ROLLBACK');
        return { applied: false, written: 0, tombstones: 0 };
      }
      this.db.exec('COMMIT');
      return { applied: true, written, tombstones };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  scheduleJob(sourceId, nextDueAt) {
    this.db
      .prepare(
        `INSERT INTO job (source_id, next_due_at) VALUES (?,?)
         ON CONFLICT (source_id) DO UPDATE SET next_due_at=excluded.next_due_at`,
      )
      .run(sourceId, nextDueAt);
  }

  recordJobResult(sourceId, {
    startedAt,
    finishedAt,
    outcome,
    httpStatus = null,
    retryAfterMs = 0,
    cadenceMs,
    rateLimitMinMs = 30 * 60_000,
    rateLimitMaxMs = 48 * 60 * 60_000,
    now,
    claimToken = null,
  }) {
    const prev = this.db.prepare('SELECT * FROM job WHERE source_id=?').get(sourceId);
    // A caller that cannot prove ownership must never move a due time underneath an active poll.
    if (!claimToken && prev?.lease_token && (prev.lease_expires_at ?? 0) > now) {
      return { applied: false, failures: prev.consecutive_failures ?? 0, circuit: prev.circuit_state ?? 'closed', next_due_at: prev.next_due_at ?? null };
    }
    if (claimToken && (!prev || prev.lease_token !== claimToken || prev.last_started_at !== startedAt || (prev.lease_expires_at ?? 0) <= now)) {
      return { applied: false, failures: prev?.consecutive_failures ?? 0, circuit: prev?.circuit_state ?? 'closed', next_due_at: prev?.next_due_at ?? null };
    }
    const failures = ['ok', 'empty', 'skipped'].includes(outcome)
      ? 0
      : (prev?.consecutive_failures ?? 0) + 1;
    const circuit = failures >= 5 ? 'open' : 'closed';
    // Rate limits deserve a long quiet period. Repeated 429s double it, while Retry-After always
    // wins over our cap because the upstream explicitly told us when to try again.
    const backoff = httpStatus === 429
      ? Math.max(
        retryAfterMs || 0,
        Math.min(rateLimitMaxMs, Math.max(cadenceMs, rateLimitMinMs) * 2 ** Math.max(0, failures - 1)),
      )
      : Math.min(15 * 60 * 1000, 1000 * 2 ** Math.max(0, failures - 1));
    const next = circuit === 'open' || failures > 0
      ? now + backoff + Math.floor(Math.random() * 1000)
      : now + cadenceMs;
    if (claimToken) {
      const result = this.db.prepare(`
        UPDATE job SET next_due_at=?, last_started_at=?, last_finished_at=?, last_outcome=?,
          consecutive_failures=?, circuit_state=?
        WHERE source_id=? AND lease_token=? AND last_started_at=? AND lease_expires_at > ?
      `).run(next, startedAt, finishedAt, outcome, failures, circuit, sourceId, claimToken, startedAt, now);
      return { applied: result.changes > 0, failures, circuit, next_due_at: next };
    }
    this.db.prepare(`
      INSERT INTO job (source_id, next_due_at, last_started_at, last_finished_at, last_outcome, consecutive_failures, circuit_state)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (source_id) DO UPDATE SET
        next_due_at=excluded.next_due_at,
        last_started_at=excluded.last_started_at,
        last_finished_at=excluded.last_finished_at,
        last_outcome=excluded.last_outcome,
        consecutive_failures=excluded.consecutive_failures,
        circuit_state=excluded.circuit_state
    `).run(sourceId, next, startedAt, finishedAt, outcome, failures, circuit);
    return { applied: true, failures, circuit, next_due_at: next };
  }

  jobs() {
    return this.db.prepare('SELECT * FROM job ORDER BY source_id').all().map(hideLeaseFields);
  }

  /** Configuration rows set from the app, as { name, value, updated_at }. */
  settings() {
    return this.db.prepare('SELECT name, value, updated_at FROM setting ORDER BY name').all();
  }

  getSetting(name) {
    const row = this.db.prepare('SELECT value FROM setting WHERE name=?').get(name);
    return row ? row.value : null;
  }

  reserveAiBudget(day, amount, limit) {
    return this.db.prepare(`INSERT INTO ai_usage (day, reserved_neurons, calls)
      SELECT ?, ?, 1 WHERE ? <= ?
      ON CONFLICT(day) DO UPDATE SET reserved_neurons=ai_usage.reserved_neurons+excluded.reserved_neurons,
        calls=ai_usage.calls+1 WHERE ai_usage.reserved_neurons+excluded.reserved_neurons <= ?
      RETURNING reserved_neurons, calls`).get(day, amount, amount, limit, limit) ?? null;
  }

  aiUsage(day) {
    return this.db.prepare('SELECT reserved_neurons, calls FROM ai_usage WHERE day=?').get(day) ?? null;
  }

  setSetting(name, value, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO setting (name, value, updated_at) VALUES (?,?,?)
         ON CONFLICT (name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(name, value, now);
    return { name, updated_at: now };
  }

  compareAndSetSetting(name, expected, value, now = Date.now()) {
    if (expected == null) {
      return this.db.prepare('INSERT OR IGNORE INTO setting (name, value, updated_at) VALUES (?,?,?)').run(name, value, now).changes > 0;
    }
    return this.db.prepare('UPDATE setting SET value=?, updated_at=? WHERE name=? AND value=?').run(value, now, name, expected).changes > 0;
  }

  deleteSetting(name) {
    return this.db.prepare('DELETE FROM setting WHERE name=?').run(name).changes;
  }
}

export { SHAPES, SHAPE_COLUMNS, ddl, rowToParams, paramsToRow, CHUNK };
