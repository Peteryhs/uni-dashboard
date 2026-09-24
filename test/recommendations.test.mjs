import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendationsFromData, buildRecommendations, rankRecommendationItems, saveRecommendationAction } from '../apps/relay/src/recommendations.mjs';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { at, DATE, syntheticDay } from './helpers/recommendation-day.mjs';

test('day simulation adapts from class preparation to lunch and evening deadline', () => {
  const data = syntheticDay();
  const expected = [['08:00', 'class'], ['09:10', 'class'], ['11:45', 'food'], ['14:05', 'class'], ['20:00', 'task']];
  for (const [time, kind] of expected) {
    const feed = recommendationsFromData({ ...data, now: at(DATE, time) });
    assert.equal(feed.items[0].kind, kind, `${time} top priority`);
    assert.equal(feed.refresh_after_ms, 60_000);
  }
  const morning = recommendationsFromData({ ...data, now: at(DATE, '08:00') });
  assert.deepEqual(morning.items[0].topics, ['Pointers and references']);
  const quiz = morning.tasks.small.find(task => task.title.includes('Quiz 2'));
  assert.deepEqual(quiz.topics, ['Loops and functions'], 'quiz coverage comes from matched assessment, never today’s lecture');
  assert.equal(quiz.action.label, 'Open quiz');
  assert.equal(morning.tasks.small.filter(task => task.title.includes('Quiz 2')).length, 1, 'LEARN and syllabus represent one quiz');
  assert.ok(morning.tasks.large.find(task => task.title.includes('Design project')), 'large project visible five days before due');
  assert.ok(morning.items.find(item => item.kind === 'weather').body.includes('rain protection'));
  const afternoon = recommendationsFromData({ ...data, now: at(DATE, '15:10') });
  assert.ok(afternoon.items.some(item => item.kind === 'office_hours' && item.course === 'ECE 198'));
});

test('lunch never takes priority over an imminent assessment or an in-progress class', () => {
  const data = syntheticDay();
  data.calendar.days[0].events.find(event => event.id === 'quiz').starts_at = at(DATE, '12:10');
  let feed = recommendationsFromData({ ...data, now: at(DATE, '11:45') });
  assert.equal(feed.items[0].kind, 'task');
  data.calendar.days[0].events = data.calendar.days[0].events.filter(event => event.id !== 'quiz');
  data.calendar.days[0].events.find(event => event.id === 'class-ece150').ends_at = at(DATE, '12:00');
  feed = recommendationsFromData({ ...data, now: at(DATE, '11:45') });
  assert.equal(feed.items[0].kind, 'class');
  assert.match(feed.items.find(item => item.kind === 'food').body, /next break/);
});

test('lunch names the AI-highlighted dishes instead of the first menu rows', () => {
  const data = syntheticDay();
  data.menu = [
    { service_date: DATE, outlet: 'Campus Cafe', dish: 'Pasta', url: 'https://example.edu/pasta' },
    { service_date: DATE, outlet: 'Campus Cafe', dish: 'Tofu bowl', url: 'https://example.edu/tofu' },
    { service_date: DATE, outlet: 'Campus Cafe', dish: 'Soup', url: 'https://example.edu/soup' },
  ];
  data.food.recommendation.ranked_outlets[0].highlights = [{ dish: 'Tofu bowl', why: 'Plant protein' }];
  const lunch = recommendationsFromData({ ...data, now: at(DATE, '11:45') }).items.find(item => item.kind === 'food');
  assert.match(lunch.body, /Tofu bowl\./);
  assert.doesNotMatch(lunch.body, /AI picks?:/i);
  assert.doesNotMatch(lunch.body, /Pasta|Soup/);
  assert.equal(lunch.action.url, 'https://example.edu/tofu');
  data.food.recommendation.ranked_outlets[0].highlights = [{ dish: 'Missing dish', why: 'Not posted' }];
  const unmatched = recommendationsFromData({ ...data, now: at(DATE, '11:45') }).items.find(item => item.kind === 'food');
  assert.match(unmatched.body, /No AI-highlighted dish matched/);
  assert.doesNotMatch(unmatched.body, /Pasta|Tofu bowl|Soup/);
});

test('lunch title uses the short dining hall name', () => {
  const data = syntheticDay();
  const outlet = 'The Market - Residence Dining Hall';
  data.food.recommendation.top_outlet = outlet;
  data.food.recommendation.ranked_outlets[0].outlet = outlet;
  data.menu = [{ service_date: DATE, outlet, dish: 'Butter Chicken', url: 'https://example.edu/butter-chicken' }];
  const lunch = recommendationsFromData({ ...data, now: at(DATE, '11:45') }).items.find(item => item.kind === 'food');
  assert.equal(lunch.title, 'Lunch: The Market');
});

test('ambiguous LEARN events stay visible in calendar without blocking study windows or becoming tasks', () => {
  const data = syntheticDay();
  data.calendar.days[0].events.push({
    id: 'learn-stream-event', source_id: 'uw-learn-ics', category: 'event', kind: 'event',
    title: '8 Stream CIVE, SYDE - Mandatory Résumé Review Event', course: 'CFE',
    starts_at: at(DATE, '11:00'), ends_at: at(DATE, '13:00'), all_day: false,
    source_label: 'LEARN', state: 'live', location: 'CMH Great Hall', links: [], description: '',
  });
  const feed = recommendationsFromData({ ...data, now: at(DATE, '10:30') });
  assert.ok(!feed.tasks.small.some(task => task.title.includes('Résumé Review Event')));
  assert.ok(!feed.items.some(item => item.kind === 'conflict'));
  const focus = feed.items.find(item => item.kind === 'focus');
  assert.ok(focus);
  assert.equal(focus.ends_at, at(DATE, '14:00'), 'the ambiguous LEARN event does not cut off an open study window');
});

test('quiz coverage uses only explicit LEARN description text and formats due times cleanly', () => {
  const data = syntheticDay();
  data.calendar.days[0].events.push({
    id: 'resume-quiz', source_id: 'uw-learn-ics', category: 'deadline', kind: 'deadline',
    title: 'Résumé Quiz - 15 minutes - Due', course: 'CFE', starts_at: at(DATE, '23:59'), ends_at: at(DATE, '23:59'),
    all_day: false, source_label: 'LEARN', state: 'live', location: '', links: [{ kind: 'quiz', url: 'https://learn.uwaterloo.ca/d2l/lms/quizzing/quiz', label: 'Quiz' }],
    description: 'Please complete once you have reviewed the content in Part 2.',
  });
  const feed = recommendationsFromData({ ...data, now: at(DATE, '08:00') });
  const quiz = feed.tasks.small.find(task => task.title === 'Résumé Quiz');
  assert.deepEqual(quiz.topics, ['Part 2']);
  assert.match(quiz.body, /Coverage: Part 2\./);
  assert.match(quiz.body, /Due today at 11:59 pm\./);
  assert.doesNotMatch(quiz.body, /\.\./);
});

test('tasks with unknown coverage and date-only assessments do not acquire invented facts', () => {
  const data = syntheticDay();
  data.syllabi[0].entries = data.syllabi[0].entries.filter(entry => entry.kind === 'topic');
  data.syllabi.push({ course: 'ECE 198', entries: [{ id: 'date-only', kind: 'assessment', title: 'Quiz 3', start_date: DATE, end_date: DATE, due_at: null, topics: [], readings: [], effort: 'unknown', estimated_minutes: null }] });
  const feed = recommendationsFromData({ ...data, now: at(DATE, '08:00') });
  const quiz = feed.tasks.small.find(task => task.course === 'ECE 150');
  assert.deepEqual(quiz.topics, []);
  assert.match(quiz.body, /Coverage has not been provided/);
  const dateOnly = feed.tasks.small.find(task => task.title === 'Quiz 3');
  assert.equal(dateOnly.due_at, null);
  assert.equal(dateOnly.scheduled_date, DATE);
  assert.match(dateOnly.body, /no exact time/);
  assert.equal(dateOnly.estimated_minutes, null);
  assert.equal(dateOnly.action.label, 'Open course', 'course shortcut is labelled honestly');
});

test('completion survives time passing, snooze expires, undo works, and changed due date resurfaces', async () => {
  const data = syntheticDay(), store = new SqliteStore(':memory:');
  const now = at(DATE, '08:00');
  const quiz = recommendationsFromData({ ...data, now }).tasks.small[0];
  await saveRecommendationAction(store, { id: quiz.id, action: 'done' }, { now });
  let actions = JSON.parse(store.getSetting('RECOMMENDATION_ACTIONS_JSON'));
  let feed = recommendationsFromData({ ...data, actions, now: at('2026-09-24', '00:05') });
  assert.ok(!feed.tasks.small.some(task => task.id === quiz.id), 'done quiz stays done when deadline passes');
  assert.ok(!feed.tasks.small.some(task => task.title.includes('Quiz 2')));
  await saveRecommendationAction(store, { id: quiz.id, action: 'undo' }, { now });
  actions = JSON.parse(store.getSetting('RECOMMENDATION_ACTIONS_JSON'));
  assert.ok(recommendationsFromData({ ...data, actions, now }).tasks.small.some(task => task.id === quiz.id));
  await saveRecommendationAction(store, { id: quiz.id, action: 'snooze', until: now + 60_000 }, { now });
  actions = JSON.parse(store.getSetting('RECOMMENDATION_ACTIONS_JSON'));
  assert.ok(!recommendationsFromData({ ...data, actions, now }).items.some(task => task.id === quiz.id));
  assert.ok(recommendationsFromData({ ...data, actions, now: now + 60_001 }).items.some(task => task.id === quiz.id));
  await saveRecommendationAction(store, { id: quiz.id, action: 'done' }, { now });
  actions = JSON.parse(store.getSetting('RECOMMENDATION_ACTIONS_JSON'));
  const event = data.calendar.days[0].events.find(event => event.id === 'quiz');
  event.starts_at += 60_000;
  feed = recommendationsFromData({ ...data, actions, now });
  assert.ok(feed.tasks.small.some(task => task.title.includes('Quiz 2')), 'changed due date reappears');
  await assert.rejects(saveRecommendationAction(store, { id: quiz.id, action: 'snooze', until: now + 8 * 86400_000 }, { now }), /seven days/);
  store.close();
});

test('overdue is unconfirmed, stale sources are visible, and yesterday’s menu is never a lunch suggestion', () => {
  const data = syntheticDay();
  data.calendar.sources[0].status = 'failed';
  data.calendar.days[0].events.forEach(event => { event.state = 'dead'; });
  const feed = recommendationsFromData({ ...data, now: at('2026-09-24', '11:45') });
  const quiz = feed.tasks.small.find(task => task.title.includes('Quiz 2'));
  assert.match(quiz.title, /Confirm submission/);
  assert.match(quiz.body, /submission status is unknown/);
  assert.equal(quiz.state, 'dead');
  assert.ok(feed.warnings.some(warning => warning.includes('latest sync failed')));
  assert.ok(feed.warnings.some(warning => warning.includes('details are old')));
  assert.ok(!feed.items.some(item => item.kind === 'food'));
});

test('schedule conflicts are surfaced, focus windows avoid commitments, and weekend remains useful', () => {
  const data = syntheticDay();
  const lecture = data.calendar.days[0].events[0];
  data.calendar.days[0].events.push({ ...lecture, id: 'overlap', title: 'Other course', course: 'ECE 198', starts_at: at(DATE, '09:30'), ends_at: at(DATE, '10:30') });
  const during = recommendationsFromData({ ...data, now: at(DATE, '09:20') });
  assert.ok(during.items.some(item => item.kind === 'conflict'));
  assert.ok(!during.items.some(item => item.kind === 'focus'));
  const morning = recommendationsFromData({ ...data, now: at(DATE, '08:00') });
  assert.equal(morning.items.find(item => item.kind === 'focus').available_minutes, 60);
  const weekend = recommendationsFromData({ ...data, now: at('2026-09-26', '10:00') });
  assert.equal(weekend.items[0].kind, 'task');
  assert.ok(!weekend.items.some(item => item.kind === 'class'));
  assert.ok(weekend.items.some(item => item.kind === 'focus'));
});

test('similar non-urgent work rotates courses while urgent priority is preserved', () => {
  const task = (id, course, priority) => ({ id, course, priority });
  const ranked = rankRecommendationItems([task('a', 'ECE 150', 740), task('b', 'ECE 150', 740), task('c', 'MATH 117', 720)]);
  assert.deepEqual(ranked.map(item => item.id), ['a', 'c', 'b']);
  const urgent = rankRecommendationItems([task('a', 'ECE 150', 1030), task('b', 'ECE 150', 1030), task('c', 'MATH 117', 1010)]);
  assert.deepEqual(urgent.map(item => item.id), ['a', 'b', 'c']);
});

test('backend engine builds from persisted facts with no network and a bounded number of reads', async () => {
  const store = new SqliteStore(':memory:'), now = at(DATE, '08:00');
  store.upsertRows('timeline_event', [{ source_id: 'uw-learn-ics', external_id: 'quiz2', kind: 'deadline', title: 'ECE 150 - Quiz 2 - Due', location: 'ECE 150 - Fall 2026', starts_at: at(DATE, '23:59'), ends_at: at(DATE, '23:59'), observed_at: now, valid_until: now + 900_000 }]);
  let reads = 0;
  for (const name of ['rows', 'getSetting', 'settings', 'lastRunPerSource']) {
    const original = store[name].bind(store);
    store[name] = (...args) => { reads++; return original(...args); };
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('feed must never fetch'); };
  try {
    const feed = await buildRecommendations(store, { now });
    assert.equal(feed.tasks.small.length, 1);
    assert.ok(reads <= 12, `${reads} reads`);
  } finally { globalThis.fetch = originalFetch; store.close(); }
});

test('time preview changes the decision clock without ageing newly synced source data', async () => {
  const store = new SqliteStore(':memory:');
  const actualNow = at(DATE, '08:00');
  const selectedTime = at(DATE, '12:10');
  store.upsertRows('timeline_event', [{
    source_id: 'uw-portal-ics', external_id: 'math-class', kind: 'class', title: 'MATH 117 LEC',
    starts_at: at(DATE, '12:00'), ends_at: at(DATE, '13:00'),
    observed_at: actualNow, valid_until: actualNow + 86400_000,
  }]);
  try {
    const preview = await buildRecommendations(store, { now: selectedTime, freshnessNow: actualNow });
    const currentClass = preview.items.find(item => item.kind === 'class');
    assert.equal(currentClass.title, 'Now: MATH 117 LEC');
    assert.equal(currentClass.state, 'live');
    assert.equal(preview.generated_at, selectedTime);
    const agedAsIfFutureWereReal = await buildRecommendations(store, { now: selectedTime });
    assert.notEqual(agedAsIfFutureWereReal.items.find(item => item.kind === 'class').state, 'live');
  } finally { store.close(); }
});

test('annotation-rich assessment matches without merging differently numbered quizzes', () => {
  const data = syntheticDay();
  const assessment = data.syllabi[0].entries.find(entry => entry.kind === 'assessment');
  assessment.title = 'Quiz 2 | topics: loops and functions | 11:59 PM';
  data.syllabi[0].entries.push({ ...assessment, id: 'quiz20', title: 'Quiz 20 | topics: arrays | 11:59 PM', topics: ['Arrays'] });
  const feed = recommendationsFromData({ ...data, now: at(DATE, '08:00') });
  assert.equal(feed.tasks.small.length, 2);
  const quiz = feed.tasks.small.find(task => task.title === 'ECE 150 - Quiz 2');
  assert.deepEqual(quiz.topics, ['Loops and functions']);
  assert.equal(quiz.source_label, 'LEARN + syllabus');
});

test('focus and class snoozes remain stable over refreshes and class status transitions', async () => {
  const data = syntheticDay(), store = new SqliteStore(':memory:');
  const now = at(DATE, '08:00'), initial = recommendationsFromData({ ...data, now });
  for (const kind of ['focus', 'class']) {
    const candidate = initial.items.find(item => item.kind === kind);
    await saveRecommendationAction(store, { id: candidate.id, action: 'snooze', until: at(DATE, '09:30') }, { now });
  }
  const actions = JSON.parse(store.getSetting('RECOMMENDATION_ACTIONS_JSON'));
  const later = recommendationsFromData({ ...data, actions, now: at(DATE, '08:50') });
  assert.ok(!later.items.some(item => item.kind === 'focus'));
  assert.ok(!later.items.some(item => item.kind === 'class' && item.course === 'ECE 150'));
  const ongoing = recommendationsFromData({ ...data, actions, now: at(DATE, '09:05') });
  assert.ok(!ongoing.items.some(item => item.kind === 'class' && item.course === 'ECE 150'));
  store.close();
});

test('unknown weather is not cold, old food carries old state, and weekly topics are labelled as a period', () => {
  const data = syntheticDay();
  data.weather.forecast[0] = { at: at(DATE, '14:00'), temp_c: null, feels_c: null, precip_prob: null, precip_mm: null, wind_kmh: null };
  data.syllabi[0].entries[0].start_date = '2026-09-21';
  data.syllabi[0].entries[0].end_date = '2026-09-27';
  data.food.updated_at = at('2026-09-21', '09:00');
  data.menu[0].observed_at = at('2026-09-21', '09:00');
  const lunch = recommendationsFromData({ ...data, now: at(DATE, '11:45') });
  assert.equal(lunch.items.find(item => item.kind === 'weather').title, 'Weather for your next break');
  assert.equal(lunch.items.find(item => item.kind === 'food').state, 'stale');
  const morning = recommendationsFromData({ ...data, now: at(DATE, '08:00') });
  assert.match(morning.items.find(item => item.kind === 'class' && item.course === 'ECE 150').body, /for this period/);
  const reading = morning.items.find(item => item.kind === 'learning');
  assert.match(reading.reason, /exact lecture topic is not confirmed/);
  const tomorrow = recommendationsFromData({ ...data, now: at('2026-09-24', '08:00'), actions: { [reading.id]: { action: 'done' } } });
  assert.ok(!tomorrow.items.some(item => item.kind === 'learning'), 'completed weekly reading stays complete on the next day');
});

test('ongoing exams stay ahead of lunch and all-day assessments never acquire midnight deadlines', () => {
  const data = syntheticDay();
  data.calendar.days[0].events.push({ ...data.calendar.days[0].events[0], id: 'exam', category: 'exam', title: 'ECE 150 midterm', starts_at: at(DATE, '11:30'), ends_at: at(DATE, '13:00') });
  const noon = recommendationsFromData({ ...data, now: at(DATE, '11:45') });
  assert.match(noon.items[0].title, /^Now: ECE 150 midterm/);
  assert.equal(noon.items[0].priority, 1200);
  assert.equal(noon.items[0].due_at, null);
  assert.equal(noon.items[0].time_label, 'Starts');
  const quiz = data.calendar.days[0].events.find(event => event.id === 'quiz');
  quiz.all_day = true; quiz.starts_at = at(DATE, '00:00');
  data.syllabi = [];
  const allDay = recommendationsFromData({ ...data, now: at(DATE, '08:00') }).tasks.small.find(task => task.title.includes('Quiz 2'));
  assert.equal(allDay.due_at, null);
  assert.match(allDay.body, /no exact time/);
  assert.ok(!allDay.title.includes('Confirm'));
});
