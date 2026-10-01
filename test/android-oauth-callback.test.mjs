import { test } from 'node:test';
import assert from 'node:assert/strict';
import { androidOAuthCallback } from '../apps/relay/src/android-oauth-callback.mjs';
import worker from '../apps/relay/src/worker.mjs';

test('Android OAuth return hands only code, state and issuer to a fixed app scheme', async () => {
  const res = androidOAuthCallback(new Request('https://dash.test/oauth/android/callback?code=one-use-code&state=pkce-state&iss=https%3A%2F%2Fdash.test&redirect=https%3A%2F%2Fevil.test&access_token=must-not-forward'));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /dev\.peteryhs\.unidash:\/oauth\/callback\?code=one-use-code/);
  assert.match(html, /state=pkce-state/);
  assert.doesNotMatch(html, /evil\.test|must-not-forward/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('incomplete, duplicate and ambiguous callbacks do not launch the app', async () => {
  for (const params of ['', 'code=x', 'state=x', 'state=x&code=y&error=denied', 'state=x&state=y&code=z', 'state=x&code=y&code=z', 'state=x&code=', 'state=x&error=', 'state=%00&code=z']) {
    const res = androidOAuthCallback(new Request(`https://dash.test/oauth/android/callback?${params}`));
    assert.equal(res.status, 400, params);
    assert.match(await res.text(), /const target=null/);
  }
});

test('OAuth errors return to the app without reflecting provider error descriptions', async () => {
  const res = androidOAuthCallback(new Request('https://dash.test/oauth/android/callback?state=s&error=access_denied&error_description=private-user-information'));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /error=access_denied/);
  assert.doesNotMatch(html, /private-user-information/);
});

test('callback parameters cannot inject markup or scripts', async () => {
  const res = androidOAuthCallback(new Request(`https://dash.test/oauth/android/callback?state=s&code=${encodeURIComponent('</script><script>alert(1)</script>')}`));
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), /<script>alert\(1\)<\/script>/);
});

test('Worker callback reaches the handoff before assets without opening authenticated data', async () => {
  const res = await worker.fetch(new Request('https://dash.test/oauth/android/callback?state=s&code=c'), { ASSETS: { fetch: () => { throw new Error('must not serve SPA'); } } }, {});
  assert.equal(res.status, 200);
  const protectedResponse = await worker.fetch(new Request('https://dash.test/v1/dashboard'), { ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud' }, {});
  assert.equal(protectedResponse.status, 401);
  assert.equal(androidOAuthCallback(new Request('https://dash.test/oauth/android/callback', { method: 'POST' })).status, 405);
});
