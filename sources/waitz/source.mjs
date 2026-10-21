/**
 * Study spaces adapter. Waitz reports live occupancy for the Waterloo libraries and their floors,
 * keyless and unauthenticated. It is unofficial, so saved rows and the normal age ladder are the
 * fallback when it stops answering.
 *
 * The payload is one `data` array of libraries, each optionally carrying `subLocs` for its floors.
 * `subLocs` is `false` for a library with no floor breakdown, so only an array is iterated. A
 * closed location is still a row: the card needs its next opening time from `hourSummary`.
 */
export const id = 'uw-waitz';
export const shape = 'place_state';
export const cadenceMs = 5 * 60 * 1000;
export const url = 'https://waitz.io/live/waterloo';
export const needsSecret = false;
export const tombstoneOnEmpty = true;

/** No fetch in this app is unbounded: a hung socket would stall the whole poll loop. */
const FETCH_TIMEOUT_MS = 10_000;

/** Six minutes keeps a five minute poll from lapsing before the next one lands. */
const VALID_FOR_MS = 6 * 60 * 1000;

export async function fetchRaw() {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    retryAfter: res.headers.get('retry-after') ?? '',
    body,
    bytes: body.length,
  };
}

export function plausible(raw) {
  if (raw.status !== 200) return { ok: false, reason: `http ${raw.status}` };
  let payload;
  try {
    payload = JSON.parse(raw.body);
  } catch (e) {
    return { ok: false, reason: `not json: ${e.message}` };
  }
  if (!Array.isArray(payload?.data)) return { ok: false, reason: 'no data array' };
  if (!payload.data.length) return { ok: false, reason: 'empty data array' };
  const usable = payload.data.filter((location) => location
    && (typeof location.id === 'number' || (typeof location.id === 'string' && location.id.trim()))
    && typeof location.name === 'string' && location.name.trim());
  if (!usable.length) return { ok: false, reason: 'no usable locations in data array' };
  return { ok: true, reason: '' };
}

export function parse(raw, ctx) {
  const now = ctx?.now ?? Date.now();
  const payload = JSON.parse(raw.body);
  const locations = Array.isArray(payload?.data) ? payload.data : [];
  const base = { source_id: id, observed_at: now, valid_until: now + VALID_FOR_MS };
  const rows = [];
  let libraries = 0;
  let floors = 0;
  let skippedFloors = 0;

  for (const location of locations) {
    const libraryId = idText(location?.id);
    const libraryName = text(location?.name);
    if (!libraryId || !libraryName) continue;
    const libraryPlaceId = `waitz:${libraryId}`;
    rows.push(placeRow(base, libraryPlaceId, '', libraryName, location));
    libraries += 1;

    const subLocs = Array.isArray(location.subLocs) ? location.subLocs : [];
    for (const floor of subLocs) {
      const floorId = idText(floor?.id);
      const floorName = text(floor?.name);
      if (!floorId || !floorName) {
        skippedFloors += 1;
        continue;
      }
      rows.push(placeRow(base, `waitz:${libraryId}:${floorId}`, libraryPlaceId, floorName, floor));
      floors += 1;
    }
  }

  return { rows, meta: { libraries, floors, skipped_floors: skippedFloors, rows: rows.length } };
}

function placeRow(base, placeId, parentPlaceId, name, location) {
  return {
    ...base,
    external_id: placeId,
    place_id: placeId,
    name,
    parent_place_id: parentPlaceId,
    is_open: typeof location?.isOpen === 'boolean' ? location.isOpen : null,
    people: count(location?.people),
    capacity: count(location?.capacity),
    summary: text(location?.hourSummary),
  };
}

/** Waitz uses numeric ids, but accept a non-blank string so a silent upstream change still runs. */
function idText(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string') return value.trim();
  return '';
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Non-negative integers or null. A missing, negative or garbled count must not be invented. */
function count(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
  }
  return null;
}

export default { id, shape, cadenceMs, url, needsSecret, tombstoneOnEmpty, fetchRaw, plausible, parse };
