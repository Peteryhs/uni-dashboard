/**
 * Study spaces: live library and floor occupancy from Waitz.
 *
 * The source writes place_state rows. A library is a row with no parent_place_id; a floor names its
 * library there. All grouping happens at read time, so a failed poll leaves the last known rows
 * visible with the normal age ladder.
 */
import { ageState } from '#contract/cards.mjs';

const SOURCE_ID = 'uw-waitz';
const CADENCE_MS = 5 * 60_000;
const ROW_LIMIT = 200;
const MIN_BEST_CAPACITY = 20;
const ADAPTIVE_TECHNOLOGY = /adaptive technology/i;

function maybePromise(val, fn) {
  return val && typeof val.then === 'function' ? val.then(fn) : fn(val);
}

/**
 * Same fallback the other cards use when a source has no rows. It stays local because cards.mjs
 * imports this module, and importing the helper back would make a cycle.
 */
function sourceHealth(store, sourceId, cadenceMs, now) {
  if (!store || typeof store.lastRunPerSource !== 'function') {
    return { ok: true, state: 'empty' };
  }
  return maybePromise(store.lastRunPerSource([sourceId]), (runs) => {
    const lastRun = (runs || []).find((r) => r.source_id === sourceId);
    if (!lastRun) {
      return { ok: true, state: 'empty' };
    }

    if (lastRun.outcome === 'skipped') {
      return {
        ok: false,
        state: 'degraded',
        error: lastRun.error || 'The last study-space check was skipped.',
      };
    }

    if (lastRun.outcome === 'failed' || lastRun.outcome === 'implausible') {
      return maybePromise(store.lastSuccessfulRun?.(sourceId), (lastSuccess) => {
        const reasonablePastMs = cadenceMs * 6;
        const hadRecentSuccess = lastSuccess && (now - lastSuccess.finished_at <= reasonablePastMs);
        if (!hadRecentSuccess) {
          return {
            ok: false,
            state: 'failed',
            error: lastRun.error || 'Failed to sync with upstream feed',
          };
        }
        return { ok: true, state: 'live' };
      });
    }

    return { ok: true, state: 'live' };
  });
}

function intOrNull(value) {
  // A negative count is a bad value, not a real occupancy reading.
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function percentOf(people, capacity) {
  if (!Number.isFinite(people) || !Number.isFinite(capacity) || capacity <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((people / capacity) * 100)));
}

/**
 * Open first, then emptiest first, then name. Closed spaces sort by name because occupancy is not
 * a useful ordering for a library that is not admitting anyone.
 */
function byOpenThenOccupancy(a, b) {
  if (a.is_open !== b.is_open) return a.is_open ? -1 : 1;
  if (!a.is_open) return a.name.localeCompare(b.name);
  if (a.percent == null && b.percent != null) return 1;
  if (a.percent != null && b.percent == null) return -1;
  if (a.percent != null && a.percent !== b.percent) return a.percent - b.percent;
  return a.name.localeCompare(b.name);
}

export async function studySpacesCard(store, { now = Date.now() } = {}) {
  const rows = (await store.rows('place_state', {
    where: 'source_id = ?',
    params: [SOURCE_ID],
    limit: ROW_LIMIT,
  })) || [];

  if (!rows.length) {
    const health = await sourceHealth(store, SOURCE_ID, CADENCE_MS, now);
    const data = { libraries: [], best: null, open_count: 0, total_count: 0 };
    if (!health.ok) data.error = health.error || 'Failed to sync with upstream feed';
    return {
      id: 'study_spaces',
      type: 'study_spaces',
      priority: 70,
      state: health.ok ? 'empty' : health.state,
      observed_at: null,
      valid_until: null,
      source_id: SOURCE_ID,
      data,
    };
  }

  const byId = new Map();
  const libraries = [];

  for (const row of rows) {
    if (row.parent_place_id) continue;
    const id = row.place_id || row.external_id;
    if (!id || !row.name) continue;
    const library = {
      id,
      name: row.name,
      is_open: Boolean(row.is_open),
      people: intOrNull(row.people),
      capacity: intOrNull(row.capacity),
      percent: null,
      summary: row.summary ?? '',
      floors: [],
    };
    library.percent = percentOf(library.people, library.capacity);
    libraries.push(library);
    byId.set(id, library);
    // The canonical row carries the same value in both columns, but a floor may name either one.
    if (row.external_id) byId.set(row.external_id, library);
  }

  for (const row of rows) {
    if (!row.parent_place_id) continue;
    const library = byId.get(row.parent_place_id);
    const id = row.place_id || row.external_id;
    if (!library || !id || !row.name) continue;
    const floor = {
      id,
      name: row.name,
      is_open: Boolean(row.is_open),
      people: intOrNull(row.people),
      capacity: intOrNull(row.capacity),
      percent: null,
      summary: row.summary ?? '',
    };
    floor.percent = percentOf(floor.people, floor.capacity);
    library.floors.push(floor);
  }

  for (const library of libraries) library.floors.sort(byOpenThenOccupancy);
  libraries.sort(byOpenThenOccupancy);

  const pick = libraries
    .flatMap((library) => library.floors.map((floor) => ({ library, floor })))
    .filter(({ floor }) => (
      floor.is_open
      && floor.percent != null
      && floor.capacity != null
      && floor.capacity >= MIN_BEST_CAPACITY
      && !ADAPTIVE_TECHNOLOGY.test(floor.name)
    ))
    .sort((a, b) => (
      a.floor.percent - b.floor.percent
      || b.floor.capacity - a.floor.capacity
      || a.floor.name.localeCompare(b.floor.name)
    ))[0] ?? null;

  const observed = rows.map((r) => r.observed_at).filter(Number.isFinite);
  const observedAt = observed.length ? Math.max(...observed) : null;
  const valid = rows.map((r) => r.valid_until).filter(Number.isFinite);
  const validUntil = valid.length ? Math.max(...valid) : null;

  return {
    id: 'study_spaces',
    type: 'study_spaces',
    priority: 70,
    state: observedAt == null ? 'empty' : ageState(observedAt, CADENCE_MS, now),
    observed_at: observedAt,
    valid_until: validUntil,
    source_id: SOURCE_ID,
    data: {
      libraries,
      best: pick
        ? {
            library_id: pick.library.id,
            library_name: pick.library.name,
            space_id: pick.floor.id,
            space_name: pick.floor.name,
            percent: pick.floor.percent,
            people: pick.floor.people,
            capacity: pick.floor.capacity,
          }
        : null,
      open_count: libraries.filter((library) => library.is_open).length,
      total_count: libraries.length,
    },
  };
}
