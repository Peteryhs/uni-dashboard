/**
 * Cloudflare D1 storage adapter.
 *
 * Same storage contract as SqliteStore (same methods, same shapes, same DDL), so the runner, the
 * card builders and the HTTP layer cannot tell which one they are talking to. Two deliberate
 * differences, both forced by the platform:
 *
 *  - every method is async (D1 is a network call to a SQLite database, not an in-process handle)
 *  - hashing and compression use Web Crypto and CompressionStream, because a Worker bundle cannot
 *    resolve `node:sqlite`, and pulling `node:crypto`/`node:zlib` in buys nothing here
 *
 * The pure parts (shapes, DDL, row converters, batch size) come from `schema.mjs`.
 */
import { SHAPES, ddlStatements, rowToParams, paramsToRow, upsertSql, TABLES, INDEXES, CHUNK } from './schema.mjs';

/** Web Crypto sha256, hex encoded. Same value the Node adapter produces for the same bytes. */
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function gzipBytes(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export class D1Store {
  /** @param {D1Database} d1 Cloudflare D1 database binding (env.DB) */
  constructor(d1) {
    if (!d1) throw new Error('D1Store requires a Cloudflare D1 database binding');
    this.db = d1;
    this._initPromise = null;
  }

  /**
   * DDL, idempotent and run at most once per isolate, behind a single probe.
   *
   * The probe compares the tables this schema expects against `sqlite_master`, and the DDL runs only
   * when one is missing. Two reasons it is a count and not a lookup of one known table: a cron
   * invocation gets a fresh isolate, so paying ten CREATE statements every 15 minutes would spend a
   * fifth of the free tier's 50-query budget before any work happens; and a database created by an
   * older version has to pick up a table added later, which a single-table probe would never notice.
   */
  async init() {
    if (!this._initPromise) {
      this._initPromise = (async () => {
        const expected = [...TABLES, ...INDEXES];
        const placeholders = expected.map(() => '?').join(',');
        const row = await this.db
          .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN (${placeholders})`)
          .bind(...expected)
          .first();
        if (Number(row?.n ?? 0) === expected.length) return;
        // Prepared one statement at a time and batched: D1's exec() runs a statement per line, so a
        // CREATE TABLE wrapped across lines arrives truncated.
        await this.db.batch(ddlStatements().map((sql) => this.db.prepare(sql)));
      })();
    }
    return this._initPromise;
  }

  async sha256(s) {
    return sha256Hex(s);
  }

  async upsertRows(shape, rows) {
    if (!SHAPES[shape]) throw new Error(`unknown shape ${shape}`);
    if (!rows.length) return 0;
    const { perStatement } = upsertSql(shape);

    // One statement per group of rows, and the groups batched. A statement per row would spend a
    // Worker's whole 50-query D1 budget on a single day of menus.
    const stmts = [];
    for (let i = 0; i < rows.length; i += perStatement) {
      const slice = rows.slice(i, i + perStatement);
      const { sql } = upsertSql(shape, slice.length);
      stmts.push(this.db.prepare(sql).bind(...slice.flatMap((row) => rowToParams(shape, row))));
    }
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await this.db.batch(stmts.slice(i, i + CHUNK));
    }
    return rows.length;
  }

  /**
   * Tombstone the rows a source no longer reports, scoped to the partition this run covered so a
   * poll for one date cannot delete another date's rows. Diffing happens in JS, same as the Node
   * adapter, so neither dialect needs NOT IN gymnastics.
   */
  async tombstoneMissing(shape, sourceId, seenExternalIds, { column = null, values = [] } = {}) {
    const seen = new Set(seenExternalIds);
    const scoped = column && values.length > 0;
    const scopeWhere = scoped ? ` AND ${column} IN (${values.map(() => '?').join(',')})` : '';
    const res = await this.db
      .prepare(`SELECT external_id FROM ${shape} WHERE source_id=? AND deleted=0${scopeWhere}`)
      .bind(sourceId, ...(scoped ? values : []))
      .all();
    const existing = (res.results || []).map((r) => r.external_id);
    const stale = existing.filter((e) => !seen.has(e));
    if (!stale.length) return 0;

    // One statement per vanished event can exhaust the Free plan's query budget when a
    // calendar series is cancelled. Keep each statement under D1's 100 bound parameters.
    const stmts = [];
    for (let i = 0; i < stale.length; i += 90) {
      const ids = stale.slice(i, i + 90);
      const placeholders = ids.map(() => '?').join(',');
      stmts.push(
        this.db.prepare(`UPDATE ${shape} SET deleted=1 WHERE source_id=? AND external_id IN (${placeholders})`)
          .bind(sourceId, ...ids),
      );
    }
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await this.db.batch(stmts.slice(i, i + CHUNK));
    }
    return stale.length;
  }

  async rows(shape, { where = '', params = [], limit = 1000, orderBy = null } = {}) {
    const spec = SHAPES[shape];
    if (!spec) throw new Error(`unknown shape ${shape}`);
    if (orderBy && !['source_id', 'external_id', 'observed_at', 'valid_until', ...spec.cols].includes(orderBy)) {
      throw new Error(`invalid order column ${orderBy} for ${shape}`);
    }
    const ordering = orderBy ? ` ORDER BY ${orderBy} ASC, external_id ASC` : '';
    const sql = `SELECT * FROM ${shape} WHERE deleted=0 ${where ? `AND ${where}` : ''}${ordering} LIMIT ${Number(limit)}`;
    const res = await this.db.prepare(sql).bind(...params).all();
    return (res.results || []).map((r) => paramsToRow(shape, r));
  }

  async insertRun(run) {
    await this.db
      .prepare(
        `INSERT INTO source_run (source_id, started_at, finished_at, outcome, http_status, bytes, rows_written, error, body_sha256, meta_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
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
      )
      .run();
    return true;
  }

  async recentRuns(limit = 20) {
    const res = await this.db.prepare('SELECT * FROM source_run ORDER BY id DESC LIMIT ?').bind(limit).all();
    return (res.results || []).map((r) => ({ ...r, meta: JSON.parse(r.meta_json || '{}') }));
  }

  async lastRunPerSource() {
    const res = await this.db
      .prepare(
        `SELECT r.* FROM job j JOIN source_run r ON r.id =
          (SELECT id FROM source_run WHERE source_id=j.source_id ORDER BY id DESC LIMIT 1)`,
      )
      .all();
    return (res.results || []).map((r) => ({ ...r, meta: JSON.parse(r.meta_json || '{}') }));
  }

  async lastSuccessfulRun(sourceId) {
    const row = await this.db
      .prepare(`SELECT * FROM source_run WHERE source_id = ? AND outcome IN ('ok', 'empty') ORDER BY id DESC LIMIT 1`)
      .bind(sourceId)
      .first();
    return row ? { ...row, meta: JSON.parse(row.meta_json || '{}') } : null;
  }

  /**
   * True when this exact body is already archived, so the caller can skip the gzip. Compressing a
   * 290 KB menu page on every poll is CPU a Worker does not have: 10 ms per invocation on Free,
   * and the body does not change between menu updates.
   */
  async hasSnapshot(sha) {
    const row = await this.db.prepare('SELECT 1 AS x FROM raw_snapshot WHERE sha256=?').bind(sha).first();
    return Boolean(row);
  }

  async saveSnapshot({ sourceId, fetchedAt, contentType, body }) {
    const hash = await sha256Hex(body);
    if (await this.hasSnapshot(hash)) return hash;
    const gz = await gzipBytes(body);
    await this.db
      .prepare(
        `INSERT INTO raw_snapshot (sha256, source_id, fetched_at, content_type, body_gz)
         VALUES (?,?,?,?,?) ON CONFLICT (sha256) DO NOTHING`,
      )
      .bind(hash, sourceId, fetchedAt, contentType, gz)
      .run();
    return hash;
  }

  /** Retention sweep for the run receipts. Returns how many rows went. */
  async pruneRuns(beforeMs) {
    const res = await this.db.prepare('DELETE FROM source_run WHERE finished_at < ?').bind(beforeMs).run();
    return res?.meta?.changes ?? 0;
  }

  async pruneSnapshots(beforeMs) {
    const res = await this.db.prepare(`DELETE FROM raw_snapshot WHERE fetched_at < ?
      AND NOT EXISTS (SELECT 1 FROM source_run WHERE body_sha256 = raw_snapshot.sha256)`).bind(beforeMs).run();
    return res?.meta?.changes ?? 0;
  }

  async getSnapshot(sha) {
    const r = await this.db.prepare('SELECT * FROM raw_snapshot WHERE sha256=?').bind(sha).first();
    if (!r) return null;
    return { ...r, body: await gunzipText(r.body_gz) };
  }

  async snapshotCount() {
    const r = await this.db.prepare('SELECT COUNT(*) AS n FROM raw_snapshot').first();
    return r?.n ?? 0;
  }

  async dueJobs(now) {
    const res = await this.db.prepare('SELECT * FROM job WHERE next_due_at <= ? ORDER BY next_due_at').bind(now).all();
    return res.results || [];
  }

  async scheduleJob(sourceId, nextDueAt) {
    await this.db
      .prepare(
        `INSERT INTO job (source_id, next_due_at) VALUES (?,?)
         ON CONFLICT (source_id) DO UPDATE SET next_due_at=excluded.next_due_at`,
      )
      .bind(sourceId, nextDueAt)
      .run();
  }

  async recordJobResult(sourceId, {
    startedAt,
    finishedAt,
    outcome,
    httpStatus = null,
    retryAfterMs = 0,
    cadenceMs,
    rateLimitMinMs = 30 * 60_000,
    rateLimitMaxMs = 48 * 60 * 60_000,
    now,
  }) {
    const prev = await this.db.prepare('SELECT * FROM job WHERE source_id=?').bind(sourceId).first();
    const failures = ['ok', 'empty', 'skipped'].includes(outcome)
      ? 0
      : (prev?.consecutive_failures ?? 0) + 1;
    const circuit = failures >= 5 ? 'open' : 'closed';
    const backoff = httpStatus === 429
      ? Math.max(
        retryAfterMs || 0,
        Math.min(rateLimitMaxMs, Math.max(cadenceMs, rateLimitMinMs) * 2 ** Math.max(0, failures - 1)),
      )
      : Math.min(15 * 60 * 1000, 1000 * 2 ** Math.max(0, failures - 1));
    const next = circuit === 'open' || failures > 0
      ? now + backoff + Math.floor(Math.random() * 1000)
      : now + cadenceMs;
    await this.db
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
      .bind(sourceId, next, startedAt, finishedAt, outcome, failures, circuit)
      .run();
    return { failures, circuit, next_due_at: next };
  }

  async jobs() {
    const res = await this.db.prepare('SELECT * FROM job ORDER BY source_id').all();
    return res.results || [];
  }

  /** Configuration rows set from the app, as { name, value, updated_at }. */
  async settings() {
    const res = await this.db.prepare('SELECT name, value, updated_at FROM setting ORDER BY name').all();
    return res.results || [];
  }

  async getSetting(name) {
    const row = await this.db.prepare('SELECT value FROM setting WHERE name=?').bind(name).first();
    return row ? row.value : null;
  }

  async reserveAiBudget(day, amount, limit) {
    return this.db.prepare(`INSERT INTO ai_usage (day, reserved_neurons, calls)
      SELECT ?, ?, 1 WHERE ? <= ?
      ON CONFLICT(day) DO UPDATE SET reserved_neurons=ai_usage.reserved_neurons+excluded.reserved_neurons,
        calls=ai_usage.calls+1 WHERE ai_usage.reserved_neurons+excluded.reserved_neurons <= ?
      RETURNING reserved_neurons, calls`).bind(day, amount, amount, limit, limit).first();
  }

  async aiUsage(day) {
    return this.db.prepare('SELECT reserved_neurons, calls FROM ai_usage WHERE day=?').bind(day).first();
  }

  async setSetting(name, value, now = Date.now()) {
    await this.db
      .prepare(
        `INSERT INTO setting (name, value, updated_at) VALUES (?,?,?)
         ON CONFLICT (name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .bind(name, value, now)
      .run();
    return { name, updated_at: now };
  }

  async deleteSetting(name) {
    const res = await this.db.prepare('DELETE FROM setting WHERE name=?').bind(name).run();
    return res?.meta?.changes ?? 0;
  }
}
