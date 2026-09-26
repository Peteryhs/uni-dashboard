import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { buildCalendar } from '../apps/relay/src/calendar.mjs';
import { saveCourseSyllabus, syllabusAssessmentMatches } from '../apps/relay/src/syllabus.mjs';

const now = Date.parse('2026-09-23T12:00:00Z');
const base = { observed_at: now, valid_until: now + 900_000 };
function entry(id, overrides = {}) {
  return { id, title: 'Loops', kind: 'topic', start_date: '2026-09-23', end_date: '2026-09-23', due_at: null, topics: ['Loops'], readings: [], url: null, effort: 'unknown', estimated_minutes: null, evidence: 'Sep 23: Loops', ...overrides };
}
function document(course, entries) { return { course, title: `${course} syllabus`, term_start: '2026-09-08', entries, warnings: [], updated_at: now }; }

test('calendar maps syllabus topics onto classes and retains a period label and quiet course panels', async () => {
  const store = new SqliteStore(':memory:');
  store.upsertRows('timeline_event', [{ ...base, source_id: 'uw-portal-ics', external_id: 'lecture', kind: 'class', title: 'ECE 150 LEC 001', starts_at: Date.parse('2026-09-23T14:00:00Z'), ends_at: Date.parse('2026-09-23T15:00:00Z') }]);
  await saveCourseSyllabus(store, 'ECE 150', document('ECE 150', [entry('loops', { start_date: '2026-09-21', end_date: '2026-09-25', readings: ['Chapter 3'] })]), { now });
  await saveCourseSyllabus(store, 'MATH 115', document('MATH 115', [entry('matrix', { title: 'Matrices', topics: ['Matrices'] })]), { now });
  const result = await buildCalendar(store, { start: '2026-09-23', days: 1, now });
  assert.equal(result.days[0].learning.length, 2);
  const lecture = result.days[0].events[0];
  assert.deepEqual(lecture.topics, ['Loops']);
  assert.deepEqual(lecture.readings, ['Chapter 3']);
  assert.equal(lecture.syllabus_scope, 'period');
  assert.deepEqual(lecture.syllabus_evidence, ['Sep 23: Loops']);
  assert.deepEqual(result.courses.map((course) => course.course), ['ECE 150', 'MATH 115']);
  assert.equal(result.courses[1].event_ids.length, 0);
  store.close();
});

test('syllabus deadlines retain explicit times; date-only entries are all-day with unconfirmed time', async () => {
  const store = new SqliteStore(':memory:');
  const due = Date.parse('2026-09-24T03:59:00Z');
  await saveCourseSyllabus(store, 'ECE 150', document('ECE 150', [
    entry('quiz', { kind: 'assessment', title: 'Quiz 1', due_at: due, topics: ['Loops'] }),
    entry('project', { kind: 'assessment', title: 'Project 1', end_date: '2026-09-25', topics: [] }),
  ]), { now });
  const result = await buildCalendar(store, { start: '2026-09-23', days: 3, now });
  const first = result.days[0].events;
  const quiz = first.find((event) => event.title === 'Quiz 1');
  assert.equal(quiz.starts_at, due);
  assert.equal(quiz.all_day, false);
  assert.equal(quiz.source_id, 'syllabus');
  const project = first.find((event) => event.title === 'Project 1');
  assert.equal(project.all_day, true);
  assert.match(project.subtitle, /Date and time unconfirmed/);
  assert.equal(project.starts_at, Date.parse('2026-09-23T04:00:00Z'));
  assert.equal(project.ends_at, Date.parse('2026-09-26T04:00:00Z'));
  assert.equal(result.days[2].events[0].continues_from_previous, true);
  assert.equal(result.count, 2, 'a period is counted once even when displayed on several days');
  store.close();
});

test('LEARN owns matched deadlines and receives only explicit assessment coverage', async () => {
  const store = new SqliteStore(':memory:');
  const due = Date.parse('2026-09-24T03:59:00Z');
  const quiz = entry('quiz', { kind: 'assessment', title: 'Quiz 1: coverage: Loops; at 11:59 PM', topics: ['Loops'], due_at: due });
  await saveCourseSyllabus(store, 'ECE 150', document('ECE 150', [quiz, entry('today', { topics: ['Arrays'] }), entry('quiz10', { kind: 'assessment', title: 'Quiz 10', topics: [], due_at: due })]), { now });
  store.upsertRows('timeline_event', [{ ...base, source_id: 'uw-learn-ics', external_id: 'quiz-1', kind: 'deadline', title: 'ECE 150 - Quiz 1 - Due', location: 'ECE 150 - Fall 2026', starts_at: due, ends_at: due }]);
  const result = await buildCalendar(store, { start: '2026-09-23', days: 1, now });
  assert.equal(result.days[0].events.length, 2);
  const live = result.days[0].events.find((event) => event.source_id === 'uw-learn-ics');
  assert.deepEqual(live.topics, ['Loops']);
  assert.equal(result.days[0].events.find((event) => event.source_id === 'syllabus').title, 'Quiz 10');
  assert.equal(syllabusAssessmentMatches(quiz, 'ECE 150', { course: 'ECE150', title: 'Quiz 10', starts_at: due }), false);
  assert.equal(syllabusAssessmentMatches(quiz, 'ECE 150', { course: 'ECE150', title: 'Quiz 1', starts_at: due + 7 * 86_400_000 }), false);
  assert.equal(syllabusAssessmentMatches({ ...quiz, title: 'Quiz 1 (Chapters 1-3)' }, 'ECE 150', { course: 'ECE150', title: 'Quiz 1 - Due', starts_at: due }), true);
  store.close();
});

test('recommendation reads can opt out of syllabus reads and enrichment', async () => {
  const store = new SqliteStore(':memory:');
  await saveCourseSyllabus(store, 'ECE 150', document('ECE 150', [entry('quiz', { kind: 'assessment' })]), { now });
  store.settings = () => { throw new Error('unexpected duplicate syllabus read'); };
  const result = await buildCalendar(store, { start: '2026-09-23', days: 1, now, includeSyllabus: false });
  assert.equal(result.count, 0);
  assert.deepEqual(result.days[0].learning, []);
  store.close();
});

test('calendar cap and truncated flag include generated syllabus events', async () => {
  const start = Date.parse('2026-09-23T14:00:00Z');
  const rows = Array.from({ length: 2000 }, (_, index) => ({ ...base, source_id: 'uw-portal-ics', external_id: `event-${index}`, kind: 'event', title: 'Personal appointment', starts_at: start, ends_at: start + 1_000 }));
  const syllabus = document('ECE 150', [entry('quiz', { kind: 'assessment', title: 'Quiz 1', due_at: start - 1_000 })]);
  const store = {
    rows: async (_, options) => options.where === 'source_id = ?' ? [] : rows,
    settings: async () => [{ name: 'SYLLABUS:ECE 150', value: JSON.stringify(syllabus) }],
    lastRunPerSource: async () => [], getSetting: async () => null,
  };
  const result = await buildCalendar(store, { start: '2026-09-23', days: 1, now });
  assert.equal(result.count, 2000);
  assert.equal(result.days[0].events.length, 2000);
  assert.equal(result.truncated, true);
  assert.equal(result.days[0].events[0].source_id, 'syllabus');
});

test('buildCalendar populates due_at on opens events, synthesizes deadline event, and deduplicates explicit deadlines', async () => {
  const store = new SqliteStore(':memory:');
  const calNow = Date.parse('2026-09-25T12:00:00Z');
  const openTime = Date.parse('2026-09-25T12:30:00Z');
  const expectedDue = Date.parse('2026-10-02T22:00:00Z');

  store.upsertRows('timeline_event', [
    {
      observed_at: calNow,
      valid_until: calNow + 900_000,
      source_id: 'uw-learn-ics',
      external_id: 'tut3-open',
      kind: 'deadline',
      title: 'TUTORIAL ASSIGNMENT 3 - Available',
      location: 'MATH 117 - Fall 2026',
      description: '8:30amTUTORIAL ASSIGNMENT 3 - AvailableMATH 117opens<p>To be submitted to Crowdmark by 6pm on Friday, Oct 2. Lateness penalty of 1% per minute.</p>',
      starts_at: openTime,
      ends_at: openTime,
    },
  ]);

  // Request calendar covering 2026-09-25 to 2026-10-03 (9 days)
  let result = await buildCalendar(store, { start: '2026-09-25', days: 9, now: calNow });
  const daySept25 = result.days.find((d) => d.date === '2026-09-25');
  const opensEvent = daySept25.events.find((e) => e.category === 'opens');
  assert.ok(opensEvent);
  assert.equal(opensEvent.due_at, expectedDue);

  // Inferred deadline event should appear on 2026-10-02
  const dayOct2 = result.days.find((d) => d.date === '2026-10-02');
  assert.ok(dayOct2);
  const derivedDeadline = dayOct2.events.find((e) => e.category === 'deadline');
  assert.ok(derivedDeadline);
  assert.equal(derivedDeadline.starts_at, expectedDue);
  assert.equal(derivedDeadline.course, 'MATH 117');
  assert.match(derivedDeadline.title, /TUTORIAL ASSIGNMENT 3/);

  // When explicit due event is present on Oct 2, no duplicate deadline is synthesized
  store.upsertRows('timeline_event', [
    {
      observed_at: calNow + 60_000,
      valid_until: calNow + 960_000,
      source_id: 'uw-learn-ics',
      external_id: 'tut3-due',
      kind: 'deadline',
      title: 'TUTORIAL ASSIGNMENT 3 - Due',
      location: 'MATH 117 - Fall 2026',
      description: 'Submit to Crowdmark',
      starts_at: expectedDue,
      ends_at: expectedDue,
    },
  ]);

  result = await buildCalendar(store, { start: '2026-09-25', days: 9, now: calNow + 60_000 });
  const dayOct2After = result.days.find((d) => d.date === '2026-10-02');
  const deadlines = dayOct2After.events.filter((e) => e.category === 'deadline');
  assert.equal(deadlines.length, 1);
  assert.equal(deadlines[0].id, 'uw-learn-ics:tut3-due');

  store.close();
});
