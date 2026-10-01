import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGuideProgress, normalizeFeedAddress, dashboardOrigin, oauthSetupCommand } from '../apps/web/src/lib/setup-guide.ts';

test('guide progress drops secret and unknown fields and rejects corrupt navigation state', () => {
  assert.deepEqual(parseGuideProgress('{"seen":true,"step":3,"finished":false,"feed":"private-token"}'), { seen: true, step: 3, finished: false });
  for (const raw of [null, 'broken', '{"seen":true,"step":99}', '{"seen":true,"step":-1}', '{"seen":true,"step":1.5}']) {
    assert.deepEqual(parseGuideProgress(raw), { seen: false, step: 0, finished: false });
  }
});

test('feed addresses preserve private query tokens while converting webcal and rejecting unsafe input', () => {
  assert.equal(normalizeFeedAddress(' webcal://learn.uwaterloo.ca/feed.ics?token=a%2Fb '), 'https://learn.uwaterloo.ca/feed.ics?token=a%2Fb');
  for (const value of ['https://example.com/a\nb', 'http://example.com/feed.ics', 'https://user:password@example.com/feed.ics', '/feed.ics', 'https://example.com/feed.ics#token']) assert.throws(() => normalizeFeedAddress(value));
});

test('dashboard parsing reduces a pasted page to a safe origin and commands request exactly three weeks', () => {
  assert.equal(dashboardOrigin(' DASH.Example.com/settings?foo=bar#fragment '), 'https://dash.example.com');
  assert.equal(oauthSetupCommand('https://dash.example.com:8443', 3), 'npm run access:oauth -- --dashboard https://dash.example.com:8443 --grant-weeks 3');
  for (const input of ['http://dash.example.com', 'https://user:pass@dash.example.com', 'https://foo;echo.example.com', 'https://foo`evil.example.com', 'https://foo&evil.example.com']) assert.equal(dashboardOrigin(input), null);
  assert.throws(() => oauthSetupCommand('https://dash.example.com/path', 3));
  assert.throws(() => oauthSetupCommand('https://dash.example.com', 4));
});
