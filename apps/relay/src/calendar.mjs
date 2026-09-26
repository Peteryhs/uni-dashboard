/** A date-range agenda shared by the Worker and the local relay. */
import { config } from './config.mjs';
import { ageState } from '#contract/cards.mjs';
import { CalendarResponse } from '#contract/calendar.mjs';
import { zonedToEpoch } from '#sources/ics/parse.mjs';
import { learnEventCategory } from '#sources/ics/learn-classification.mjs';
import { taskContext, groupScope, unescapeIcsText, cleanDisplayTitle, isSameAssessment } from './task-context.mjs';
import { courseOf } from './cards.mjs';
import { SOURCES, readiness } from '#sources/registry.mjs';
import { courseLibrary, learnHomeFromEvents } from './course-library.mjs';
import { listCourseSyllabi, syllabusAssessmentMatches } from './syllabus.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 31;
const MAX_EVENTS = 2000;
const PORTAL_ASSESSMENT_TITLE_RE = /\b(?:due|deadline|submit|submission|assignment|quiz|midterm|exam|test|lab report)\b/i;
const CADENCE = { 'uw-portal-ics': 6 * 60 * 60_000, 'uw-learn-ics': 15 * 60_000, 'user-office-hours': 6 * 60 * 60_000 };
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
});

function campusDate(ms) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateParts(date) {
  if (!DATE_RE.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  if (year < 1970 || year > 2100) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.toISOString().slice(0, 10) !== date) return null;
  return { year, month, day };
}

function addDays(date, days) {
  const { year, month, day } = dateParts(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function positiveInt(value, max) {
  if (value == null) return null;
  if (!/^[1-9]\d*$/.test(value)) return NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : NaN;
}

/** Parse and bound untrusted request parameters before they reach the database. */
export function calendarOptions(searchParams, now = Date.now()) {
  const start = searchParams.get('start') ?? campusDate(now);
  const days = positiveInt(searchParams.get('days'), MAX_DAYS) ?? 7;
  const section = positiveInt(searchParams.get('section'), 999);
  const group = positiveInt(searchParams.get('group'), 999);
  if (!dateParts(start) || Number(start.slice(0, 4)) > 2099 || !Number.isInteger(days) || !Number.isInteger(section ?? 1) || !Number.isInteger(group ?? 1)) {
    throw new RangeError('start must be YYYY-MM-DD; days must be 1-31; section and group must be positive integers');
  }
  return { start, days, section, group };
}

function matchesScope(scope, section, group) {
  // Match the existing Due Soon preference: filtering starts once both numbers are set.
  if (section == null || group == null) return true;
  if (scope.section != null && section !== scope.section) return false;
  if (scope.groups != null && (group < scope.groups[0] || group > scope.groups[1])) return false;
  return true;
}

function rowUid(row) {
  if (row.uid) return row.uid;
  if (row.source_id !== 'uw-portal-ics' && row.source_id !== 'uw-learn-ics') return null;
  return /^(.*)#\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.exec(row.external_id)?.[1] ?? null;
}

function toEvent(row, now) {
  const learn = row.source_id === 'uw-learn-ics';
  const officeHours = row.source_id === 'user-office-hours' || row.kind === 'office_hours';
  const context = learn ? taskContext(row) : null;
  const course = officeHours ? courseOf(row.title) : (context?.course || courseOf(row.title, row.location));
  const scope = learn ? groupScope(row.title) : { section: null, groups: null };
  const link = context?.url || row.url || '';
  const portalAdministrativeDate = row.source_id === 'uw-portal-ics' && row.all_day && course === 'Other' && !PORTAL_ASSESSMENT_TITLE_RE.test(row.title);
  const category = learn ? learnEventCategory(row.title, row.kind) : officeHours ? 'office_hours' : portalAdministrativeDate ? 'event' :
    row.kind === 'exam' ? 'exam' : row.kind === 'deadline' ? 'deadline' :
      row.kind === 'class' && course !== 'Other' ? 'class' : 'event';
  return {
    id: `${row.source_id}:${row.external_id}`,
    occurrence_id: row.external_id,
    uid: rowUid(row),
    source_id: row.source_id,
    source_label: learn ? 'LEARN' : officeHours ? 'Custom' : row.source_id === 'uw-portal-ics' ? 'Schedule' : row.source_id,
    kind: learn || portalAdministrativeDate ? category : row.kind || 'event',
    category,
    phase: learn && category === 'opens' ? 'opens' : learn && ['deadline', 'exam'].includes(category) ? 'due' : null,
    title: row.title,
    subtitle: row.subtitle || '',
    course: course === 'Other' ? null : course,
    location: context?.place || (learn ? '' : row.location || ''),
    description: (learn ? context.body : unescapeIcsText(row.description || '')).slice(0, 1500),
    url: /^https?:\/\//i.test(link) ? link : null,
    links: context?.links ?? [],
    starts_at: row.starts_at,
    ends_at: row.ends_at ?? row.starts_at,
    all_day: Boolean(row.all_day),
    group_scope: { section: scope.section, groups: scope.groups },
    observed_at: row.observed_at,
    state: ageState(row.observed_at, CADENCE[row.source_id] ?? 15 * 60_000, now),
    topics: [], readings: [], syllabus_evidence: [], syllabus_scope: null,
    due_at: context?.due_at ?? null,
  };
}

function sameCourse(a, b) { return a && b && a.replace(/\s/g, '').toUpperCase() === b.replace(/\s/g, '').toUpperCase(); }
function learningEntry(course, entry) {
  return { course, title: entry.title, topics: entry.topics.length ? entry.topics : entry.kind === 'topic' ? [entry.title] : [], readings: entry.readings.length ? entry.readings : entry.kind === 'reading' ? [entry.title] : [], evidence: entry.evidence, start_date: entry.start_date, end_date: entry.end_date };
}
function attachLearning(event, entries) {
  return { ...event, topics: [...new Set(entries.flatMap((entry) => entry.topics))], readings: [...new Set(entries.flatMap((entry) => entry.readings))], syllabus_evidence: [...new Set(entries.map((entry) => entry.evidence))], syllabus_scope: entries.length ? entries.some((entry) => entry.start_date !== entry.end_date) ? 'period' : 'date' : null };
}
function midnight(date) {
  const value = dateParts(date);
  return zonedToEpoch(value.year, value.month, value.day, 0, 0, 0, config.timezone);
}
function syllabusEvent(document, entry) {
  const exact = entry.due_at != null;
  const period = entry.start_date !== entry.end_date;
  return {
    id: `syllabus:${document.course}:${entry.id}`, occurrence_id: entry.id, uid: null,
    source_id: 'syllabus', source_label: 'Syllabus', kind: 'deadline', category: 'deadline', phase: 'due',
    title: entry.title, subtitle: exact ? 'Syllabus deadline · confirm in LEARN' : period ? `Date and time unconfirmed · ${entry.start_date} to ${entry.end_date}` : 'Time unconfirmed · verify in LEARN',
    course: document.course, location: '', description: entry.evidence, url: entry.url,
    links: entry.url ? [{ label: 'Syllabus link', url: entry.url, kind: 'resource' }] : [],
    starts_at: exact ? entry.due_at : midnight(entry.start_date), ends_at: exact ? entry.due_at : midnight(addDays(entry.end_date, 1)), all_day: !exact,
    group_scope: { section: null, groups: null }, observed_at: document.updated_at, state: 'live',
    topics: entry.topics, readings: entry.readings, syllabus_evidence: [entry.evidence], syllabus_scope: period ? 'period' : 'date',
  };
}

/** Return pre-enriched, sorted Waterloo days so every client sees the same agenda. */
export async function buildCalendar(store, { start, days = 7, section = null, group = null, now = Date.now(), includeSyllabus = true } = {}) {
  if (!dateParts(start) || Number(start.slice(0, 4)) > 2099 || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new RangeError('invalid calendar range');
  const end = addDays(start, days);
  const from = dateParts(start);
  const until = dateParts(end);
  const fromMs = zonedToEpoch(from.year, from.month, from.day, 0, 0, 0, config.timezone);
  const untilMs = zonedToEpoch(until.year, until.month, until.day, 0, 0, 0, config.timezone);
  const rows = await store.rows('timeline_event', {
    where: '(starts_at < ? AND (COALESCE(ends_at, starts_at) > ? OR starts_at >= ?)) OR (source_id = ? AND starts_at >= ? AND starts_at < ?)',
    params: [untilMs, fromMs, fromMs, 'uw-learn-ics', fromMs - 30 * 86400000, fromMs],
    limit: MAX_EVENTS + 1,
    orderBy: 'starts_at',
  });
  const lastRuns = await store.lastRunPerSource();
  const sources = readiness(SOURCES)
    .filter((source) => source.shape === 'timeline_event')
    .map((source) => {
      const run = lastRuns.find((entry) => entry.source_id === source.id);
      return {
        id: source.id,
        status: !source.ready ? 'unconfigured' :
          !run ? (source.id === 'user-office-hours' ? 'ok' : 'pending') :
            ['ok', 'empty'].includes(run.outcome) ? 'ok' : 'failed',
        last_run_at: run?.finished_at ?? null,
      };
    });
  const syllabi = includeSyllabus ? await listCourseSyllabi(store) : [];
  const relevantSyllabi = syllabi.filter((document) => document.entries.some((entry) => entry.start_date < end && entry.end_date >= start));
  if (relevantSyllabi.length) sources.push({ id: 'syllabus', status: 'ok', last_run_at: Math.max(...relevantSyllabi.map((document) => document.updated_at)) });
  const groups = Array.from({ length: days }, (_, index) => {
    const date = addDays(start, index);
    return { date, events: [], learning: relevantSyllabi.flatMap((document) => document.entries.filter((entry) => entry.kind !== 'assessment' && entry.start_date <= date && entry.end_date >= date).map((entry) => learningEntry(document.course, entry))) };
  });
  const boundaries = Array.from({ length: days + 1 }, (_, index) => {
    const parts = dateParts(addDays(start, index));
    return zonedToEpoch(parts.year, parts.month, parts.day, 0, 0, 0, config.timezone);
  });
  // A Google schedule can also carry a LEARN subscription. Matching UID and start time identify
  // the same occurrence; prefer LEARN because it carries the submission link and course metadata.
  const occurrences = new Map();
  for (const row of rows.slice(0, MAX_EVENTS)) {
    const uid = rowUid(row);
    const key = uid ? `${uid}#${row.starts_at}` : `${row.source_id}:${row.external_id}`;
    const previous = occurrences.get(key);
    if (!previous || (row.source_id === 'uw-learn-ics' && previous.source_id !== 'uw-learn-ics')) occurrences.set(key, row);
  }
  const candidates = [];
  for (const row of occurrences.values()) {
    let event = toEvent(row, now);
    if (!matchesScope(event.group_scope, section, group)) continue;
    if (['deadline', 'exam'].includes(event.category)) {
      const entries = relevantSyllabi.flatMap((document) => document.entries.filter((entry) => syllabusAssessmentMatches(entry, document.course, event)));
      if (entries.length) event = attachLearning(event, entries);
    }
    candidates.push(event);
  }
  const inferredDeadlines = [];
  for (const event of candidates) {
    if (event.source_id === 'uw-learn-ics' && event.category === 'opens' && event.due_at != null) {
      if (event.due_at >= fromMs && event.due_at < untilMs) {
        const hasExplicit = candidates.some((other) =>
          ['deadline', 'exam'].includes(other.category) &&
          isSameAssessment(other.title, event.title, other.course, event.course)
        );
        const hasSyllabus = relevantSyllabi.some((doc) =>
          sameCourse(doc.course, event.course) &&
          doc.entries.some((entry) => entry.kind === 'assessment' && isSameAssessment(entry.title, event.title, doc.course, event.course))
        );
        if (!hasExplicit && !hasSyllabus) {
          let derived = {
            id: `${event.id}:due`,
            occurrence_id: `${event.occurrence_id}:due`,
            uid: event.uid,
            source_id: event.source_id,
            source_label: event.source_label,
            kind: 'deadline',
            category: 'deadline',
            phase: 'due',
            title: cleanDisplayTitle(event.title),
            subtitle: 'Due parsed from instructions · confirm in LEARN',
            course: event.course,
            location: event.location,
            description: event.description,
            url: event.url,
            links: event.links,
            starts_at: event.due_at,
            ends_at: event.due_at,
            all_day: false,
            group_scope: event.group_scope,
            observed_at: event.observed_at,
            state: event.state,
            topics: event.topics,
            readings: event.readings,
            syllabus_evidence: event.syllabus_evidence,
            syllabus_scope: event.syllabus_scope,
            due_at: event.due_at,
          };
          const entries = relevantSyllabi.flatMap((document) =>
            document.entries.filter((entry) => syllabusAssessmentMatches(entry, document.course, derived))
          );
          if (entries.length) derived = attachLearning(derived, entries);
          inferredDeadlines.push(derived);
        }
      }
    }
  }
  candidates.push(...inferredDeadlines);
  for (const document of relevantSyllabi) for (const entry of document.entries) {
    if (entry.kind !== 'assessment' || entry.start_date >= end || entry.end_date < start) continue;
    if (candidates.some((event) => ['deadline', 'exam'].includes(event.category) && event.source_id !== 'syllabus' && syllabusAssessmentMatches(entry, document.course, event))) continue;
    candidates.push(syllabusEvent(document, entry));
  }
  candidates.sort((a, b) => a.starts_at - b.starts_at || a.id.localeCompare(b.id));
  const truncated = rows.length > MAX_EVENTS || candidates.length > MAX_EVENTS;
  const visible = new Set();
  for (const event of candidates.slice(0, MAX_EVENTS)) {
    const eventEnd = Math.max(event.ends_at, event.starts_at + 1);
    for (let index = 0; index < groups.length; index++) {
      const dayStart = boundaries[index];
      const dayEnd = boundaries[index + 1];
      if (event.starts_at < dayEnd && eventEnd > dayStart) {
        const enriched = event.category === 'class' ? attachLearning(event, groups[index].learning.filter((entry) => sameCourse(entry.course, event.course))) : event;
        groups[index].events.push({
          ...enriched,
          continues_from_previous: event.starts_at < dayStart,
          continues_next_day: eventEnd > dayEnd,
        });
        visible.add(event.id);
      }
    }
  }
  for (const day of groups) day.events.sort((a, b) => a.starts_at - b.starts_at || a.id.localeCompare(b.id));
  const library = await courseLibrary(store);
  // A quiet week may have classes but no LEARN deadline. Reuse links from the course's other
  // calendar events so its course shortcut is still available in the weekly panel.
  const learnRows = await store.rows('timeline_event', { where: 'source_id = ?', params: ['uw-learn-ics'], limit: MAX_EVENTS });
  const learnHomes = new Map();
  for (const row of learnRows) {
    const context = taskContext(row);
    const course = context.course || courseOf(row.title, row.location);
    if (!course || course === 'Other' || learnHomes.has(course)) continue;
    const home = learnHomeFromEvents([{ links: context.links }]);
    if (home) learnHomes.set(course, home);
  }
  // The catalog must outlive a quiet calendar range: saved links and syllabi are
  // still useful even when a course has no event in these 31 days. Keep the
  // event map range-local so the counts and IDs below remain range-local too.
  const byCourse = new Map();
  for (const document of syllabi) byCourse.set(document.course, new Map());
  for (const course of Object.keys(library)) if (!byCourse.has(course)) byCourse.set(course, new Map());
  for (const day of groups) for (const event of day.events) {
    if (!event.course) continue;
    if (!byCourse.has(event.course)) byCourse.set(event.course, new Map());
    byCourse.get(event.course).set(event.id, event);
  }
  const courses = [...byCourse.entries()].map(([course, eventMap]) => {
    const events = [...eventMap.values()];
    return {
      course,
      learn_url: learnHomeFromEvents(events) || learnHomes.get(course) || null,
      event_ids: events.map((event) => event.id),
      class_count: events.filter((event) => event.category === 'class').length,
      deadline_count: events.filter((event) => ['deadline', 'exam'].includes(event.category)).length,
      office_hours_count: events.filter((event) => event.category === 'office_hours').length,
      resources: library[course] || [],
    };
  }).sort((a, b) => a.course.localeCompare(b.course));
  return CalendarResponse.parse({
    schema_version: 1,
    timezone: config.timezone,
    generated_at: now,
    start,
    end,
    days: groups,
    courses,
    count: visible.size,
    truncated,
    sources,
  });
}
