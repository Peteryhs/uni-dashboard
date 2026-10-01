import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRelayResponse, localRelayToken, readRelayJson, RelayError } from '../apps/web/src/lib/relay-response.mjs';

test('deployed Access sessions never send a legacy local relay bearer token', () => {
  for (const origin of ['https://uni-dashboard.petershao288.workers.dev', 'https://dashboard.example.com', 'https://localhost.example.com']) {
    assert.equal(localRelayToken('old-token', origin), '');
  }
  for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'http://192.168.1.10:8787']) {
    assert.equal(localRelayToken('local-token', origin), 'local-token');
  }
});

test('SPA HTML response explains routing failure rather than claiming missing credentials', async () => {
  const response = new Response('<html>dashboard</html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(checkRelayResponse(response), error => error instanceof RelayError && /routing fixed/.test(error.message) && !/Sign-in required/.test(error.message));
});

test('Access login HTML and unauthorized API responses ask for sign-in', async () => {
  const response = new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
  Object.defineProperty(response, 'redirected', { value: true });
  await assert.rejects(checkRelayResponse(response), error => error.status === 401);
  await assert.rejects(checkRelayResponse(new Response('', { status: 401 })), /Cloudflare sign-in/);
  await assert.rejects(checkRelayResponse(new Response('', { status: 401 }), true), /Connection token rejected/);
});

test('backend Access configuration failures explain the owner fix without clearing state', async () => {
  const response = Response.json({ error: 'access not configured' }, { status: 503 });
  await assert.rejects(checkRelayResponse(response), /ACCESS_TEAM_DOMAIN and ACCESS_AUD/);
  assert.deepEqual(await response.json(), { error: 'access not configured' });
  await assert.rejects(checkRelayResponse(Response.json({ error: 'access verification unavailable' }, { status: 503 })), /could not verify/);
});

test('valid JSON and server validation messages are preserved', async () => {
  const response = Response.json({ portal: { configured: true } });
  await checkRelayResponse(response);
  assert.deepEqual(await readRelayJson(response), { portal: { configured: true } });
  await assert.rejects(readRelayJson(Response.json({ error: 'Invalid feed URL' }, { status: 400 })), /Invalid feed URL/);
  await assert.rejects(readRelayJson(new Response('broken', { headers: { 'content-type': 'application/json' } })), /unreadable data/);
});
