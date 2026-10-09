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
import { SHAPES, ddlStatements, rowToParams, paramsToRow, upsertSql, TABLES, INDEXES, CHUNK,
  RECEIPTS_PER_SOURCE, receiptLookup } from './schema.mjs';
import { CHANGE_RETENTION_MS } from './calendar-changes.mjs';
import { nextJobResult } from './retry.mjs';

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

function hideLeaseFields(row) {
  if (!row) return row;
  for (const key of ['lease_token', 'lease_expires_at']) {
    if (!(key in row)) continue;
    const value = row[key];
    Object.defineProperty(row, key, { value, enumerable: false, configurable: true, writable: true });
  }
  return row;
}

/** Both receipt readers share the row shape, the meta parsing and the lookup fallback. */
function parseRuns(res) {
  return (res.results || []).map((r) => ({ ...r, meta: JSON.parse(r.meta_json || '{}') }));
}

export class D1Store {
  /** @param {D1Database} d1 Cloudflare D1 database binding (env.DB) */
  constructor(d1) {
    if (!d1) throw new Error('D1Store requires a Cloudflare D1 database binding');
    this.db = d1;
    this._initPromise = null;
  }

  /**
   * DDL, idempotent and run at most once per isolate, behind a schema probe.
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
        if (Number(row?.n ?? 0) !== expected.length) {
          // Prepared one statement at a time and batched: D1's exec() runs a statement per line, so a
          // CREATE TABLE wrapped across lines arrives truncated.
          await this.db.batch(ddlStatements().map((sql) => this.db.prepare(sql)));
        }
        // Existing D1 databases may have the job table from before source leases were added, even
        // when another table or index was also missing. This probe therefore follows both the
        // fresh DDL and the self-healing DDL path.
        const columns = await this.db.prepare('PRAGMA table_info(job)').all();
        const names = new Set((columns.results || []).map((column) => column.name));
        const migrations = [];
        if (!names.has('lease_token')) migrations.push(this.db.prepare('ALTER TABLE job ADD COLUMN lease_token TEXT'));
        if (!names.has('lease_expires_at')) migrations.push(this.db.prepare('ALTER TABLE job ADD COLUMN lease_expires_at INTEGER'));
        if (migrations.length) {
          try {
            await this.db.batch(migrations);
          } catch (error) {
            // Two cold isolates can observe the same old schema. One may add the columns while
            // the other is preparing its batch; accept that race only once both columns exist.
            const after = await this.db.prepare('PRAGMA table_info(job)').all();
            const finalNames = new Set((after.results || []).map((column) => column.name));
            if (!finalNames.has('lease_token') || !finalNames.has('lease_expires_at')) throw error;
          }
        }
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
        JSON.stringify({ ...run.meta, ...(run.retry_after_ms > 0 ? { retry_after_ms: run.retry_after_ms } : {}) }),
      )
      .run();
    return true;
  }

  async recentRuns(limit = 20) {
    const res = await this.db.prepare('SELECT * FROM source_run ORDER BY id DESC LIMIT ?').bind(limit).all();
    return (res.results || []).map((r) => ({ ...r, meta: JSON.parse(r.meta_json || '{}') }));
  }

  /**
   * Run the named lookup, or the exhaustive query when the caller named nothing usable.
   *
   * The lookup is a list of statements because D1 caps a compound SELECT at five terms: naming the
   * six real sources costs two queries (5 + 1), still an index seek each and no scan.
   */
  async receiptRows(lookup, fallbackSql) {
    if (!lookup) return parseRuns(await this.db.prepare(fallbackSql).all());
    const rows = [];
    for (const statement of lookup) {
      rows.push(...parseRuns(await this.db.prepare(statement.sql).bind(...statement.params).all()));
    }
    return rows;
  }

  /**
   * Latest receipt per source.
   *
   * Named sources are looked up through `idx_source_run_source_id (source_id, id DESC)`: one index
   * seek each, so a dashboard read that asks about six sources reads six rows instead of scanning
   * the ten thousand receipts in the retention window. `receiptLookup` returns null when the caller
   * named nothing usable, and the exhaustive query runs instead - correct, and it is what the CLI
   * and the tests use where no one is billed per row read.
   */
  async lastRunPerSource(sourceIds = null) {
    return this.receiptRows(receiptLookup(sourceIds), RECEIPTS_PER_SOURCE.latest);
  }

  async lastSuccessfulRunPerSource(sourceIds = null) {
    return this.receiptRows(receiptLookup(sourceIds, { successful: true }), RECEIPTS_PER_SOURCE.successful);
  }

  async lastSuccessfulRun(sourceId) {
    const row = await this.db
      .prepare(`SELECT * FROM source_run WHERE source_id = ? AND outcome IN ('ok', 'empty') ORDER BY id DESC LIMIT 1`)
      .bind(sourceId)
      .first();
    return row ? { ...row, meta: JSON.parse(row.meta_json || '{}') } : null;
  }

  async lastRun(sourceId) {
    const row = await this.db
      .prepare('SELECT * FROM source_run WHERE source_id = ? ORDER BY id DESC LIMIT 1')
      .bind(sourceId)
      .first();
    return row ? { ...row, meta: JSON.parse(row.meta_json || '{}') } : null;
  }

  async calendarChanges(since) {
    const result = await this.db.prepare('SELECT payload_json FROM calendar_change WHERE observed_at >= ? ORDER BY observed_at DESC LIMIT 1000').bind(since).all();
    return (result.results || []).map(row => JSON.parse(row.payload_json));
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
    return (res.results || []).map(hideLeaseFields);
  }

  /** Atomically claim a source so cron, manual requests and separate Worker invocations serialize. */
  async claimSource(sourceId, { now = Date.now(), leaseMs = 2 * 60_000, leaseNow = now, expectedJob = undefined } = {}) {
    const token = crypto.randomUUID();
    const fence = expectedJob === undefined ? '' : expectedJob === null ? ' AND 0' :
      ' AND job.next_due_at IS ? AND job.last_started_at IS ? AND job.last_finished_at IS ? AND job.lease_token IS ?';
    const generation = expectedJob ? [expectedJob.next_due_at, expectedJob.last_started_at ?? null,
      expectedJob.last_finished_at ?? null, expectedJob.lease_token ?? null] : [];
    const row = await this.db.prepare(`
      INSERT INTO job (source_id, next_due_at, last_started_at, lease_token, lease_expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (source_id) DO UPDATE SET
        last_started_at=excluded.last_started_at,
        lease_token=excluded.lease_token,
        lease_expires_at=excluded.lease_expires_at
      WHERE (job.lease_token IS NULL OR job.lease_expires_at IS NULL OR job.lease_expires_at <= ?)${fence}
      RETURNING lease_token, last_started_at, lease_expires_at
    `).bind(sourceId, now, now, token, leaseNow + Math.max(1, leaseMs), leaseNow, ...generation).first();
    return row ? { token: row.lease_token, startedAt: row.last_started_at, expiresAt: row.lease_expires_at } : null;
  }

  async sourceLeaseOwned(sourceId, token, now = Date.now()) {
    if (!token) return false;
    const row = await this.db.prepare(
      'SELECT 1 AS claimed FROM job WHERE source_id=? AND lease_token=? AND lease_expires_at > ?',
    ).bind(sourceId, token, now).first();
    return Boolean(row);
  }

  async releaseSource(sourceId, token, now = Date.now()) {
    if (!token) return false;
    const result = await this.db.prepare(
      'UPDATE job SET lease_expires_at=? WHERE source_id=? AND lease_token=? AND lease_expires_at > ?',
    ).bind(now, sourceId, token, now).run();
    return (result?.meta?.changes ?? 0) > 0;
  }

  /**
   * Apply a poll as one D1 batch. Every write carries the lease predicate, and D1 batches execute
   * in one SQLite transaction, so a newer claim cannot interleave between the upsert, sweep,
   * snapshot, and receipt.
   */
  async commitSourceResult({
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
    const statements = [];
    const lease = 'EXISTS (SELECT 1 FROM job WHERE source_id=? AND lease_token=? AND lease_expires_at>?)';
    const spec = SHAPES[shape];
    if (!spec) throw new Error(`unknown shape ${shape}`);

    if (calendarChanges.length) {
      statements.push(this.db.prepare(`INSERT OR IGNORE INTO calendar_change (id, source_id, observed_at, payload_json)
        SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.observed_at'), value FROM json_each(?) WHERE ${lease}`)
        .bind(sourceId, JSON.stringify(calendarChanges), sourceId, leaseToken, leaseNow));
    }
    if (shape === 'timeline_event' && ['ok', 'empty'].includes(receipt.outcome)) {
      statements.push(this.db.prepare(`DELETE FROM calendar_change WHERE observed_at < ? AND ${lease}`)
        .bind(receipt.started_at - CHANGE_RETENTION_MS, sourceId, leaseToken, leaseNow));
    }

    if (rows.length) {
      const { cols } = upsertSql(shape);
      // The lease predicate contributes three bound values to every statement. Keep the row
      // tuples under D1's 100-parameter limit after those guard values are included.
      const perStatement = Math.max(1, Math.floor((100 - 3) / cols.length));
      const projection = cols.map((_, index) => `column${index + 1}`).join(',');
      const updates = cols
        .filter((column) => column !== 'source_id' && column !== 'external_id')
        .map((column) => `${column}=excluded.${column}`)
        .join(', ');
      for (let i = 0; i < rows.length; i += perStatement) {
        const slice = rows.slice(i, i + perStatement);
        const tuple = `(${cols.map(() => '?').join(',')})`;
        const values = Array.from({ length: slice.length }, () => tuple).join(',');
        const sql = `INSERT INTO ${shape} (${cols.join(',')})
          SELECT ${projection} FROM (VALUES ${values})
          WHERE ${lease}
          ON CONFLICT (source_id, external_id) DO UPDATE SET ${updates}, deleted=0`;
        statements.push(this.db.prepare(sql).bind(
          ...slice.flatMap((row) => rowToParams(shape, row)),
          sourceId,
          leaseToken,
          leaseNow,
        ));
      }
    }

    let tombstoneIndex = -1;
    if (tombstone) {
      const { column = null, values = [] } = tombstoneScope;
      const scoped = column && values.length > 0;
      const scopeWhere = scoped ? ` AND ${column} IN (${values.map(() => '?').join(',')})` : '';
      // json_each keeps the tombstone statement below D1's bound parameter limit even when a
      // calendar source reports hundreds of IDs. The JSON extension is part of D1's SQLite build.
      const sql = `UPDATE ${shape} SET deleted=1
        WHERE source_id=? AND deleted=0${scopeWhere}
          AND external_id NOT IN (SELECT value FROM json_each(?))
          AND ${lease}`;
      statements.push(this.db.prepare(sql).bind(
        sourceId,
        ...(scoped ? values : []),
        JSON.stringify(seenExternalIds),
        sourceId,
        leaseToken,
        leaseNow,
      ));
      tombstoneIndex = statements.length - 1;
    }

    let snapshotIndex = -1;
    if (snapshot && snapshot.body != null) {
      const hash = await sha256Hex(snapshot.body);
      // Avoid compressing an unchanged body on every poll. The guarded INSERT is still used
      // when the hash is new, so a lease cannot be lost between this probe and the batch write.
      if (!(await this.hasSnapshot(hash))) {
        const bodyGz = await gzipBytes(snapshot.body);
        const sql = `INSERT INTO raw_snapshot (sha256, source_id, fetched_at, content_type, body_gz)
          SELECT ?,?,?,?,? WHERE ${lease}
          ON CONFLICT (sha256) DO NOTHING`;
        statements.push(this.db.prepare(sql).bind(
          hash,
          snapshot.sourceId ?? sourceId,
          snapshot.fetchedAt,
          snapshot.contentType ?? '',
          bodyGz,
          sourceId,
          leaseToken,
          leaseNow,
        ));
        snapshotIndex = statements.length - 1;
      }
    }

    const receiptSql = `INSERT INTO source_run
      (source_id, started_at, finished_at, outcome, http_status, bytes, rows_written, error, body_sha256, meta_json)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${lease}`;
    statements.push(this.db.prepare(receiptSql).bind(
      receipt.source_id,
      receipt.started_at,
      receipt.finished_at,
      receipt.outcome,
      receipt.http_status ?? null,
      receipt.bytes ?? 0,
      rows.length,
      receipt.error ?? '',
      receipt.body_sha256 ?? '',
      JSON.stringify({ ...receipt.meta, ...(receipt.retry_after_ms > 0 ? { retry_after_ms: receipt.retry_after_ms } : {}) }),
      sourceId,
      leaseToken,
      leaseNow,
    ));
    const receiptIndex = statements.length - 1;
    const results = await this.db.batch(statements);
    const applied = (results[receiptIndex]?.meta?.changes ?? 0) > 0;
    const written = applied ? rows.length : 0;
    const tombstones = applied && tombstoneIndex >= 0 ? (results[tombstoneIndex]?.meta?.changes ?? 0) : 0;
    receipt.rows_written = written;
    receipt.tombstones = tombstones;
    return { applied, written, tombstones, snapshot: snapshotIndex >= 0 };
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

  async repairJob(sourceId, nextDueAt, { expectedNextDueAt = null, expectedStartedAt = null,
    expectedFinishedAt = null, now = Date.now() } = {}) {
    const result = expectedNextDueAt == null
      ? await this.db.prepare('INSERT INTO job (source_id, next_due_at) VALUES (?,?) ON CONFLICT DO NOTHING')
        .bind(sourceId, nextDueAt).run()
      : await this.db.prepare(`UPDATE job SET next_due_at=? WHERE source_id=? AND next_due_at=?
          AND last_started_at IS ? AND last_finished_at IS ?
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
        .bind(nextDueAt, sourceId, expectedNextDueAt, expectedStartedAt, expectedFinishedAt, now).run();
    return (result?.meta?.changes ?? 0) > 0;
  }

  async recordJobResult(sourceId, {
    startedAt,
    finishedAt,
    outcome,
    httpStatus = null,
    retryAfterMs = 0,
    meta = {},
    minimumRefreshMs = 0,
    cadenceMs,
    rateLimitMinMs = 30 * 60_000,
    rateLimitMaxMs = 48 * 60 * 60_000,
    now,
    claimToken = null,
    interrupted = false,
  }) {
    const prev = await this.db.prepare('SELECT * FROM job WHERE source_id=?').bind(sourceId).first();
    if (!claimToken && prev?.lease_token && (prev.lease_expires_at ?? 0) > now) {
      return { applied: false, failures: prev.consecutive_failures ?? 0, circuit: prev.circuit_state ?? 'closed', next_due_at: prev.next_due_at ?? null };
    }
    if (claimToken && (!prev || prev.lease_token !== claimToken || prev.last_started_at !== startedAt || (!interrupted && (prev.lease_expires_at ?? 0) <= now))) {
      return { applied: false, failures: prev?.consecutive_failures ?? 0, circuit: prev?.circuit_state ?? 'closed', next_due_at: prev?.next_due_at ?? null };
    }
    const policy = nextJobResult(prev, { outcome, meta, httpStatus, retryAfterMs, cadenceMs,
      minimumRefreshMs, rateLimitMinMs, rateLimitMaxMs, now });
    const { failures, circuit, next_due_at: next } = policy;
    outcome = policy.outcome;
    if (claimToken) {
      const result = await this.db.prepare(`
        UPDATE job SET next_due_at=?, last_started_at=?, last_finished_at=?, last_outcome=?,
          consecutive_failures=?, circuit_state=?
        WHERE source_id=? AND lease_token=? AND last_started_at=?
          AND ((?=0 AND lease_expires_at > ?) OR (?=1 AND lease_expires_at <= ?))
      `).bind(next, startedAt, finishedAt, outcome, failures, circuit, sourceId, claimToken, startedAt, Number(interrupted), now, Number(interrupted), now).run();
      return { applied: (result?.meta?.changes ?? 0) > 0, failures, circuit, next_due_at: next };
    }
    const result = await this.db.prepare(`
      INSERT INTO job (source_id, next_due_at, last_started_at, last_finished_at, last_outcome, consecutive_failures, circuit_state)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (source_id) DO UPDATE SET
        next_due_at=excluded.next_due_at,
        last_started_at=excluded.last_started_at,
        last_finished_at=excluded.last_finished_at,
        last_outcome=excluded.last_outcome,
        consecutive_failures=excluded.consecutive_failures,
        circuit_state=excluded.circuit_state
      WHERE job.lease_expires_at IS NULL OR job.lease_expires_at <= ?
    `).bind(sourceId, next, startedAt, finishedAt, outcome, failures, circuit, now).run();
    return { applied: (result?.meta?.changes ?? 0) > 0, failures, circuit, next_due_at: next };
  }

  async jobs() {
    const res = await this.db.prepare('SELECT * FROM job ORDER BY source_id').all();
    return (res.results || []).map(hideLeaseFields);
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

  async compareAndSetSetting(name, expected, value, now = Date.now()) {
    const result = expected == null
      ? await this.db.prepare('INSERT OR IGNORE INTO setting (name, value, updated_at) VALUES (?,?,?)').bind(name, value, now).run()
      : await this.db.prepare('UPDATE setting SET value=?, updated_at=? WHERE name=? AND value=?').bind(value, now, name, expected).run();
    return (result?.meta?.changes ?? 0) > 0;
  }

  async deleteSetting(name) {
    const res = await this.db.prepare('DELETE FROM setting WHERE name=?').bind(name).run();
    return res?.meta?.changes ?? 0;
  }
}
