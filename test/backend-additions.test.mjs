import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { parse as parseStatus } from '../sources/status/source.mjs';
import { alertCard } from '../apps/relay/src/cards.mjs';
import { claimFoodAiRun, getFoodRecommendation, saveFoodProfile, syncFoodRecommendation } from '../apps/relay/src/food-recommendation.mjs';
import { previewCourseImport, saveCourseResources } from '../apps/relay/src/course-library.mjs';
import { buildCalendar } from '../apps/relay/src/calendar.mjs';
import { dismissAlert, syncAlertSummary } from '../apps/relay/src/alert-summary.mjs';

test('pasted LEARN course home keeps useful shortcuts and drops site chrome', () => {
  const paste = readFileSync(new URL('./learn-home-paste.txt', import.meta.url), 'utf8');
  const resources = previewCourseImport(paste);
  assert.deepEqual(resources.map((item) => item.title), [
    'ECE 198 - Fall 2026', 'Content', 'Grades', 'Announcements', 'WHMIS Completion Dropbox',
  ]);
  assert.equal(resources[4].url.includes('\\&'), false, 'copied Markdown escapes are removed from links');
  assert.equal(resources.some((item) => /calendar|mental health|library|course admin|makeup session/i.test(item.title)), false);
});

test('status summary carries the incident, affected service and latest update through to the card', async () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const body = JSON.stringify({
    status: { indicator: 'major', description: 'Partial System Outage' },
    incidents: [{ id: 'incident-1', name: 'Network interruption in V1', status: 'investigating', impact: 'critical', shortlink: 'https://stspg.io/incident-1', components: [{ id: 'wired', name: 'Wired Network' }], incident_updates: [{ body: 'V1E4 is affected.' }] }],
    components: [{ id: 'wired', name: 'Wired Network', status: 'major_outage' }],
  });
  const rows = parseStatus({ status: 200, body }, { now }).rows;
  assert.equal(rows.length, 1);
  const store = new SqliteStore(':memory:');
  store.upsertRows('notice', rows);
  const card = await alertCard(store, { now });
  assert.equal(card.data.notices[0].title, 'Network interruption in V1');
  assert.deepEqual(card.data.notices[0].components, ['Wired Network']);
  assert.equal(card.data.notices[0].body, 'V1E4 is affected.');
  store.close();
});

test('alert summary is generated once, cached, and dismisses until the incident changes', async () => {
  const store = new SqliteStore(':memory:');
  const now = Date.parse('2026-09-23T12:00:00Z');
  const base = { source_id: 'uw-status', observed_at: now, valid_until: now + 60_000, severity: 'major', scope: 'campus', body: 'V1E4 and V1N1 are affected.', components: ['Wired Network'], url: 'https://status.uwaterloo.ca' };
  store.upsertRows('notice', [{ ...base, external_id: 'incident:one', title: 'V1 network interruption' }]);
  let calls = 0;
  const cfEnv = { AI: { run: async () => { calls++; return { response: JSON.stringify({ summary: 'Wired Network is interrupted in V1E4 and V1N1.' }) }; } } };
  assert.equal((await syncAlertSummary(store, { cfEnv, now })).status, 'ready');
  await syncAlertSummary(store, { cfEnv, now: now + 60_000 });
  assert.equal(calls, 1);
  const card = alertCard(store, { now });
  assert.equal(card.data.summary, 'Wired Network is interrupted in V1E4 and V1N1.');
  assert.equal(await dismissAlert(store, card.data.key), true);
  assert.equal(alertCard(store, { now }).data.dismissed, true);
  store.upsertRows('notice', [{ ...base, external_id: 'incident:two', title: 'Another outage' }]);
  assert.equal(alertCard(store, { now }).data.dismissed, false);
  store.close();
});

test('menu ranking is persisted by the backend and reruns only when menu or profile changes', async () => {
  const store = new SqliteStore(':memory:');
  const date = '2026-09-23';
  const row = { source_id: 'uw-food-daily-menu', external_id: 'dish-1', observed_at: Date.now(), valid_until: Date.now() + 60_000, outlet: 'Campus Cafe', station: '', dish: 'Noodles', service_date: date, diet: [], allergens: [], url: '' };
  store.upsertRows('menu_item', [row]);
  let calls = 0;
  const cfEnv = { AI: { run: async () => { calls++; return { response: JSON.stringify({ headline: 'Try the noodles.', top_outlet: 'Campus Cafe', ranked_outlets: [{ outlet: 'Campus Cafe', rank: 1, match_score: 80, verdict: 'Good choice.', highlights: [] }], tip: '' }) }; } } };
  assert.equal((await syncFoodRecommendation(store, { cfEnv })).status, 'ready');
  assert.equal((await getFoodRecommendation(store, date)).recommendation.top_outlet, 'Campus Cafe');
  await syncFoodRecommendation(store, { cfEnv });
  assert.equal(calls, 1);
  store.upsertRows('menu_item', [{ ...row, dish: 'Rice' }]);
  await syncFoodRecommendation(store, { cfEnv });
  assert.equal(calls, 2);
  await saveFoodProfile(store, { bio: 'Love rice', selectedAiModel: '@cf/google/gemma-4-26b-a4b-it' });
  assert.equal((await getFoodRecommendation(store, date)).status, 'pending');
  await syncFoodRecommendation(store, { cfEnv });
  assert.equal(calls, 3);
  store.close();
});

test('daily dining AI budget stops repeated model calls and resets the next UTC day', async () => {
  const store = new SqliteStore(':memory:');
  const now = Date.parse('2026-09-23T12:00:00Z');
  for (let i = 0; i < 12; i++) assert.equal(await claimFoodAiRun(store, now), true);
  assert.equal(await claimFoodAiRun(store, now), false);
  assert.equal(await claimFoodAiRun(store, now + 86_400_000), true);
  store.close();
});

test('course import previews real links and a course group includes saved materials and LEARN shortcut', async () => {
  const imported = previewCourseImport('<a href="/d2l/le/content/123/Home?ou=456">Lecture notes</a>\nTextbook: https://publisher.example/book');
  assert.equal(imported.length, 2);
  assert.equal(imported[0].url, 'https://learn.uwaterloo.ca/d2l/le/content/123/Home?ou=456');
  assert.equal(imported[1].kind, 'textbook');
  const store = new SqliteStore(':memory:');
  await saveCourseResources(store, 'ECE 150', imported);
  const starts = Date.parse('2026-09-23T14:00:00Z');
  store.upsertRows('timeline_event', [{ source_id: 'uw-learn-ics', external_id: 'task', observed_at: starts, valid_until: starts + 900_000, kind: 'deadline', title: 'ECE 150 - Quiz due', location: 'ECE 150 - Fall 2026', description: 'Quiz: https://learn.uwaterloo.ca/d2l/lms/quizzing/user/quiz_summary.d2l?ou=456', starts_at: starts, ends_at: starts }]);
  const calendar = await buildCalendar(store, { start: '2026-09-23', days: 1, now: starts });
  assert.equal(calendar.courses[0].course, 'ECE 150');
  assert.equal(calendar.courses[0].learn_url, 'https://learn.uwaterloo.ca/d2l/home/456');
  assert.equal(calendar.courses[0].resources.length, 2);
  store.close();
});

test('course shortcut stays available during a week with classes but no LEARN deadline', async () => {
  const store = new SqliteStore(':memory:');
  const starts = Date.parse('2026-09-23T14:00:00Z');
  const base = { observed_at: starts, valid_until: starts + 900_000 };
  store.upsertRows('timeline_event', [
    { ...base, source_id: 'uw-portal-ics', external_id: 'class', kind: 'class', title: 'ECE 150 LEC 001', starts_at: starts, ends_at: starts + 300_000 },
    { ...base, source_id: 'uw-learn-ics', external_id: 'later', kind: 'deadline', title: 'ECE 150 - Assignment due', location: 'ECE 150 - Fall 2026', description: 'Dropbox: https://learn.uwaterloo.ca/d2l/lms/dropbox/submit?ou=456', starts_at: starts + 14 * 86_400_000, ends_at: starts + 14 * 86_400_000 },
  ]);
  const calendar = await buildCalendar(store, { start: '2026-09-23', days: 7, now: starts });
  assert.equal(calendar.courses[0].learn_url, 'https://learn.uwaterloo.ca/d2l/home/456');
  store.close();
});
