import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portalIcs } from '../sources/ics/source.mjs';
import { dedupeGoogleSources } from '../sources/registry.mjs';
import { parseRetryAfter } from '../apps/relay/src/retry.mjs';
import { SqliteStore } from '../apps/relay/src/store.mjs';

const now = Date.UTC(2026, 8, 25, 12);

test('Google schedule source uses a slow cadence and a long rate-limit policy', () => {
  assert.equal(portalIcs.cadenceMs, 6 * 60 * 60 * 1000);
  assert.equal(portalIcs.rateLimitMinMs, 12 * 60 * 60 * 1000);
  assert.equal(portalIcs.rateLimitMaxMs, 7 * 24 * 60 * 60 * 1000);
});

test('Retry-After accepts seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('90', now), 90 * 1000);
  assert.equal(parseRetryAfter(new Date(now + 3 * 60 * 1000).toUTCString(), now), 180 * 1000);
  assert.equal(parseRetryAfter('garbage', now), 0);
  assert.equal(parseRetryAfter(new Date(now - 3 * 60 * 1000).toUTCString(), now), 0);
});

test('repeated Google 429s back off exponentially and never ignore Retry-After', () => {
  const store = new SqliteStore(':memory:');
  store.scheduleJob('uw-portal-ics', now);
  const policy = {
    startedAt: now,
    finishedAt: now,
    outcome: 'failed',
    httpStatus: 429,
    cadenceMs: portalIcs.cadenceMs,
    rateLimitMinMs: portalIcs.rateLimitMinMs,
    rateLimitMaxMs: portalIcs.rateLimitMaxMs,
    now,
  };
  store.recordJobResult('uw-portal-ics', policy);
  assert.ok(store.jobs()[0].next_due_at >= now + 12 * 60 * 60 * 1000);
  store.recordJobResult('uw-portal-ics', policy);
  assert.ok(store.jobs()[0].next_due_at >= now + 24 * 60 * 60 * 1000);
  store.recordJobResult('uw-portal-ics', { ...policy, retryAfterMs: 10 * 24 * 60 * 60 * 1000 });
  assert.ok(store.jobs()[0].next_due_at >= now + 10 * 24 * 60 * 60 * 1000);
  store.close();
});

test('duplicate Google Calendar URLs are fetched once per scheduler', () => {
  const url = 'https://calendar.google.com/calendar/ical/private/basic.ics?token=abc&foo=bar';
  const sameUrlDifferentQueryOrder = 'https://calendar.google.com/calendar/ical/private/basic.ics?foo=bar&token=abc';
  const sources = [
    { id: 'first', url: () => url },
    { id: 'second', url: () => sameUrlDifferentQueryOrder },
    { id: 'learn', url: () => 'https://learn.uwaterloo.ca/feed.ics' },
  ];
  assert.deepEqual(dedupeGoogleSources(sources).map((source) => source.id), ['first', 'learn']);
});
