import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendationPresentation } from '#contract/recommendation-presentation.mjs';
import { validateRecommendations } from '#contract/recommendations.mjs';
import { recommendationsFromData } from '../apps/relay/src/recommendations.mjs';
import { at, DATE, syntheticDay } from './helpers/recommendation-day.mjs';

test('older cached task caveats become concise warning signals without losing the listed date', () => {
  const item = { kind: 'task', body: 'Listed for 2026-10-16; no exact time was supplied. Check the course instructions. Coverage has not been provided; check the course instructions.' };
  assert.deepEqual(recommendationPresentation(item), {
    body: 'Listed for 2026-10-16.', warnings: ['time_unknown', 'coverage_unknown'],
  });
  assert.deepEqual(recommendationPresentation({ ...item, warnings: ['time_unknown', 'future_warning'] }), {
    body: 'Listed for 2026-10-16.', warnings: ['time_unknown', 'coverage_unknown'],
  });
});

test('overdue warnings preserve known coverage and distinguish submission from completion', () => {
  for (const status of ['submission', 'completion']) {
    const body = `The listed due time has passed; ${status} status is unknown. Coverage: Loops.`;
    assert.deepEqual(recommendationPresentation({ kind: 'task', body }), {
      body: 'The listed due time has passed. Coverage: Loops.', warnings: [`${status}_unknown`],
    });
  }
});

test('presentation leaves non-task content intact and fully specified tasks have no warnings', () => {
  const body = 'Coverage has not been provided; check the course instructions.';
  assert.deepEqual(recommendationPresentation({ kind: 'learning', body }), { body, warnings: [] });
  const feed = recommendationsFromData({ ...syntheticDay(), now: at(DATE, '08:00') });
  const quiz = feed.tasks.small.find(task => task.title.includes('Quiz 2'));
  assert.deepEqual(quiz.warnings, []);
  assert.deepEqual(quiz.topics, ['Loops and functions']);
  const oldFeed = structuredClone(feed);
  for (const item of [...oldFeed.items, ...oldFeed.tasks.small, ...oldFeed.tasks.large]) delete item.warnings;
  assert.ok(validateRecommendations(oldFeed).items.every(item => item.warnings.length === 0));
});
