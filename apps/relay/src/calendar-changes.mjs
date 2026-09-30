/** Evidence-based schedule changes. No network calls or inferred cancellations. */
import { courseOf } from './course-code.mjs';
import { groupScope, taskContext, unescapeIcsText } from './task-context.mjs';
import { ageState } from '#contract/cards.mjs';

const DAY = 86400000;
export const CHANGE_RETENTION_MS = 14 * DAY;
const SOURCES = new Set(['uw-portal-ics', 'uw-learn-ics']);
const clean = value => unescapeIcsText(value || '').trim().replace(/\s+/g, ' ');
function fingerprint(text) { let n = 2166136261; for (const char of text) { n = Math.imul(n ^ char.charCodeAt(0), 16777619); } return (n >>> 0).toString(36); }
// Formatting-only changes (including the common "Room" prefix) are not room changes.
export const roomKey = value => clean(value).toUpperCase().replace(/\bROOM\b/g, '').replace(/[^A-Z0-9]/g, '');
const label = id => id === 'uw-learn-ics' ? 'LEARN' : 'Schedule';
function course(row) { const value = row.source_id === 'uw-learn-ics' ? taskContext(row).course || courseOf(row.title, row.location) : courseOf(row.title, row.location); return value === 'Other' ? null : value; }
function scope(row) { return groupScope(row.title || ''); }
function snapshot(row) {
  return { external_id: row.external_id, uid: row.uid || null, title: clean(row.title), course: course(row),
    location: row.source_id === 'uw-learn-ics' ? taskContext(row).place || '' : clean(row.location),
    starts_at: row.starts_at, ends_at: row.ends_at ?? row.starts_at, all_day: Boolean(row.all_day), kind: row.kind,
    due_at: row.source_id === 'uw-learn-ics' ? taskContext(row).due_at : null,
    description: clean(row.description).slice(0, 1500), url: row.url || null, group_scope: scope(row) };
}
function changedFields(before, after) {
  const fields = [];
  if (roomKey(before.location) !== roomKey(after.location)) fields.push('room');
  if (before.starts_at !== after.starts_at || before.ends_at !== after.ends_at || before.all_day !== after.all_day) fields.push(['deadline', 'exam'].includes(after.kind) ? 'deadline' : 'time');
  if (before.due_at !== after.due_at && !fields.includes('deadline')) fields.push('deadline');
  return fields;
}
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });
const dateKey = at => dateFormat.format(at);

/** Called while the poll owns its lease; the journal is committed with the same guarded batch. */
export function detectCalendarChanges(previous, rows, { sourceId, now, complete = false, cancelledIds = [], cancelledUids = [] } = {}) {
  if (!SOURCES.has(sourceId)) return [];
  const next = new Map(rows.map(row => [row.external_id, row]));
  const byUid = new Map(), oldByUid = new Map(), oldIds = new Set(previous.map(row => row.external_id));
  for (const row of rows) if (row.uid && !oldIds.has(row.external_id)) { const entries = byUid.get(row.uid) || []; entries.push(row); byUid.set(row.uid, entries); }
  for (const row of previous) if (row.uid) { const entries = oldByUid.get(row.uid) || []; entries.push(row); oldByUid.set(row.uid, entries); }
  const cancelled = new Set(cancelledIds), series = new Set(cancelledUids);
  const changes = [];
  for (const row of previous) {
    let replacement = next.get(row.external_id);
    // A changed DTSTART also changes this parser's occurrence ID. Match an unambiguous UID
    // occurrence on the same campus date (or a single one-off event), never just a title.
    if (!replacement && row.uid) {
      const candidates = byUid.get(row.uid) || [];
      const sameDay = candidates.filter(candidate => dateKey(candidate.starts_at) === dateKey(row.starts_at));
      const oldSameDay = oldByUid.get(row.uid).filter(old => dateKey(old.starts_at) === dateKey(row.starts_at));
      if (sameDay.length === 1 && oldSameDay.length === 1) replacement = sameDay[0];
      else if (candidates.length === 1 && oldByUid.get(row.uid).length === 1) replacement = candidates[0];
    }
    const before = snapshot(row), after = replacement ? snapshot(replacement) : null;
    // Past events and the expansion window moving forward are not actionable changes.
    if ((!after && before.ends_at < now) || Math.max(before.ends_at, after?.ends_at ?? 0, before.due_at ?? 0, after?.due_at ?? 0) < now || Math.min(before.starts_at, after?.starts_at ?? Infinity) > now + 60 * DAY) continue;
    if (!before.course) continue;
    let kinds = after ? changedFields(before, after) : [];
    if (!after && complete) kinds = [cancelled.has(row.external_id) || series.has(row.uid) ? 'cancelled' : 'removed'];
    if (!kinds.length) continue;
    changes.push({ id: `${sourceId}:${row.external_id}:${now}`, source_id: sourceId, event_id: `${sourceId}:${replacement?.external_id ?? row.external_id}`,
      observed_at: now, starts_at: after?.due_at ?? after?.starts_at ?? before.due_at ?? before.starts_at, ends_at: Math.max(before.ends_at, after?.ends_at ?? 0, before.due_at ?? 0, after?.due_at ?? 0),
      kinds, before, after });
  }
  return changes;
}

function inScope(value, section, group) {
  if (section == null || group == null) return true;
  return (value.section == null || value.section === section) && (value.groups == null || group >= value.groups[0] && group <= value.groups[1]);
}
function stamp(at, allDay = false) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', ...(allDay ? {} : { hour: 'numeric', minute: '2-digit' }) }).format(at);
}
function freshness(sourceId, observedAt, now, failed) {
  const state = ageState(observedAt, sourceId === 'uw-portal-ics' ? 6 * 3600000 : 15 * 60000, now);
  return failed && ['live', 'ageing'].includes(state) ? 'stale' : state;
}
function alert(values) {
  return { course: null, event_id: null, source_label: 'Schedule', location: '', previous_location: '',
    confidence: 'confirmed', state: 'live', ...values, url: safeUrl(values.url) };
}
function safeUrl(value) { try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } }

/** Only explicit instructions establish that an assignment replaces an in-person tutorial. */
export function tutorialInstructions(event) {
  if (!event.course || !/\b(?:tutorial|tut)\b/i.test(`${event.title} ${event.description}`)) return null;
  const text = clean(event.description);
  const online = /\b(?:crowdmark|online|asynchronous)\b/i.test(`${event.title} ${text}`) || event.links?.some(link => link.kind === 'crowdmark');
  const assignment = /\b(?:assignment|problem set|worksheet)\b/i.test(`${event.title} ${text}`);
  if (!online || !assignment) return null;
  // Keep the cancellation/replacement tied to tutorial language, not another class in the text.
  const sentence = text.split(/(?<=[.!?])\s+(?=[A-Z])|\n/).find(part =>
    /\b(?:tutorial|tut)\b/i.test(part) && !/\b(?:not|never|isn['’]t|hasn['’]t|wasn['’]t|won['’]t|may|might|could|if|unless)\b/i.test(part) &&
    /\b(?:cancelled|canceled|replaced|in place of|instead of|rather than|no in[- ]person)\b/i.test(part));
  return { confirmed: Boolean(sentence), sentence: sentence || '', evidence: (sentence || text || event.title).slice(0, 600) };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function explicitTutorialDate(instructions, event) {
  const text = instructions.sentence;
  const linked = match => /\b(?:tutorial|tut)(?:\s+(?:session|scheduled|on|for))*\s*$/i.test(text.slice(0, match.index)) || /^(?:['’]s)?\s+(?:tutorial|tut)\b/i.test(text.slice(match.index + match[0].length));
  const dates = [...text.matchAll(/\b(20\d\d-\d\d-\d\d)\b/g)].filter(linked).map(match => match[1]);
  const matches = [...text.matchAll(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?\b/gi)].filter(linked);
  for (const [, month, day, year] of matches) dates.push(`${year || dateKey(event.starts_at).slice(0, 4)}-${String(MONTHS[month.slice(0, 3).toLowerCase()]).padStart(2, '0')}-${day.padStart(2, '0')}`);
  return dates.length === 1 ? dates[0] : null;
}

/** Keep a static timetable honest when LEARN describes replacement tutorial work. */
export function tutorialAttendanceAlerts(events, { now, section = null, group = null } = {}) {
  const works = events.map(event => ({ event, instructions: tutorialInstructions(event) }))
    .filter(({ event, instructions }) => event.source_id === 'uw-learn-ics' && instructions && ['live', 'ageing'].includes(event.state) && inScope(event.group_scope || {}, section, group));
  const result = [];
  for (const session of events) {
    if (session.category !== 'class' || session.ends_at <= now || !/\b(?:tutorial|tut)\b/i.test(session.title) || !session.course) continue;
    const related = works.filter(({ event }) => event.course?.replace(/\s/g, '') === session.course.replace(/\s/g, '') && Math.abs((event.due_at ?? event.starts_at) - session.starts_at) <= 7 * DAY);
    const work = related.find(({ event, instructions }) => instructions.confirmed && explicitTutorialDate(instructions, event) === dateKey(session.starts_at)) || related[0];
    if (!work) continue;
    const replaced = work.instructions.confirmed && explicitTutorialDate(work.instructions, work.event) === dateKey(session.starts_at);
    result.push(alert({ id: `attendance:${session.id}:${fingerprint(work.instructions.evidence + work.event.title)}`, event_id: session.id, kind: 'tutorial_work',
      attendance: replaced ? 'replaced' : 'check_instructions', title: `${session.course}: ${replaced ? 'Tutorial replaced by online work' : 'Check before attending tutorial'}`,
      body: `${work.event.title} is listed as online tutorial work. ${replaced ? 'The instructions explicitly replace this dated tutorial; complete the listed work instead.' : 'Check the course instructions before attending; the affected tutorial date is not confirmed.'}`,
      course: session.course, starts_at: session.starts_at, ends_at: session.ends_at, observed_at: work.event.observed_at,
      source_label: work.event.source_label, url: work.event.links?.find(link => link.kind === 'crowdmark')?.url || work.event.url,
      confidence: replaced ? 'confirmed' : 'check', evidence: work.instructions.evidence, state: work.event.state }));
  }
  return result;
}

export function sessionEvidenceEvents(rows, now) {
  return rows.map(row => {
    const context = row.source_id === 'uw-learn-ics' ? taskContext(row) : null;
    return { ...row, id: `${row.source_id}:${row.external_id}`, category: row.kind, course: context?.course || course(row),
      description: context?.body || clean(row.description), links: context?.links || [], url: context?.url || row.url,
      due_at: context?.due_at, group_scope: scope(row), source_label: label(row.source_id),
      state: freshness(row.source_id, row.observed_at, now, false) };
  });
}

function seriesKey(event) {
  // A recurring UID keeps lecture/tutorial/lab and sections apart. The fallback uses the full
  // session title, so different sections never train each other's usual-room baseline.
  return `${event.source_id}:${event.uid || clean(event.title).toUpperCase()}`;
}

/** Persistent diffs plus current, conservative room norms and tutorial instructions. */
export function calendarChangeAlerts({ changes = [], events, roomEvents = events, now, from, until, section = null, group = null, failedSources = new Set(), sourceObservedAt = new Map() }) {
  const current = new Map(events.map(event => [event.id, event]));
  const result = [];
  const seen = new Set();
  for (const change of [...changes].sort((a, b) => b.observed_at - a.observed_at)) {
    if (change.observed_at < now - CHANGE_RETENTION_MS) continue;
    const event = current.get(change.event_id);
    const value = change.after && event ? { ...change.after, starts_at: event.starts_at, ends_at: event.ends_at } : change.after || change.before;
    const affectsRange = [change.before, change.after].filter(Boolean).some(entry => (entry.due_at ?? entry.starts_at) < until && Math.max(entry.ends_at, entry.due_at ?? 0) >= from);
    if (!inScope(value.group_scope, section, group) || !affectsRange || change.ends_at < now) continue;
    // A later reappearance/reversion resolves the old warning immediately.
    if (!change.after && event) continue;
    if (change.after && !event) continue;
    const mismatches = event ? changedFields(change.after || change.before, snapshot({ ...event, external_id: event.occurrence_id })) : [];
    const kinds = change.kinds.filter(kind => !seen.has(`${change.event_id}:${kind}`) && !mismatches.includes(kind));
    if (!kinds.length) continue;
    for (const kind of kinds) seen.add(`${change.event_id}:${kind}`);
    const cancelled = kinds.includes('cancelled'), removed = kinds.includes('removed');
    const removedDue = kinds.includes('deadline') && change.before.due_at != null && value.due_at == null && change.before.starts_at === value.starts_at;
    const parts = [];
    if (kinds.includes('room')) parts.push(`${change.before.location || 'Room not listed'} → ${value.location || 'Room not listed'}`);
    if (kinds.some(kind => ['time', 'deadline'].includes(kind))) {
      const oldTime = stamp(change.before.due_at ?? change.before.starts_at, change.before.all_day), newTime = stamp(value.due_at ?? value.starts_at, value.all_day);
      parts.push(removedDue ? `The previously stated due time (${oldTime}) is no longer in the instructions. Confirm the deadline in the course.` : oldTime === newTime && change.before.ends_at !== value.ends_at ? `End time: ${stamp(change.before.ends_at)} → ${stamp(value.ends_at)}` : `${oldTime} → ${newTime}`);
    }
    if (cancelled) parts.push(`The calendar explicitly cancelled this session (${stamp(value.starts_at)}).`);
    if (removed) parts.push(`No longer in the latest calendar (${stamp(value.starts_at)}). Confirm the course instructions before changing your plans.`);
    result.push(alert({ id: change.id, event_id: current.has(`${change.event_id}:due`) && kinds.includes('deadline') ? `${change.event_id}:due` : change.event_id, kind: cancelled ? 'cancelled' : removed ? 'removed' : kinds.includes('room') ? 'room' : kinds[0],
      title: `${value.course}: ${cancelled ? 'Session cancelled' : removed ? 'Session removed from calendar' : kinds.includes('room') ? 'Room changed' : removedDue ? 'Check deadline' : kinds.includes('deadline') ? 'Deadline changed' : 'Time changed'}`,
      body: `${value.title}. ${parts.join(' · ')}`, course: value.course, starts_at: removedDue ? change.before.due_at : Math.min(value.due_at ?? value.starts_at, change.before.due_at ?? change.before.starts_at), ends_at: change.ends_at,
      observed_at: change.observed_at, location: value.location, previous_location: change.before.location, source_label: label(change.source_id),
      url: event?.url || value.url, confidence: removed || removedDue ? 'check' : 'confirmed', evidence: 'Compared two successfully parsed calendar snapshots.',
      state: freshness(change.source_id, event?.observed_at || sourceObservedAt.get(change.source_id) || change.observed_at, now, failedSources.has(change.source_id)) }));
  }
  const rooms = new Map();
  const titleRooms = new Map();
  for (const event of roomEvents) {
    if (!event.course || event.category !== 'class' || event.all_day || !roomKey(event.location)) continue;
    const key = seriesKey(event), entries = rooms.get(key) || [];
    entries.push(event); rooms.set(key, entries);
    const titleKey = `${event.source_id}:${clean(event.title).toUpperCase()}`;
    const titleEntries = titleRooms.get(titleKey) || []; titleEntries.push(event); titleRooms.set(titleKey, titleEntries);
  }
  for (const event of events) {
    if (event.category === 'opens' && current.has(`${event.id}:due`)) continue;
    const effectiveTime = event.category === 'opens' ? event.due_at ?? event.starts_at : event.starts_at;
    const effectiveEnd = Math.max(event.ends_at, event.due_at ?? 0);
    if (effectiveEnd < now || effectiveTime < from || effectiveTime >= until || !inScope(event.group_scope, section, group)) continue;
    const instructions = tutorialInstructions(event);
    if (instructions) result.push(alert({ id: `tutorial:${event.id}:${fingerprint(clean(event.description) + event.title)}`, event_id: event.id, kind: 'tutorial_work',
      title: `${event.course}: ${instructions.confirmed ? 'Tutorial replaced by online work' : 'Check tutorial assignment instructions'}`,
      body: `${event.title}. ${instructions.confirmed ? 'The instructions describe replacement work; check its submission requirements.' : 'Online tutorial work is listed. An in-person cancellation is not confirmed.'}`,
      course: event.course, starts_at: effectiveTime, ends_at: effectiveEnd, observed_at: event.observed_at,
      source_label: event.source_label, url: event.links?.find(link => /(^|\.)crowdmark\.com$/i.test((() => { try { return new URL(link.url).hostname; } catch { return ''; } })()))?.url || event.url,
      confidence: instructions.confirmed ? 'confirmed' : 'check', evidence: instructions.evidence,
      state: freshness(event.source_id, event.observed_at, now, failedSources.has(event.source_id)) }));
    if (!event.course || event.category !== 'class' || !roomKey(event.location) || result.some(item => item.event_id === event.id && item.kind === 'room')) continue;
    let peers = (rooms.get(seriesKey(event)) || []).filter(peer => peer.id !== event.id);
    if (peers.length < 3 && /\b(?:lec|lecture|tut|tutorial|lab|laboratory)\b/i.test(event.title)) {
      peers = (titleRooms.get(`${event.source_id}:${clean(event.title).toUpperCase()}`) || []).filter(peer => peer.id !== event.id);
    }
    if (peers.length < 3) continue;
    const counts = new Map();
    for (const peer of peers) { const key = roomKey(peer.location); const entry = counts.get(key) || { count: 0, room: peer.location }; entry.count++; counts.set(key, entry); }
    const [usualKey, usual] = [...counts.entries()].sort((a, b) => b[1].count - a[1].count)[0];
    if (usual.count < 3 || usual.count / (peers.length + 1) < 0.75 || usualKey === roomKey(event.location)) continue;
    result.push(alert({ id: `unusual:${event.id}:${roomKey(event.location)}`, event_id: event.id, kind: 'unusual_room',
      title: `${event.course}: Different room for this session`, body: `${event.title}: ${event.location}; usually ${usual.room} for this recurring session. Check the room before heading over.`,
      course: event.course, starts_at: event.starts_at, ends_at: event.ends_at, observed_at: event.observed_at,
      location: event.location, previous_location: usual.room, source_label: event.source_label, url: event.url,
      confidence: 'check', evidence: `${usual.count} of ${peers.length} other occurrences of this session list ${usual.room}.`,
      state: freshness(event.source_id, event.observed_at, now, failedSources.has(event.source_id)) }));
  }
  return result.sort((a, b) => a.starts_at - b.starts_at || b.observed_at - a.observed_at).slice(0, 100);
}
