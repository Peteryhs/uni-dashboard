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
import { detectCalendarChanges } from './calendar-changes.mjs';

const DEFAULT_LEASE_MS = 2 * 60_000;

function attachClaimToken(receipt, token) {
  // The token is an internal hand-off between runSource and its scheduler. Keep it off API JSON
  // and source_run payloads while leaving it available to the shared poll loops.
  Object.defineProperty(receipt, 'claim_token', { value: token, enumerable: false, configurable: true });
  return receipt;
}

function claimReceipt(source, now, error = 'source is already being polled') {
  return attachClaimToken({
    source_id: source.id,
    started_at: now,
    finished_at: Date.now(),
    outcome: 'skipped',
    http_status: null,
    bytes: 0,
    rows_written: 0,
    error,
    meta: { poll_claim: 'busy' },
    body_sha256: '',
    tombstones: 0,
    retry_after_ms: 0,
    rows_parsed: 0,
  }, null);
}

async function claimStillOwned(store, sourceId, token) {
  if (!token || typeof store.sourceLeaseOwned !== 'function') return true;
  return store.sourceLeaseOwned(sourceId, token, Date.now());
}

/**
 * A fetch can outlive its lease (or lose it to a newer invocation after a Worker retry). Every
 * state-changing stage checks the generation before touching durable state. The adapters expose
 * the same primitive, so this applies equally to SQLite and D1.
 */
async function leaseLost(store, sourceId, token, receipt) {
  if (await claimStillOwned(store, sourceId, token)) return false;
  receipt.outcome = 'skipped';
  receipt.rows_written = 0;
  receipt.tombstones = 0;
  receipt.error = 'poll claim expired or was superseded before applying result';
  receipt.meta = { ...(receipt.meta ?? {}), poll_claim: 'lost' };
  receipt.finished_at = Date.now();
  return true;
}

async function applyResult(store, source, token, receipt, {
  rows = [],
  tombstone = false,
  tombstoneScope = {},
  raw = null,
  changeContext = {},
} = {}) {
  if (typeof store.commitSourceResult === 'function') {
    let calendarChanges = [];
    if (source.shape === 'timeline_event' && ['ok', 'empty'].includes(receipt.outcome)) {
      const previous = await store.rows('timeline_event', { where: 'source_id = ?', params: [source.id], limit: 10001 });
      if (previous.length <= 10000) calendarChanges = detectCalendarChanges(previous, rows, {
        sourceId: source.id, now: receipt.started_at, complete: tombstone, ...changeContext,
      });
    }
    const result = await store.commitSourceResult({
      sourceId: source.id,
      leaseToken: token,
      leaseNow: Date.now(),
      shape: source.shape,
      rows,
      seenExternalIds: rows.map((row) => row.external_id),
      tombstone,
      tombstoneScope,
      snapshot: raw?.body
        ? { sourceId: source.id, fetchedAt: receipt.started_at, contentType: raw.contentType, body: raw.body }
        : null,
      receipt,
      calendarChanges,
    });
    if (!result.applied) await leaseLost(store, source.id, token, receipt);
    return result;
  }

  // Compatibility path for narrow test doubles and future adapters that have not adopted the
  // atomic primitive yet. Production SQLite and D1 always use commitSourceResult above.
  if (await leaseLost(store, source.id, token, receipt)) return { applied: false, written: 0, tombstones: 0 };
  const written = rows.length ? await store.upsertRows(source.shape, rows) : 0;
  const tombstones = tombstone
    ? await store.tombstoneMissing(source.shape, source.id, rows.map((row) => row.external_id), tombstoneScope)
    : 0;
  if (raw?.body) {
    if (await leaseLost(store, source.id, token, receipt)) return { applied: false, written: 0, tombstones: 0 };
    await store.saveSnapshot({ sourceId: source.id, fetchedAt: receipt.started_at, contentType: raw.contentType, body: raw.body });
  }
  receipt.rows_written = written;
  receipt.tombstones = tombstones;
  if (await leaseLost(store, source.id, token, receipt)) return { applied: false, written: 0, tombstones: 0 };
  await store.insertRun(receipt);
  return { applied: true, written, tombstones };
}

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
  const cancelledIds = new Set(parsed?.changeContext?.cancelledIds || []);
  const cancelledUids = new Set(parsed?.changeContext?.cancelledUids || []);
  const explicitExceptions = parsed?.tombstone !== false && (cancelledIds.size || cancelledUids.size);

  let futureRows;
  try {
    futureRows = (await store.rows(source.shape, {
      where: 'source_id = ? AND starts_at > ?',
      params: [source.id, now],
      limit: explicitExceptions ? 10001 : 1,
    })) ?? [];
  } catch (error) {
    return {
      reason: `could not verify saved future rows after empty feed: ${error.message}`,
      futureRows: null,
    };
  }

  if (!futureRows.length) return null;
  if (explicitExceptions && futureRows.length <= 10000 && futureRows.every(row => cancelledIds.has(row.external_id) || cancelledUids.has(row.uid))) return null;
  return {
    reason: 'feed returned no rows while saved future calendar events remain',
    futureRows: true,
  };
}

async function runClaimedSource(source, store, { now = Date.now(), date = null, dryRun = false, claimToken = null } = {}) {
  const startedAt = now;
  const ctx = { now, date, store };
  const receipt = attachClaimToken({
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
  }, claimToken);

  let raw;
  try {
    raw = await source.fetchRaw(ctx);
  } catch (e) {
    receipt.error = `fetch threw: ${e.message}`;
    receipt.finished_at = Date.now();
    if (!dryRun) await applyResult(store, source, claimToken, receipt, { raw: null });
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
    if (!dryRun) await applyResult(store, source, claimToken, receipt, { raw });
    return receipt;
  }

  let parsed;
  try {
    parsed = source.parse(raw, ctx);
  } catch (e) {
    receipt.outcome = 'failed';
    receipt.error = `parse threw: ${e.message}`;
    receipt.finished_at = Date.now();
    if (!dryRun) await applyResult(store, source, claimToken, receipt, { raw });
    return receipt;
  }

  let rows;
  try {
    rows = validateRows(source.shape, parsed.rows ?? []);
  } catch (e) {
    receipt.outcome = 'failed';
    receipt.error = `contract rejected rows: ${e.message}`;
    receipt.finished_at = Date.now();
    if (!dryRun) await applyResult(store, source, claimToken, receipt, { raw });
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
      if (!dryRun) await applyResult(store, source, claimToken, receipt, { raw });
      return receipt;
    }

    // Valid-empty: an empty future menu day, a calendar whose upcoming events have naturally
    // exhausted, or a status page saying everything is fine.
    let tombstones = 0;
    const tombstoneOnEmpty = typeof source.tombstoneOnEmpty === 'function'
      ? source.tombstoneOnEmpty(parsed)
      : source.tombstoneOnEmpty;
    if (tombstoneOnEmpty) receipt.tombstones = 0;
    receipt.outcome = 'empty';
    receipt.error = '';
    receipt.finished_at = Date.now();
    if (!dryRun) {
      const result = await applyResult(store, source, claimToken, receipt, { tombstone: Boolean(tombstoneOnEmpty), raw, changeContext: parsed.changeContext });
      if (!result.applied) return receipt;
      tombstones = result.tombstones;
      receipt.tombstones = tombstones;
    }
    return receipt;
  }

  if (dryRun) {
    receipt.outcome = 'ok';
    receipt.rows_written = rows.length;
    receipt.finished_at = Date.now();
    return receipt;
  }

  // A source may declare a partition column (the food menu's service_date). Tombstoning then
  // stays inside the partitions this run covered, so fetching another day cannot delete this one.
  const tombstoneScope = source.scopeColumn
    ? { column: source.scopeColumn, values: [...new Set(rows.map((r) => r[source.scopeColumn]))] }
    : {};
  receipt.outcome = 'ok';
  receipt.rows_written = rows.length;
  receipt.tombstones = 0;
  receipt.finished_at = Date.now();
  const result = await applyResult(store, source, claimToken, receipt, {
    rows,
    tombstone: parsed.tombstone !== false,
    tombstoneScope,
    raw,
    changeContext: parsed.changeContext,
  });
  if (!result.applied) return receipt;
  receipt.rows_written = result.written;
  receipt.tombstones = result.tombstones;
  return receipt;
}

/**
 * Shared entrypoint for cron, manual HTTP, CLI and user generated sources. The caller can hold
 * the lease through job rescheduling by passing holdLease=true; ordinary one-off runs release it
 * on return so existing integrations do not leave a source blocked until the timeout.
 */
export async function runSource(source, store, {
  now = Date.now(),
  date = null,
  dryRun = false,
  holdLease = false,
  leaseMs = source.pollLeaseMs ?? DEFAULT_LEASE_MS,
  expectedJob = undefined,
} = {}) {
  if (dryRun || typeof store.claimSource !== 'function') {
    return runClaimedSource(source, store, { now, date, dryRun, claimToken: null });
  }
  // `now` is the caller's run timestamp (tests and backfills may intentionally use history),
  // while leaseNow is wall clock time so a historical run does not expire before its fetch starts.
  const claim = await store.claimSource(source.id, { now, leaseMs, leaseNow: Date.now(), expectedJob });
  if (!claim) return claimReceipt(source, now);
  try {
    return await runClaimedSource(source, store, { now, date, dryRun, claimToken: claim.token });
  } catch (error) {
    // A storage/network exception before the scheduler can record the receipt must not leave the
    // lease occupied for its full timeout. The scheduler still owns normal result rescheduling.
    if (holdLease && typeof store.releaseSource === 'function') {
      Object.defineProperty(error, 'poll_claim_token', { value: claim.token, enumerable: false });
      Object.defineProperty(error, 'poll_started_at', { value: now, enumerable: false });
      await store.releaseSource(source.id, claim.token, Date.now());
    }
    throw error;
  } finally {
    if (!holdLease && typeof store.releaseSource === 'function') {
      await store.releaseSource(source.id, claim.token, Date.now());
    }
  }
}
