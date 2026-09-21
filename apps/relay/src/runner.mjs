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
import { sha256 } from './store.mjs';

export async function runSource(source, store, { now = Date.now(), date = null, dryRun = false } = {}) {
  const startedAt = now;
  const ctx = { now, date };
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
  };

  let raw;
  try {
    raw = await source.fetchRaw(ctx);
  } catch (e) {
    receipt.error = `fetch threw: ${e.message}`;
    receipt.finished_at = Date.now();
    if (!dryRun) store.insertRun(receipt);
    return receipt;
  }

  receipt.http_status = raw.status || null;
  receipt.bytes = raw.bytes ?? 0;
  receipt.body_sha256 = raw.body ? sha256(raw.body) : '';

  const verdict = source.plausible(raw);
  if (!verdict.ok) {
    receipt.outcome = verdict.skipped ? 'skipped' : verdict.credential ? 'implausible' : 'failed';
    receipt.error = verdict.reason;
    receipt.meta = { plausible: false, credential: Boolean(verdict.credential) };
    receipt.finished_at = Date.now();
    if (!dryRun) {
      store.insertRun(receipt);
      if (raw.body) store.saveSnapshot({ sourceId: source.id, fetchedAt: now, contentType: raw.contentType, body: raw.body });
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
      store.insertRun(receipt);
      store.saveSnapshot({ sourceId: source.id, fetchedAt: now, contentType: raw.contentType, body: raw.body });
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
      store.insertRun(receipt);
      store.saveSnapshot({ sourceId: source.id, fetchedAt: now, contentType: raw.contentType, body: raw.body });
    }
    return receipt;
  }

  receipt.meta = parsed.meta ?? {};
  receipt.rows_parsed = rows.length;

  if (rows.length === 0) {
    // Valid-empty: an empty future menu day, or a status page saying everything is fine.
    receipt.outcome = 'empty';
    receipt.error = '';
    receipt.finished_at = Date.now();
    if (!dryRun) {
      store.insertRun(receipt);
      store.saveSnapshot({ sourceId: source.id, fetchedAt: now, contentType: raw.contentType, body: raw.body });
    }
    return receipt;
  }

  if (dryRun) {
    receipt.outcome = 'ok';
    receipt.rows_written = rows.length;
    receipt.finished_at = Date.now();
    return receipt;
  }

  const written = store.upsertRows(source.shape, rows);
  const tombstones = store.tombstoneMissing(source.shape, source.id, rows.map((r) => r.external_id));
  store.saveSnapshot({ sourceId: source.id, fetchedAt: now, contentType: raw.contentType, body: raw.body });

  receipt.outcome = 'ok';
  receipt.rows_written = written;
  receipt.tombstones = tombstones;
  receipt.finished_at = Date.now();
  store.insertRun(receipt);
  return receipt;
}
