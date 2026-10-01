import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_TOKEN_LIFETIME,
  GRANT_SESSION_DURATION,
  applicationCoversDashboard,
  buildUpdatedApplication,
  configureManagedOAuth,
  normalizeDashboardOrigin,
  grantDurationForWeeks,
  parseArgs,
} from '../tools/configure-access-oauth.mjs';

test('grant weeks supports a three-week session without extending access tokens', () => {
  assert.equal(grantDurationForWeeks(1), '168h');
  assert.equal(grantDurationForWeeks(2), '336h');
  assert.equal(grantDurationForWeeks(3), '504h');
  const updated = buildUpdatedApplication({ domain: 'dash.example.com' }, 'https://dash.example.com/oauth/android/callback', 3);
  assert.equal(updated.oauth_configuration.grant.session_duration, '504h');
  assert.equal(updated.oauth_configuration.grant.access_token_lifetime, '15m');
  assert.equal(parseArgs(['--dashboard', 'https://dash.example.com', '--grant-weeks', '3']).grantWeeks, 3);
  for (const value of ['4', '0', '1.5', 'NaN', '-1']) assert.throws(() => parseArgs(['--dashboard', 'https://dash.example.com', '--grant-weeks', value]), /grant-weeks/);
  assert.throws(() => parseArgs(['--dashboard', 'https://dash.example.com', '--grant-weeks']), /grant-weeks/);
});

test('three-week grant selection is carried into the actual Cloudflare PUT', async () => {
  const calls = [];
  await configureManagedOAuth({ dashboard: 'https://dashboard.example.com', accountId: 'account-1', token: 'secret', appId: 'app-1', grantWeeks: 3, apply: true,
    fetchImpl: mockAccessFetch({ id: 'app-1', domain: 'dashboard.example.com' }, calls) });
  assert.equal(JSON.parse(calls.find(call => call.init.method === 'PUT').init.body).oauth_configuration.grant.session_duration, '504h');
});

test('invalid grant duration never reads or mutates the Cloudflare application', async () => {
  let calls = 0;
  await assert.rejects(configureManagedOAuth({ dashboard: 'https://dashboard.example.com', accountId: 'account-1', token: 'secret', appId: 'app-1', grantWeeks: 4, apply: true, fetchImpl: async () => { calls++; } }), /grant-weeks/);
  assert.equal(calls, 0);
});

test('dashboard input is a strict HTTPS origin and callback is derived from it', () => {
  assert.equal(normalizeDashboardOrigin('https://Dashboard.Example.com/'), 'https://dashboard.example.com');
  assert.throws(() => normalizeDashboardOrigin('http://dashboard.example.com'), /use https/);
  assert.throws(() => normalizeDashboardOrigin('https://user:pass@dashboard.example.com'), /userinfo/);
  assert.throws(() => normalizeDashboardOrigin('https://dashboard.example.com/path'), /origin/);
  assert.throws(() => normalizeDashboardOrigin('https://dashboard.example.com?x=1'), /origin/);
  assert.throws(() => normalizeDashboardOrigin('https://dashboard.example.com/#fragment'), /origin/);
});

test('application hostname validation understands domain and public destination forms', () => {
  assert.equal(applicationCoversDashboard({ domain: 'dashboard.example.com/admin' }, 'https://dashboard.example.com'), false);
  assert.equal(applicationCoversDashboard({ domain: 'dashboard.example.com' }, 'https://dashboard.example.com'), true);
  assert.equal(applicationCoversDashboard({ destinations: [{ type: 'public', uri: 'https://dashboard.example.com/*' }] }, 'https://dashboard.example.com'), true);
  assert.equal(applicationCoversDashboard({ destinations: [{ type: 'public', uri: 'https://*.example.com/*' }] }, 'https://dashboard.example.com'), true);
  assert.equal(applicationCoversDashboard({ destinations: [{ type: 'public', uri: 'https://dashboard.example.com:8443/*' }] }, 'https://dashboard.example.com:8443'), true);
  assert.equal(applicationCoversDashboard({ destinations: [{ type: 'public', uri: 'https://dashboard.example.com/*' }] }, 'https://dashboard.example.com:8443'), false);
  assert.equal(applicationCoversDashboard({ domain: 'other.example.com' }, 'https://dashboard.example.com'), false);
});

test('updated body preserves Access application fields and existing redirect settings', () => {
  const current = {
    id: 'app-1',
    type: 'self_hosted',
    domain: 'dashboard.example.com',
    policies: [{ id: 'policy-1', decision: 'allow' }],
    destinations: [{ type: 'public', uri: 'https://dashboard.example.com/*' }],
    oauth_configuration: {
      enabled: false,
      provider_specific: 'keep',
      dynamic_client_registration: {
        enabled: false,
        allow_any_on_localhost: false,
        allow_any_on_loopback: false,
        allowed_uris: ['https://existing.example/callback'],
      },
      grant: { access_token_lifetime: '5m', session_duration: '24h', unknown: 'keep' },
    },
  };
  const callback = 'https://dashboard.example.com/oauth/android/callback';
  const updated = buildUpdatedApplication(current, callback);

  assert.deepEqual(updated.policies, current.policies);
  assert.deepEqual(updated.destinations, current.destinations);
  assert.equal(updated.oauth_configuration.provider_specific, 'keep');
  assert.deepEqual(updated.oauth_configuration.dynamic_client_registration.allowed_uris, [
    'https://existing.example/callback',
    callback,
  ]);
  assert.equal(updated.oauth_configuration.dynamic_client_registration.allow_any_on_localhost, false);
  assert.equal(updated.oauth_configuration.dynamic_client_registration.allow_any_on_loopback, false);
  assert.equal(updated.oauth_configuration.enabled, true);
  assert.equal(updated.oauth_configuration.dynamic_client_registration.enabled, true);
  assert.equal(updated.oauth_configuration.grant.access_token_lifetime, ACCESS_TOKEN_LIFETIME);
  assert.equal(updated.oauth_configuration.grant.session_duration, GRANT_SESSION_DURATION);
  assert.equal(updated.oauth_configuration.grant.unknown, 'keep');
});

function mockAccessFetch(application, calls) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === 'PUT') return new Response(JSON.stringify({ success: true, result: init.body && JSON.parse(init.body) }), { status: 200 });
    return new Response(JSON.stringify({ success: true, result: application }), { status: 200 });
  };
}

test('preview performs GET only and returns a reviewable change without leaking credentials', async () => {
  const calls = [];
  const token = 'secret-token-that-must-not-be-printed';
  const result = await configureManagedOAuth({
    dashboard: 'https://dashboard.example.com',
    accountId: 'account-1',
    token,
    appId: 'app-1',
    fetchImpl: mockAccessFetch({ id: 'app-1', domain: 'dashboard.example.com' }, calls),
  });

  assert.equal(result.changed, true);
  assert.equal(result.applied, false);
  assert.deepEqual(calls.map((call) => call.init.method), ['GET']);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(result.callbackUri, 'https://dashboard.example.com/oauth/android/callback');
});

test('apply sends the full current application with only requested OAuth changes', async () => {
  const calls = [];
  const current = {
    id: 'app-1',
    domain: 'dashboard.example.com',
    policies: [{ id: 'policy-1' }],
    oauth_configuration: { dynamic_client_registration: { allowed_uris: ['https://old.example/cb'] } },
  };
  const result = await configureManagedOAuth({
    dashboard: 'https://dashboard.example.com',
    accountId: 'account-1',
    token: 'secret-token',
    appId: 'app-1',
    apply: true,
    fetchImpl: mockAccessFetch(current, calls),
  });

  assert.equal(result.applied, true);
  assert.deepEqual(calls.map((call) => call.init.method), ['GET', 'PUT']);
  const putBody = JSON.parse(calls[1].init.body);
  assert.deepEqual(putBody.policies, current.policies);
  assert.deepEqual(putBody.oauth_configuration.dynamic_client_registration.allowed_uris, [
    'https://old.example/cb',
    'https://dashboard.example.com/oauth/android/callback',
  ]);
});

test('application ID can be discovered from the configured Access audience', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/access/apps?aud=')) {
      return new Response(JSON.stringify({ success: true, result: [{ id: 'app-1', aud: 'aud-1' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, result: { id: 'app-1', domain: 'dashboard.example.com' } }), { status: 200 });
  };
  const result = await configureManagedOAuth({
    dashboard: 'https://dashboard.example.com',
    accountId: 'account-1',
    token: 'secret-token',
    aud: 'aud-1',
    fetchImpl,
  });
  assert.equal(result.appId, 'app-1');
  assert.deepEqual(calls.map((call) => call.init.method), ['GET', 'GET']);
  assert.match(calls[0].url, /[?&]aud=aud-1$/);
});

test('audience discovery refuses a record that omits the exact aud field', async () => {
  await assert.rejects(
    configureManagedOAuth({
      dashboard: 'https://dashboard.example.com',
      accountId: 'account-1',
      token: 'secret-token',
      aud: 'aud-1',
      fetchImpl: async () => new Response(JSON.stringify({ success: true, result: [{ id: 'app-1' }] }), { status: 200 }),
    }),
    /expected exactly one Access application.*found 0/,
  );
});

