/**
 * The runner: fetch, decide whether to trust it, parse, validate at the boundary, write, and
 * record a receipt. One function, used by the scheduler and by the on-demand endpoint, so a
 * manual poll and a scheduled poll cannot drift apart.
 *
 * The order matters. Plausibility is checked before parsing, and tombstones only happen after a
 * run that both passed plausibility and was not valid-empty. That single rule is what stops a
 * login page from deleting a timetable.
 */
import { validateRows } from '#contract/canonical.mjs';
import { parseRetryAfter } from './retry.mjs';

/**
 * A calendar can legitimately run out of upcoming events at the end of a term. A zero-row
 * response is suspicious when the store still has an active future event for the same source,
 * though: it means a previously populated feed disappeared while its saved data says there is
 * still something ahead. Source adapters opt into this check because status feeds and daily menu
 * pages have different meanings for an empty response.
 */
async function unexpectedEmpty(source, store, now, parsed) {
  if (!source.failOnEmptyWhenFutureRows || typeof store?.rows !== 'function') return null;
  // A feed that explicitly marks every event as cancelled is a trustworthy empty response. The
  // ICS adapter uses this to remove cancelled events while still protecting against a vanished
  // subscription that simply stops returning its previously saved future rows.
  const eventCount = Number(parsed?.meta?.events ?? 0);
  const cancelledCount = Number(parsed?.meta?.cancelled ?? 0);
  if (eventCount > 0 && cancelledCount >= eventCount) return null;

  let futureRows;
  try {
    futureRows = (await store.rows(source.shape, {
      where: 'source_id = ? AND starts_at > ?',
      params: [source.id, now],
      limit: 1,
    })) ?? [];
  } catch (error) {
    return {
      reason: `could not verify saved future rows after empty feed: ${error.message}`,
      futureRows: null,
    };
  }

  if (!futureRows.length) return null;
  return {
    reason: 'feed returned no rows while saved future calendar events remain',
    futureRows: true,
  };
}

export async function runSource(source, store, { now = Date.now(), date = null, dryRun = false } = {}) {
  const startedAt = now;
  const ctx = { now, date, store };
  const receipt = {
    source_id: source.id,
    started_at: startedAt,
    finished_at: startedAt,
    outcome: 'failed',
    http_status: null,
    bytes: 0,
    rows_written: 0,
    error: '',
    meta: {},
    body_sha256: '',
    tombstones: 0,
    retry_after_ms: 0,
  };

  let raw;
  try {
    raw = await source.fetchRaw(ctx);
  } catch (e) {
    receipt.error = `fetch threw: ${e.message}`;
    receipt.finished_at = Date.now();
    if (!dryRun) await store.insertRun(receipt);
    return receipt;
  }

  receipt.http_status = raw.status || null;
  receipt.bytes = raw.bytes ?? 0;
  receipt.retry_after_ms = Number.isFinite(raw.retryAfterMs)
    ? Math.max(0, raw.retryAfterMs)
    : parseRetryAfter(raw.retryAfter, now);
  receipt.body_sha256 = raw.body ? await store.sha256(raw.body) : '';

  const verdict = source.plausible(raw);
  if (!verdict.ok) {
    // Three different meanings, three different outcomes: no credentials, wrong content, and
    // "the page is fine, it just has nothing for this date". Only the last one is normal, and it
    // must not count towards the circuit breaker.
    receipt.outcome = verdict.skipped
      ? 'skipped'
      : verdict.credential
        ? 'implausible'
        : verdict.empty
          ? 'empty'
          : 'failed';
    receipt.error = verdict.reason;
    receipt.meta = {
      plausible: false,
      credential: Boolean(verdict.credential),
      empty: Boolean(verdict.empty),
    };
    receipt.finished_at = Date.now();
    if (!dryRun) {
      await store.insertRun(receipt);
      if (raw.body) await store.saveSnapshot({ sourceId: source.id, fetchedAt: now, contentType: raw.contentType, body: raw.body });
    }
    return receipt;
  }

  let parsed;
  try {
    parsed = source.parse(raw, ctx);
  } catch (e) {
    receipt.outcome = 'failed';
    receipt.error = `parse threw: ${e.message}`;
    receipt.finished_at = Date.now();
    if (!dryRun) {
      await store.insertRun(receipt);
      await store.saveSnapshot({ sourceId: source.id, fetchedAt: now, contentType: raw.contentType, body: raw.body });
    }
    return receipt;
  }

  let rows;
  try {
    rows = validateRows(source.shape, parsed.rows ?? []);
  } catch (e) {
    receipt.outcome = 'failed';
    receipt.error = `contract rejected rows: ${e.message}`;
    receipt.finished_at = Date.now();
    if (!dryRun) {
      await store.insertRun(receipt);
      await store.saveSnapshot({ sourceId: source.id, fetchedAt: now, contentType: raw.contentType, body: raw.body });
    }
    return receipt;
  }

  receipt.meta = parsed.meta ?? {};
  receipt.rows_parsed = rows.length;

  if (rows.length === 0) {
    const emptyCheck = await unexpectedEmpty(source, store, now, parsed);
    if (emptyCheck) {
      // Keep the old rows and surface this as a real failure. The normal empty path below may
      // tombstone rows for sources that explicitly allow it, so this check must happen first.
      receipt.outcome = 'failed';
      receipt.error = emptyCheck.reason;
      receipt.meta = {
        ...receipt.meta,
        empty: true,
        empty_feed: 'unexpected',
        saved_future_rows: emptyCheck.futureRows,
      };
      receipt.finished_at = Date.now();
      if (!dryRun) {
        await store.insertRun(receipt);
        await store.saveSnapshot({ sourceId: source.id, fetchedAt: now, contentType: raw.contentType, body: raw.body });
      }
      return receipt;
    }

    // Valid-empty: an empty future menu day, a calendar whose upcoming events have naturally
    // exhausted, or a status page saying everything is fine.
    let tombstones = 0;
    const tombstoneOnEmpty = typeof source.tombstoneOnEmpty === 'function'
      ? source.tombstoneOnEmpty(parsed)
      : source.tombstoneOnEmpty;
    if (tombstoneOnEmpty && !dryRun) {
      tombstones = await store.tombstoneMissing(source.shape, source.id, []);
    }
    receipt.outcome = 'empty';
    receipt.error = '';
    receipt.tombstones = tombstones;
    receipt.finished_at = Date.now();
    if (!dryRun) {
      await store.insertRun(receipt);
      await store.saveSnapshot({ sourceId: source.id, fetchedAt: now, contentType: raw.contentType, body: raw.body });
    }
    return receipt;
  }

  if (dryRun) {
    receipt.outcome = 'ok';
    receipt.rows_written = rows.length;
    receipt.finished_at = Date.now();
    return receipt;
  }

  const written = await store.upsertRows(source.shape, rows);
  // A source may declare a partition column (the food menu's service_date). Tombstoning then
  // stays inside the partitions this run covered, so fetching another day cannot delete this one.
  const tombstoneScope = source.scopeColumn
    ? { column: source.scopeColumn, values: [...new Set(rows.map((r) => r[source.scopeColumn]))] }
    : {};
  const tombstones = await store.tombstoneMissing(source.shape, source.id, rows.map((r) => r.external_id), tombstoneScope);
  await store.saveSnapshot({ sourceId: source.id, fetchedAt: now, contentType: raw.contentType, body: raw.body });

  receipt.outcome = 'ok';
  receipt.rows_written = written;
  receipt.tombstones = tombstones;
  receipt.finished_at = Date.now();
  await store.insertRun(receipt);
  return receipt;
}
