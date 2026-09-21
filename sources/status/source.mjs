/**
 * Campus / IT status adapter. The cheapest and most reliable source in the set, and the one that
 * explains other sources' failures: if everything looks stale and status says "major", that is
 * the answer, not a bug in the dashboard.
 *
 * status.uwaterloo.ca is an Atlassian Statuspage endpoint (verified 2026-09-21), so the schema is
 * documented and typed: status.indicator is none | minor | major | critical.
 */
export const id = 'uw-status';
export const shape = 'notice';
export const cadenceMs = 60 * 1000;
export const url = 'https://status.uwaterloo.ca/api/v2/status.json';
export const needsSecret = false;

const SEVERITY = { none: 'info', minor: 'minor', major: 'major', critical: 'critical' };

/** No fetch in this app is unbounded: a hung socket would stall the whole poll loop. */
const FETCH_TIMEOUT_MS = 10_000;

export async function fetchRaw() {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    body,
    bytes: body.length,
  };
}

export function plausible(raw) {
  if (raw.status !== 200) return { ok: false, reason: `http ${raw.status}` };
  try {
    const j = JSON.parse(raw.body);
    if (!j || typeof j !== 'object' || !j.status) return { ok: false, reason: 'no status object' };
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: `not json: ${e.message}` };
  }
}

export function parse(raw, ctx) {
  const now = ctx?.now ?? Date.now();
  const j = JSON.parse(raw.body);
  const indicator = j.status?.indicator ?? 'none';
  if (indicator === 'none') {
    // No row is the normal state. Silence is a feature: an empty alert slot renders zero height.
    return { rows: [], meta: { indicator, page: j.page?.name ?? '' } };
  }
  return {
    rows: [
      {
        source_id: id,
        external_id: `indicator:${indicator}:${j.page?.updated_at ?? ''}`,
        observed_at: now,
        valid_until: now + 5 * 60 * 1000,
        severity: SEVERITY[indicator] ?? 'minor',
        scope: 'campus',
        title: j.status?.description ?? `Campus status: ${indicator}`,
        body: '',
        url: 'https://status.uwaterloo.ca',
      },
    ],
    meta: { indicator, page: j.page?.name ?? '' },
  };
}

export default { id, shape, cadenceMs, url, needsSecret, fetchRaw, plausible, parse };
