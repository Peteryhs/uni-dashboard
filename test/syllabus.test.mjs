import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { previewSyllabus, saveCourseSyllabus, getCourseSyllabus, listCourseSyllabi, syllabusAssessmentMatches } from '../apps/relay/src/syllabus.mjs';

const now = Date.parse('2026-09-23T12:00:00Z');

test('syllabus maps dates and anchored weeks while preserving distinct topics, reading and assessments', async () => {
  const store = new SqliteStore(':memory:');
  const preview = await previewSyllabus(store, { course: 'ece 150', term_start: '2026-09-08', text: `ECE 150 Fall 2026
| Week | Topic | Reading | Assessment |
| --- | --- | --- | --- |
| Week 1 | Variables and input | Chapter 1 | - |
| Week 3 | Loops | Chapter 3 | Quiz 1: coverage: variables; Sep 24 at 11:59 PM https://learn.uwaterloo.ca/quiz/1 |
| Week 4 | Functions | Chapter 4 | Project proposal |
` }, { now });
  assert.equal(preview.method, 'rules');
  assert.equal(await getCourseSyllabus(store, 'ECE 150'), null, 'preview must not persist');
  assert.equal(preview.syllabus.entries.length, 8);
  const first = preview.syllabus.entries.find((entry) => entry.title === 'Variables and input');
  assert.equal(first.start_date, '2026-09-08');
  assert.equal(first.end_date, '2026-09-14');
  const quiz = preview.syllabus.entries.find((entry) => entry.kind === 'assessment' && entry.title.startsWith('Quiz'));
  assert.equal(quiz.start_date, '2026-09-24');
  assert.equal(quiz.end_date, '2026-09-24');
  assert.equal(quiz.due_at, Date.parse('2026-09-25T03:59:00Z'));
  assert.deepEqual(quiz.topics, ['variables']);
  assert.equal(quiz.url, 'https://learn.uwaterloo.ca/quiz/1');
  assert.equal(quiz.effort, 'small');
  const project = preview.syllabus.entries.find((entry) => entry.title === 'Project proposal');
  assert.equal(project.effort, 'large');
  assert.equal(project.due_at, null);
  assert.deepEqual(project.topics, [], 'nearby teaching topics must not become assessment coverage');
  await saveCourseSyllabus(store, 'ECE 150', preview.syllabus, { now });
  assert.deepEqual(await getCourseSyllabus(store, 'ECE 150'), preview.syllabus);
  let reads = 0;
  const original = store.settings.bind(store);
  store.settings = () => { reads++; return original(); };
  assert.equal((await listCourseSyllabi(store)).length, 1);
  assert.equal(reads, 1);
  store.close();
});

test('HTML syllabus tables retain rows and source links and recognize month date ranges', async () => {
  const preview = await previewSyllabus(null, { course: 'MATH 115', year: 2026, text: `<table><tr><th>Date</th><th>Topic</th><th>Reading</th></tr><tr><td>Sept. 21–25</td><td>Systems &amp; matrices</td><td><a href="https://example.edu/chapter-2">Chapter 2</a></td></tr><tr><td>Sep 28 - Oct 2</td><td>Vector spaces</td><td>Chapter 3</td></tr></table>` }, { now });
  assert.equal(preview.syllabus.entries.length, 4);
  assert.equal(preview.syllabus.entries[0].start_date, '2026-09-21');
  assert.equal(preview.syllabus.entries[0].end_date, '2026-09-25');
  assert.equal(preview.syllabus.entries[0].title, 'Systems & matrices');
  assert.equal(preview.syllabus.entries[1].url, 'https://example.edu/chapter-2');
  assert.equal(preview.syllabus.entries[2].end_date, '2026-10-02');
});

test('unanchored weeks, ambiguous dates and undated coverage produce warnings rather than invented dates', async () => {
  const preview = await previewSyllabus(null, { course: 'ECE 198', text: 'Week 2: Boolean algebra\nQuiz coverage: chapters 1 and 2\nSep 24: Lab project\n09/25: Quiz 2' }, { now });
  assert.equal(preview.syllabus.entries.length, 0);
  assert.ok(preview.warnings.some((warning) => warning.includes('first day of Week 1')));
  assert.ok(preview.warnings.some((warning) => warning.includes('missing year')));
  assert.ok(preview.warnings.some((warning) => warning.includes('unrecognized')));
});

test('copied table tabs, numeric week cells and empty cells preserve their column meaning', async () => {
  const preview = await previewSyllabus(null, { course: 'MATH 115', term_start: '2026-09-08', text: 'Week\tTopic\tReading\tAssessment\n1\tVectors\t\tQuiz 1\n2\tMatrices\tChapter 2\t' }, { now });
  assert.equal(preview.syllabus.entries.length, 4);
  assert.equal(preview.syllabus.entries[0].start_date, '2026-09-08');
  assert.equal(preview.syllabus.entries[1].kind, 'assessment');
  assert.deepEqual(preview.syllabus.entries[1].readings, []);
  assert.equal(preview.syllabus.entries[2].start_date, '2026-09-15');
});

test('assessment coverage is extracted only from explicit chapter, section, unit, or labeled coverage references', async () => {
  const preview = await previewSyllabus(null, { course: 'ECE 198', year: 2026, text: `Sept 23: Functions and loops
Sept 24: Quiz 2 due 11:59 PM - Chapters 1-2
Sep 25: Midterm (Sections 2.1-2.4; Units 1 and 2)
Sep 26: Quiz 3: Chapters 3 and 4
Sep 27: Quiz 4 - review all material` }, { now });
  const byTitle = new Map(preview.syllabus.entries.map((entry) => [entry.title, entry]));
  assert.deepEqual(byTitle.get('Functions and loops').topics, ['Functions and loops']);
  const quiz = [...preview.syllabus.entries].find((entry) => entry.title.startsWith('Quiz 2'));
  assert.deepEqual(quiz.topics, ['Chapters 1-2']);
  assert.equal(quiz.due_at, Date.parse('2026-09-25T03:59:00Z'));
  assert.equal(syllabusAssessmentMatches(quiz, 'ECE 198', { course: 'ECE198', title: 'Quiz 2 - Due', starts_at: quiz.due_at }), true);
  const midterm = [...preview.syllabus.entries].find((entry) => entry.title.startsWith('Midterm'));
  assert.deepEqual(midterm.topics, ['Sections 2.1-2.4; Units 1 and 2']);
  const labeled = [...preview.syllabus.entries].find((entry) => entry.title.startsWith('Quiz 3'));
  assert.deepEqual(labeled.topics, ['Chapters 3 and 4']);
  const vague = [...preview.syllabus.entries].find((entry) => entry.title.startsWith('Quiz 4'));
  assert.deepEqual(vague.topics, [], 'generic revision wording must not be treated as verified coverage');
});

test('invalid calendar dates and reversed ranges are excluded; save validates bounds and URL schemes', async () => {
  const preview = await previewSyllabus(null, { course: 'ECE 198', year: 2026, text: 'Feb 30: Impossible quiz\nOct 5 - Sep 2: Impossible project\n2026-09-23: Lab design' }, { now });
  assert.equal(preview.syllabus.entries.length, 1);
  const store = new SqliteStore(':memory:');
  const entry = preview.syllabus.entries[0];
  for (const change of [{ start_date: '2026-02-30' }, { end_date: '2026-09-01' }, { url: 'javascript:alert(1)' }, { estimated_minutes: 6001 }]) {
    await assert.rejects(saveCourseSyllabus(store, 'ECE 198', { ...preview.syllabus, entries: [{ ...entry, ...change }] }, { now }));
  }
  await assert.rejects(saveCourseSyllabus(store, 'bad course', preview.syllabus, { now }));
  store.close();
});

test('AI extract ignores invented source evidence and falls back cleanly when unavailable', async () => {
  const text = 'ECE 150 Fall 2026\nSep 24: Quiz 1 covers: loops\nExtra information';
  const cfEnv = { AI: { run: async () => ({ response: JSON.stringify({ entries: [
    { title: 'Quiz 1 covers: loops', kind: 'assessment', evidence: 'Sep 24: Quiz 1 covers: loops' },
    { title: 'Quiz 2 covers: arrays', kind: 'assessment', evidence: 'Sep 25: Quiz 2 covers: arrays' },
  ] }) }) } };
  const preview = await previewSyllabus(null, { course: 'ECE 150', text, use_ai: true }, { cfEnv, now });
  assert.equal(preview.method, 'ai');
  assert.equal(preview.syllabus.entries.length, 1);
  assert.deepEqual(preview.syllabus.entries[0].topics, ['loops']);
  const unavailable = await previewSyllabus(null, { course: 'ECE 150', text, use_ai: true }, { cfEnv: { AI: { run: async () => { throw new Error('quota'); } } }, now });
  assert.equal(unavailable.method, 'rules');
  assert.equal(unavailable.syllabus.entries.length, 1);
  assert.ok(unavailable.warnings.some((warning) => warning.includes('allowance')));
});

test('AI budget refusal runs no model call and leaves a usable rules preview', async () => {
  let modelCalls = 0;
  let claims = 0;
  const preview = await previewSyllabus(null, { course: 'ECE 150', year: 2026, text: 'Sep 24: Loops', use_ai: true }, {
    now, cfEnv: { AI: { run: async () => { modelCalls++; return { response: '{"entries":[]}' }; } } },
    beforeAiCall: async () => { claims++; throw new Error('daily budget exhausted'); },
  });
  assert.equal(claims, 1);
  assert.equal(modelCalls, 0);
  assert.equal(preview.method, 'rules');
  assert.equal(preview.syllabus.entries[0].title, 'Loops');
});

test('string values for use_ai cannot trigger a metered AI call', async () => {
  let modelCalls = 0;
  await assert.rejects(previewSyllabus(null, {
    course: 'ECE 198', year: 2026, text: 'Sep 24: Quiz 2', use_ai: 'false',
  }, {
    now,
    cfEnv: { AI: { run: async () => { modelCalls++; return { response: '{"entries":[]}' }; } } },
  }), /use_ai must be a boolean/);
  assert.equal(modelCalls, 0);
});

test('multi-line block syllabus extracts weekly learning topics and assessments with anchored dates', async () => {
  const text = `ECE105 course schedule: Note this is meant as a guide and not as an absolute schedule.
Week 1
Mathematics necessary for describing physics. Coordinate systems (1D,2D,maybe some
3D) and unit vectors. Cartesian and circular coordinates.
Materials from textbook:
Assignment #1 due Sunday Sept 20
Quiz #1 Friday Sept 18
Week 2 +
Solving for Motion in 1D and 2D with constant linear acceleration. Problem solving
techniques.
Materials from textbook:
Assignment #2 due Sunday Sept 27
Quiz #2 Friday Sept 25
Week 7
Rotational motion. Newton’s laws in rotational motion. Torque.
Materials from textbook:
Assignment #7 due Sunday Nov15
Quiz #7 Friday Nob 13`;

  const preview = await previewSyllabus(null, { course: 'ECE 105', year: 2020, text }, { now });
  assert.equal(preview.method, 'rules');
  assert.equal(preview.syllabus.term_start, '2020-09-14', 'infers term_start Monday from Week 1 dates');

  const topics = preview.syllabus.entries.filter((entry) => entry.kind === 'topic');
  assert.equal(topics.length, 3);
  assert.equal(topics[0].title, 'Mathematics necessary for describing physics');
  assert.equal(topics[0].start_date, '2020-09-14');
  assert.equal(topics[0].end_date, '2020-09-20');
  assert.ok(topics[0].topics.includes('Mathematics necessary for describing physics'));
  assert.ok(topics[0].topics.some((t) => t.includes('Coordinate systems')));

  assert.equal(topics[1].title, 'Solving for Motion in 1D and 2D with constant linear acceleration');
  assert.equal(topics[1].start_date, '2020-09-21');
  assert.equal(topics[1].end_date, '2020-09-27');

  assert.equal(topics[2].title, 'Rotational motion');
  assert.equal(topics[2].start_date, '2020-11-09');
  assert.equal(topics[2].end_date, '2020-11-15');

  const assessments = preview.syllabus.entries.filter((entry) => entry.kind === 'assessment');
  assert.equal(assessments.length, 6);
  assert.equal(assessments.find((a) => a.title === 'Assignment #1').start_date, '2020-09-20');
  assert.equal(assessments.find((a) => a.title === 'Quiz #1').start_date, '2020-09-18');
  assert.equal(assessments.find((a) => a.title === 'Assignment #7').start_date, '2020-11-15');
  assert.equal(assessments.find((a) => a.title === 'Quiz #7').start_date, '2020-11-13');
});

