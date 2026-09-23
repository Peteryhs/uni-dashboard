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
export const url = 'https://status.uwaterloo.ca/api/v2/summary.json';
export const needsSecret = false;
export const tombstoneOnEmpty = true;

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
  const base = { source_id: id, observed_at: now, valid_until: now + 5 * 60 * 1000, scope: 'campus' };
  const incidents = (j.incidents ?? []).filter((item) => item.status !== 'resolved' && item.status !== 'postmortem');
  const rows = incidents.map((item) => {
    const update = item.incident_updates?.[0];
    const components = (item.components ?? []).map((component) => component.name).filter(Boolean);
    return {
      ...base,
      external_id: `incident:${item.id}`,
      severity: SEVERITY[item.impact] ?? SEVERITY[indicator] ?? 'minor',
      title: item.name || j.status?.description || 'Campus incident',
      body: update?.body || item.body || '',
      components,
      incident_status: item.status || '',
      url: item.shortlink || `https://status.uwaterloo.ca/incidents/${item.id}`,
    };
  });
  const covered = new Set(incidents.flatMap((item) => (item.components ?? []).map((component) => component.id)));
  const extraComponents = (j.components ?? []).filter((component) =>
    !covered.has(component.id) && ['degraded_performance', 'partial_outage', 'major_outage'].includes(component.status));
  if (extraComponents.length) {
    rows.push({
      ...base,
      external_id: 'components:affected',
      severity: extraComponents.some((component) => component.status === 'major_outage') ? 'major' : 'minor',
      title: extraComponents.length === 1 ? `${extraComponents[0].name}: ${extraComponents[0].status.replaceAll('_', ' ')}` : 'Other affected services',
      body: 'The campus status page reports these services as affected. Open it for current details.',
      components: extraComponents.map((component) => component.name),
      incident_status: '',
      url: 'https://status.uwaterloo.ca',
    });
  }
  if (!rows.length) rows.push({
    ...base,
    external_id: `indicator:${indicator}`,
    severity: SEVERITY[indicator] ?? 'minor',
    title: j.status?.description ?? `Campus status: ${indicator}`,
    body: '',
    components: [],
    incident_status: '',
    url: 'https://status.uwaterloo.ca',
  });
  return { rows, meta: { indicator, page: j.page?.name ?? '', incidents: incidents.length } };
}

export default { id, shape, cadenceMs, url, needsSecret, tombstoneOnEmpty, fetchRaw, plausible, parse };
