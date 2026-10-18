import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendationsFromData, buildRecommendations, rankRecommendationItems, saveRecommendationAction } from '../apps/relay/src/recommendations.mjs';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { validateRecommendations } from '#contract/recommendations.mjs';
import { at, DATE, syntheticDay } from './helpers/recommendation-day.mjs';
import { makeCasBarrierStore } from './helpers/cas-barrier-store.mjs';

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
  assert.ok(morning.items.find(item => item.kind === 'weather').body.includes('umbrella'));
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
  assert.deepEqual(quiz.warnings, ['coverage_unknown']);
  assert.doesNotMatch(quiz.body, /Coverage has not been provided|check the course instructions/i);
  const dateOnly = feed.tasks.small.find(task => task.title === 'Quiz 3');
  assert.equal(dateOnly.due_at, null);
  assert.equal(dateOnly.scheduled_date, DATE);
  assert.deepEqual(dateOnly.warnings, ['time_unknown', 'coverage_unknown']);
  assert.equal(dateOnly.body, `Listed for ${DATE}.`);
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
  await saveRecommendationAction(store, { id: quiz.id, action: 'dismiss' }, { now });
  actions = JSON.parse(store.getSetting('RECOMMENDATION_ACTIONS_JSON'));
  assert.ok(!recommendationsFromData({ ...data, actions, now }).items.some(task => task.id === quiz.id));
  assert.ok(!recommendationsFromData({ ...data, actions, now: now + 86400_000 }).items.some(task => task.id === quiz.id));
  store.close();
});

test('concurrent recommendation actions preserve unrelated entries, including when undoing', async () => {
  const data = syntheticDay(), now = at(DATE, '08:00');
  const feed = recommendationsFromData({ ...data, now });
  const quiz = feed.tasks.small.find(task => task.title.includes('Quiz 2'));
  const other = feed.tasks.large[0];
  assert.ok(quiz && other, 'fixture has a small and a large actionable task');
  const key = 'RECOMMENDATION_ACTIONS_JSON';
  const store = makeCasBarrierStore({ key, barrierReads: 2 });

  await Promise.all([
    saveRecommendationAction(store, { id: quiz.id, action: 'done' }, { now }),
    saveRecommendationAction(store, { id: other.id, action: 'dismiss' }, { now }),
  ]);
  let actions = JSON.parse(store.settings.get(key));
  assert.equal(actions[quiz.id].action, 'done');
  assert.equal(actions[other.id].action, 'dismiss');

  await Promise.all([
    saveRecommendationAction(store, { id: quiz.id, action: 'undo' }, { now }),
    saveRecommendationAction(store, { id: other.id, action: 'snooze', until: now + 60_000 }, { now }),
  ]);
  actions = JSON.parse(store.settings.get(key));
  assert.equal(actions[quiz.id], undefined);
  assert.equal(actions[other.id].action, 'snooze');
});

test('recommendation action CAS contention fails with an explicit retryable conflict', async () => {
  const store = makeCasBarrierStore({ key: 'RECOMMENDATION_ACTIONS_JSON', barrierReads: 1, alwaysFail: true });
  await assert.rejects(
    saveRecommendationAction(store, { id: 'rec:task:course:quiz', action: 'done' }, { now: at(DATE, '08:00') }),
    error => error.status === 409 && error.retryable === true && /please retry/i.test(error.message),
  );
});

test('task completion carries exact calendar identity and structured action for notification cleanup', () => {
  const data = syntheticDay(), now = at(DATE, '08:00');
  const initial = recommendationsFromData({ ...data, now });
  const quiz = initial.tasks.small.find(task => task.title.includes('Quiz 2'));
  assert.equal(quiz.source_event_id, 'quiz');

  for (const action of ['done', 'dismiss', 'snooze']) {
    const feed = recommendationsFromData({ ...data, now, actions: { [quiz.id]: { action, until: now + 60_000 } } });
    const decision = feed.diagnostics.candidates.find(candidate => candidate.id === quiz.id);
    assert.equal(decision.source_event_id, 'quiz');
    assert.equal(decision.suppressed_action, action);
    assert.equal(decision.status, 'suppressed');
  }
  const restored = recommendationsFromData({ ...data, now, actions: {} }).diagnostics.candidates.find(candidate => candidate.id === quiz.id);
  assert.equal(restored.source_event_id, 'quiz');
  assert.equal(restored.suppressed_action, null, 'undo restores the exact task without a lingering completion flag');

  const legacy = structuredClone(initial);
  for (const item of [...legacy.items, ...legacy.tasks.small, ...legacy.tasks.large]) delete item.source_event_id;
  for (const decision of legacy.diagnostics.candidates) {
    delete decision.source_event_id;
    delete decision.suppressed_action;
  }
  const parsed = validateRecommendations(legacy);
  assert.ok(parsed.items.every(item => item.source_event_id === null));
  assert.ok(parsed.diagnostics.candidates.every(item => item.source_event_id === null && item.suppressed_action === null));
});

test('overdue is unconfirmed, stale sources are visible, and yesterday’s menu is never a lunch suggestion', () => {
  const data = syntheticDay();
  data.calendar.sources[0].status = 'failed';
  data.calendar.days[0].events.forEach(event => {
    event.state = 'dead';
    event.source_id = event.source_label === 'LEARN' ? 'uw-learn-ics' : event.category === 'office_hours' ? 'user-office-hours' : 'uw-portal-ics';
  });
  const feed = recommendationsFromData({ ...data, now: at('2026-09-24', '11:45') });
  const quiz = feed.tasks.small.find(task => task.title.includes('Quiz 2'));
  assert.match(quiz.title, /Confirm submission/);
  assert.deepEqual(quiz.warnings, ['submission_unknown']);
  assert.match(quiz.body, /listed due time has passed/);
  assert.equal(quiz.state, 'dead');
  assert.ok(feed.warnings.some(warning => warning.includes('latest sync failed')));
  const freshnessWarnings = feed.warnings.filter(warning => warning.includes('data is old'));
  assert.deepEqual(freshnessWarnings.map(warning => warning.split(' data is old')[0]), ['Class schedule', 'LEARN calendar', 'Office hours']);
  assert.ok(freshnessWarnings.every(warning => warning.includes('reflects sync age') && warning.includes('not a confirmed event change')));
  assert.ok(!feed.items.some(item => item.kind === 'food'));
});

test('calendar freshness warning identifies only stale sources and deduplicates their events', () => {
  const data = syntheticDay();
  const [schedule, secondSchedule, learn] = data.calendar.days[0].events;
  schedule.source_id = secondSchedule.source_id = 'uw-portal-ics';
  schedule.state = secondSchedule.state = 'stale';
  learn.source_id = 'uw-learn-ics';
  learn.state = 'live';
  const feed = recommendationsFromData({ ...data, now: at(DATE, '08:00') });
  const freshnessWarnings = feed.warnings.filter(warning => warning.includes('data is old'));
  assert.equal(freshnessWarnings.length, 1);
  assert.match(freshnessWarnings[0], /^Class schedule data is old/);
  assert.match(freshnessWarnings[0], /reflects sync age, not a confirmed event change/);
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

test('Friday room changes wait until the day before and retain their before/after detail', () => {
  const data = syntheticDay();
  const friday = at('2026-09-25', '09:00');
  data.calendar.days[0].events.push({ id: 'friday-room-class', uid: 'ece150-friday-series', source_id: 'uw-portal-ics', category: 'class',
    title: 'ECE 150 lecture', course: 'ECE 150', starts_at: friday, ends_at: friday + 60 * 60_000, location: 'RCH 101', state: 'live', source_label: 'Schedule', links: [] });
  data.calendar.alerts = [{ id: 'friday-room-change', event_id: 'friday-room-class', kind: 'room', title: 'ECE 150: Room changed',
    body: 'ECE 150 lecture · E7 2409 → RCH 101', course: 'ECE 150', starts_at: friday, ends_at: friday + 60 * 60_000,
    observed_at: at('2026-09-22', '19:00'), location: 'RCH 101', previous_location: 'E7 2409', previous_at: null, current_at: null,
    all_day: false, url: 'https://example.edu/calendar', confidence: 'confirmed', evidence: 'Compared two successfully parsed calendar snapshots.',
    source_label: 'Schedule', state: 'live' }];

  const tuesday = recommendationsFromData({ ...data, now: at('2026-09-22', '21:00') });
  const roomDecision = tuesday.diagnostics.candidates.find(candidate => candidate.kind === 'change' && candidate.title === 'ECE 150: Room changed');
  assert.equal(roomDecision.status, 'deferred');
  assert.equal(roomDecision.eligible_at, at('2026-09-24', '09:00'));
  assert.equal(roomDecision.change.previous_location, 'E7 2409');
  assert.equal(roomDecision.change.location, 'RCH 101');
  assert.ok(!tuesday.items.some(candidate => candidate.kind === 'change' && candidate.title === 'ECE 150: Room changed'));

  const before = recommendationsFromData({ ...data, now: at('2026-09-24', '08:59') });
  assert.equal(before.diagnostics.candidates.find(candidate => candidate.kind === 'change').status, 'deferred');
  const eligible = recommendationsFromData({ ...data, now: at('2026-09-24', '09:00') });
  const change = eligible.items.find(candidate => candidate.kind === 'change');
  assert.ok(change, 'the reminder enters daily suggestions exactly 24 hours before class');
  assert.equal(change.change.previous_location, 'E7 2409');
  assert.equal(change.change.location, 'RCH 101');
  assert.equal(eligible.diagnostics.candidates.find(candidate => candidate.kind === 'change').status, 'shown');

  const oldClientPayload = { ...eligible };
  delete oldClientPayload.diagnostics;
  assert.doesNotThrow(() => validateRecommendations(oldClientPayload), 'older payloads remain valid without diagnostics');
  const cachedOldDiagnostics = structuredClone(eligible);
  delete cachedOldDiagnostics.diagnostics.policy.tutorial_work_notice_hours;
  const oldRoomCandidate = cachedOldDiagnostics.diagnostics.candidates.find(candidate => candidate.kind === 'change');
  delete oldRoomCandidate.change;
  const upgradedDiagnostics = validateRecommendations(cachedOldDiagnostics).diagnostics;
  assert.equal(upgradedDiagnostics.policy.tutorial_work_notice_hours, 72, 'old cached diagnostics receive the policy default');
  assert.equal(upgradedDiagnostics.candidates.find(candidate => candidate.kind === 'change').change, null, 'old cached candidates receive the optional detail default');
});

test('small tasks enter the daily feed two days before due while larger work appears earlier', () => {
  const data = syntheticDay();
  const due = at('2026-09-28', '18:00');
  data.calendar.days[0].events.push({ id: 'survey', category: 'deadline', title: 'ECE 150 - Course survey - Due', course: 'ECE 150',
    starts_at: due, ends_at: due, due_at: due, all_day: false, state: 'live', source_label: 'LEARN', links: [] });

  const early = recommendationsFromData({ ...data, now: at(DATE, '08:00') });
  const survey = early.diagnostics.candidates.find(candidate => candidate.kind === 'task' && candidate.title.includes('Course survey'));
  assert.equal(survey.status, 'deferred');
  assert.equal(survey.eligible_at, at('2026-09-26', '18:00'));
  assert.ok(early.tasks.small.some(task => task.title.includes('Course survey')), 'the task remains available in the task list');
  assert.ok(!early.items.some(candidate => candidate.kind === 'task' && candidate.title.includes('Course survey')));
  assert.ok(early.items.some(candidate => candidate.kind === 'task' && candidate.title.includes('Design project')), 'larger work can surface several days ahead');

  const atWindow = recommendationsFromData({ ...data, now: at('2026-09-26', '18:00') });
  assert.ok(atWindow.items.some(candidate => candidate.kind === 'task' && candidate.title.includes('Course survey')));
  assert.equal(atWindow.diagnostics.candidates.find(candidate => candidate.kind === 'task' && candidate.title.includes('Course survey')).status, 'shown');
});

test('date-only task diagnostics retain the scheduled day without inventing a timestamp', () => {
  const data = syntheticDay();
  const quiz = data.syllabi[0].entries.find(entry => entry.kind === 'assessment');
  data.syllabi[0].entries.push({ ...quiz, id: 'quiz4', title: 'Quiz 4', due_at: null, start_date: '2026-09-26', end_date: '2026-09-26' });
  const feed = recommendationsFromData({ ...data, now: at(DATE, '08:00') });
  const task = feed.tasks.small.find(item => item.title.includes('Quiz 4'));
  const candidate = feed.diagnostics.candidates.find(item => item.kind === 'task' && item.title.includes('Quiz 4'));
  assert.equal(task.due_at, null);
  assert.equal(task.starts_at, null);
  assert.equal(task.scheduled_date, '2026-09-26');
  assert.equal(candidate.due_at, null);
  assert.equal(candidate.starts_at, null);
  assert.equal(candidate.scheduled_date, '2026-09-26');

  const olderCandidate = structuredClone(candidate);
  delete olderCandidate.scheduled_date;
  const parsed = validateRecommendations({ ...feed, diagnostics: { ...feed.diagnostics, candidates: feed.diagnostics.candidates.map(item => item.id === candidate.id ? olderCandidate : item) } });
  assert.equal(parsed.diagnostics.candidates.find(item => item.id === candidate.id).scheduled_date, null, 'older cached diagnostics default the new date field');
});

test('deadline changes enter within 72 hours and capped suggestions remain explainable', () => {
  const data = syntheticDay();
  const deadline = at('2026-09-25', '18:00');
  data.calendar.days[0].events.push({ id: 'friday-assignment', category: 'deadline', title: 'ECE 150 - Assignment 4 - Due', course: 'ECE 150',
    starts_at: deadline, ends_at: deadline, due_at: deadline, all_day: false, state: 'live', source_label: 'LEARN', links: [] });
  data.calendar.alerts = [{ id: 'assignment-time-change', event_id: 'friday-assignment', kind: 'deadline', title: 'ECE 150: Deadline changed',
    body: 'Assignment due time changed', course: 'ECE 150', starts_at: deadline, ends_at: deadline, observed_at: at('2026-09-22', '12:00'),
    location: '', previous_location: '', previous_at: null, current_at: deadline, all_day: false, url: null, confidence: 'confirmed',
    evidence: 'Compared two successfully parsed calendar snapshots.', source_label: 'LEARN', state: 'live' }];

  const oneMinuteEarly = recommendationsFromData({ ...data, now: at('2026-09-22', '17:59') });
  const earlyChange = oneMinuteEarly.diagnostics.candidates.find(candidate => candidate.kind === 'change');
  assert.equal(earlyChange.status, 'deferred');
  assert.equal(earlyChange.eligible_at, at('2026-09-22', '18:00'));
  const atWindow = recommendationsFromData({ ...data, now: at('2026-09-22', '18:00') });
  assert.equal(atWindow.diagnostics.candidates.find(candidate => candidate.kind === 'change').status, 'shown');

  const crowded = syntheticDay();
  crowded.calendar.alerts = Array.from({ length: 20 }, (_, index) => ({ id: `urgent-room-${index}`, event_id: null, kind: 'room',
    title: `ECE ${150 + index}: Room changed`, body: 'Room changed', course: `ECE ${150 + index}`, starts_at: at(DATE, '10:00'),
    ends_at: at(DATE, '11:00'), observed_at: at(DATE, '08:00'), location: `RCH ${index}`, previous_location: `E7 ${index}`,
    previous_at: null, current_at: null, all_day: false, url: null, confidence: 'confirmed', evidence: 'Synthetic change.', source_label: 'Schedule', state: 'live' }));
  const feed = recommendationsFromData({ ...crowded, now: at(DATE, '08:00') });
  assert.equal(feed.items.length, 16);
  const belowLimit = feed.diagnostics.candidates.find(candidate => candidate.kind === 'change' && candidate.position > 16);
  assert.equal(belowLimit.status, 'deferred');
  assert.match(belowLimit.reason, /daily guidance limit/);
  assert.equal(feed.diagnostics.summary.shown, 16);
  assert.ok(feed.diagnostics.summary.deferred >= 4);
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
  // The Google schedule now refreshes every six hours. Preview beyond that
  // window to prove the decision clock does not age the real source state.
  const actualNow = at(DATE, '05:00');
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
  assert.match(morning.items.find(item => item.kind === 'class' && item.course === 'ECE 150').body, /This period: /);
  const reading = morning.items.find(item => item.kind === 'learning');
  assert.match(reading.reason, /exact lecture topic is not confirmed/);
  const tomorrow = recommendationsFromData({ ...data, now: at('2026-09-24', '08:00'), actions: { [reading.id]: { action: 'done' } } });
  assert.ok(!tomorrow.items.some(item => item.kind === 'learning'), 'completed weekly reading stays complete on the next day');
});

test('rain and cold produce separate weather advisories with honest timing and evidence', () => {
  const data = syntheticDay();
  const when = at(DATE, '09:00');
  data.weather.forecast = [{ at: when, temp_c: 1, feels_c: -2, precip_prob: 80, precip_mm: 2.5, wind_kmh: 15 }];
  const feed = recommendationsFromData({ ...data, now: at(DATE, '08:00') });
  const weather = feed.items.filter(item => item.kind === 'weather');
  assert.equal(weather.length, 2, 'rain and cold coexist instead of one replacing the other');
  const rain = weather.find(item => /rain/i.test(item.title));
  const cold = weather.find(item => /cold/i.test(item.title));
  assert.ok(rain && cold);
  assert.match(rain.title, /Heavy rain/);
  assert.match(rain.body, /umbrella/);
  assert.match(cold.body, /Feels like -2°C/);
  assert.ok(weather.every(item => item.starts_at === when), 'a future forecast hour is the advisory start');
  assert.ok(weather.every(item => item.source_label === 'Cached weather forecast'));
  assert.ok(weather.every(item => /Forecast cached .*old/.test(item.evidence)), 'evidence states the forecast age');
  assert.ok(weather.every(item => item.state === 'live' && item.reason));

  const current = recommendationsFromData({ ...data, now: at(DATE, '08:30'), weather: {
    observed_at: at(DATE, '08:00'), state: 'live',
    forecast: [{ at: at(DATE, '08:00'), temp_c: -18, feels_c: -20, precip_prob: null, precip_mm: null, wind_kmh: null }],
  } });
  const severeCold = current.items.find(item => item.kind === 'weather');
  assert.match(severeCold.title, /Severe cold/);
  assert.equal(severeCold.priority, 860);
  assert.equal(severeCold.starts_at, null, 'current conditions do not claim a past start');
});

test('snow and ice advisories use snowfall and weather code', () => {
  const data = syntheticDay();
  data.weather.forecast = [{ at: at(DATE, '10:00'), temp_c: -3, feels_c: -5, precip_prob: 90, precip_mm: 3, snow_cm: 3, weather_code: 75 }];
  const snowFeed = recommendationsFromData({ ...data, now: at(DATE, '08:00') });
  const snow = snowFeed.items.find(item => item.kind === 'weather' && /snow/i.test(item.title));
  assert.ok(snow, 'snowfall and a snow weather code produce an advisory');
  assert.match(snow.title, /Heavy snow/);
  assert.match(snow.body, /Snowfall about 3.0 cm/);
  assert.match(snow.body, /slippery/);
  assert.equal(snow.priority, 860);
  assert.ok(!snowFeed.items.some(item => item.kind === 'weather' && /rain/i.test(item.title)), 'frozen precipitation is not also called rain');

  data.weather.forecast = [{ at: at(DATE, '10:00'), temp_c: -1, feels_c: -1, precip_prob: 70, precip_mm: 1, weather_code: 66 }];
  const ice = recommendationsFromData({ ...data, now: at(DATE, '08:00') }).items.find(item => item.kind === 'weather' && /freezing rain/i.test(item.title));
  assert.ok(ice, 'a freezing-rain weather code produces an ice advisory');
  assert.match(ice.body, /Freezing precipitation/);
  assert.equal(ice.priority, 860);
});

test('wind escalates from notable to severe with actionable advice', () => {
  const data = syntheticDay();
  data.weather.forecast = [{ at: at(DATE, '09:00'), temp_c: 15, feels_c: 15, wind_kmh: 40 }];
  const windy = recommendationsFromData({ ...data, now: at(DATE, '08:00') }).items.find(item => item.kind === 'weather');
  assert.match(windy.title, /Windy/);
  assert.equal(windy.priority, 770);
  assert.match(windy.body, /secure/i);

  data.weather.forecast = [{ at: at(DATE, '09:00'), temp_c: 15, feels_c: 15, wind_kmh: 65 }];
  const severe = recommendationsFromData({ ...data, now: at(DATE, '08:00') }).items.find(item => item.kind === 'weather');
  assert.match(severe.title, /Severe wind/);
  assert.equal(severe.priority, 860);
});

test('malformed and old forecasts never become current hazards', () => {
  const data = syntheticDay();
  data.weather.forecast = [null, {}, { at: 'not-a-time', feels_c: -30 }, { at: NaN, precip_prob: 100 }, { at: at(DATE, '09:00') + 1.5, feels_c: -30 }, { at: at(DATE, '03:00'), feels_c: -30, precip_prob: 100 }];
  let feed;
  assert.doesNotThrow(() => { feed = recommendationsFromData({ ...data, now: at(DATE, '11:45') }); });
  assert.ok(!feed.items.some(item => item.kind === 'weather'), 'malformed and long-past rows are ignored without a false hazard');

  const absurd = syntheticDay();
  absurd.weather = { observed_at: 1e300, state: 'live', forecast: [{ at: at(DATE, '09:00'), feels_c: -20 }] };
  let absurdFeed;
  assert.doesNotThrow(() => { absurdFeed = recommendationsFromData({ ...absurd, now: at(DATE, '08:00') }); });
  assert.match(absurdFeed.items.find(item => item.kind === 'weather').evidence, /cached at an unknown time/);

  const negative = syntheticDay();
  negative.weather.forecast = [{ at: at(DATE, '09:00'), visibility_m: -100, weather_code: null }];
  assert.ok(!recommendationsFromData({ ...negative, now: at(DATE, '08:00') }).items.some(item => item.kind === 'weather' && /fog/i.test(item.title)), 'a negative visibility is bad data, not dense fog');

  const zeroSnow = syntheticDay();
  zeroSnow.weather.forecast = [{ at: at(DATE, '09:00'), weather_code: 75, snow_cm: 0 }];
  const snow = recommendationsFromData({ ...zeroSnow, now: at(DATE, '08:00') }).items.find(item => item.kind === 'weather');
  assert.match(snow.body, /Snow is forecast/);
  assert.doesNotMatch(snow.body, /0\.0 cm/);

  data.weather.state = 'stale';
  data.weather.forecast = [{ at: at(DATE, '14:00'), temp_c: 1, feels_c: -30, precip_prob: 100, precip_mm: 5, wind_kmh: 70 }];
  const stale = recommendationsFromData({ ...data, now: at(DATE, '11:45') });
  const old = stale.items.filter(item => item.kind === 'weather');
  assert.equal(old.length, 1, 'a stale forecast emits at most one quiet item');
  assert.equal(old[0].title, 'Old weather forecast');
  assert.equal(old[0].priority, 250);
  assert.equal(old[0].state, 'stale');
  assert.equal(old[0].starts_at, null);
  assert.match(old[0].body, /old forecast/);
  assert.match(old[0].evidence, /not treated as current/);
  assert.ok(stale.warnings.some(warning => /Weather forecast is old/.test(warning)));
  assert.ok(!stale.items.some(item => item.kind === 'weather' && /cold|rain|wind/i.test(item.title)));
});

test('weather advisories are capped at three and severe hazards lead', () => {
  const data = syntheticDay();
  data.weather.forecast = [
    { at: at(DATE, '10:00'), precip_prob: 60 },
    { at: at(DATE, '11:00'), weather_code: 45 },
    { at: at(DATE, '13:00'), feels_c: -20 },
  ];
  const ordered = recommendationsFromData({ ...data, now: at(DATE, '08:00') }).items.filter(item => item.kind === 'weather');
  assert.equal(ordered.length, 3);
  assert.match(ordered[0].title, /Severe cold/);
  assert.equal(ordered[0].priority, 860);
  assert.ok(ordered.slice(1).every(item => item.priority === 770), 'notable hazards follow severe ones');

  data.weather.forecast = [
    { at: at(DATE, '09:00'), precip_prob: 60 },
    { at: at(DATE, '10:00'), feels_c: 32 },
    { at: at(DATE, '11:00'), wind_kmh: 40 },
    { at: at(DATE, '12:00'), weather_code: 45 },
    { at: at(DATE, '13:00'), feels_c: -20 },
  ];
  const capped = recommendationsFromData({ ...data, now: at(DATE, '08:00') }).items.filter(item => item.kind === 'weather');
  assert.equal(capped.length, 3, 'weather cannot flood the feed');
  assert.equal(new Set(capped.map(item => item.id)).size, 3);
  assert.match(capped[0].title, /Severe cold/);
  assert.deepEqual(capped.map(item => item.priority), [860, 770, 770]);
});

test('usable mild weather keeps the generic fallback', () => {
  const data = syntheticDay();
  data.weather.forecast = [{ at: at(DATE, '14:00'), temp_c: 18, feels_c: 17, precip_prob: 10, precip_mm: 0, wind_kmh: 10, weather_code: 1 }];
  const weather = recommendationsFromData({ ...data, now: at(DATE, '11:45') }).items.find(item => item.kind === 'weather');
  assert.equal(weather.title, 'Weather for your next break');
  assert.equal(weather.priority, 330);
  assert.match(weather.body, /no notable weather expected/);
  assert.equal(weather.starts_at, at(DATE, '14:00'));
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
  assert.deepEqual(allDay.warnings, ['time_unknown', 'coverage_unknown']);
  assert.equal(allDay.body, `Listed for ${DATE}.`);
  assert.ok(!allDay.title.includes('Confirm'));
  const exam = data.calendar.days[0].events.find(event => event.id === 'exam');
  exam.all_day = true; exam.starts_at = at(DATE, '00:00'); exam.ends_at = at('2026-09-24', '00:00');
  const dateOnlyExam = recommendationsFromData({ ...data, now: at(DATE, '11:45') }).tasks.large.find(task => task.title.includes('midterm'));
  assert.ok(!dateOnlyExam.title.startsWith('Now:'), 'date-only assessments cannot be declared in progress');
  assert.equal(dateOnlyExam.starts_at, null);
  assert.deepEqual(dateOnlyExam.warnings, ['time_unknown', 'coverage_unknown']);
});

test('recommendation engine creates active task for description-derived due date and resolves conflicts', () => {
  const data = syntheticDay();
  const opensAt = at(DATE, '08:30');
  const dueAt = at(DATE, '18:00'); // Due today at 6pm

  data.calendar.days[0].events.push({
    id: 'tut3-open',
    category: 'deadline',
    title: 'TUTORIAL ASSIGNMENT 3 - Available',
    course: 'MATH 117',
    starts_at: opensAt,
    ends_at: opensAt,
    due_at: dueAt,
    all_day: false,
    source_label: 'Waterloo LEARN',
    source_id: 'uw-learn-ics',
    links: [{ label: 'Open in Crowdmark', url: 'https://crowdmark.com/submit', kind: 'submit' }],
  });

  data.calendar.days[0].events.push({
    id: 'tut3-due',
    category: 'deadline',
    title: 'MATH 117 - TUTORIAL ASSIGNMENT 3 - Due',
    course: 'MATH 117',
    starts_at: dueAt,
    ends_at: dueAt,
    all_day: false,
    source_label: 'Waterloo LEARN',
    source_id: 'uw-learn-ics',
    links: [{ label: 'Open in Crowdmark', url: 'https://crowdmark.com/submit', kind: 'submit' }],
  });

  const feed = recommendationsFromData({ ...data, now: at(DATE, '10:00') });
  const tutTasks = feed.tasks.large.filter(task => task.title.includes('TUTORIAL ASSIGNMENT 3'));

  assert.equal(tutTasks.length, 1);
  const task = tutTasks[0];
  assert.equal(task.title, 'TUTORIAL ASSIGNMENT 3');
  assert.equal(task.due_at, dueAt);
  assert.equal(task.can_complete, true);
  assert.equal(task.action.label, 'Open submission');

  const completedFeed = recommendationsFromData({
    ...data,
    actions: { [task.id]: { action: 'done' } },
    now: at(DATE, '10:00'),
  });
  assert.ok(!completedFeed.tasks.large.some(t => t.id === task.id));
});

test('unconfigured optional Google Calendar does not generate warning when schedule is configured', () => {
  const data = syntheticDay();
  data.calendar.sources.push({ id: 'google-calendar-ics', status: 'unconfigured', optional: true });
  const feed = recommendationsFromData({ ...data, now: at(DATE, '10:00') });
  assert.ok(!feed.warnings.some(w => w.includes('Google Calendar') || w.includes('google-calendar-ics')));

  // When neither is configured, only one Class schedule warning is surfaced
  data.calendar.sources = [
    { id: 'uw-portal-ics', status: 'unconfigured' },
    { id: 'google-calendar-ics', status: 'unconfigured', optional: true },
    { id: 'uw-learn-ics', status: 'ok' }
  ];
  const unconfiguredFeed = recommendationsFromData({ ...data, now: at(DATE, '10:00') });
  assert.ok(unconfiguredFeed.warnings.some(w => w.includes('Class schedule: not configured.')));
  assert.ok(!unconfiguredFeed.warnings.some(w => w.includes('Google Calendar')));

  // When Google Calendar is configured and Portal is not, Class schedule unconfigured warning is suppressed
  data.calendar.sources = [
    { id: 'uw-portal-ics', status: 'unconfigured' },
    { id: 'google-calendar-ics', status: 'ok', optional: true },
    { id: 'uw-learn-ics', status: 'ok' }
  ];
  const gcalFeed = recommendationsFromData({ ...data, now: at(DATE, '10:00') });
  assert.ok(!gcalFeed.warnings.some(w => w.includes('Class schedule: not configured.')));
  assert.ok(!gcalFeed.warnings.some(w => w.includes('Google Calendar: not configured.')));
});

