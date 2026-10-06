import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { assertSafeLocalBind, isLoopbackHost } from '../apps/relay/src/local-auth.mjs';

// Import the server away from any real .env or persistent AI cache.
const scratch = mkdtempSync(join(tmpdir(), 'uni-local-auth-'));
const previousCwd = process.cwd();
process.chdir(scratch);
const { createServer, start } = await import('../apps/relay/src/server.mjs');
process.chdir(previousCwd);
after(() => {
  if (dirname(resolve(scratch)) === resolve(tmpdir()) && basename(scratch).startsWith('uni-local-auth-')) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

async function listener(t, token = '') {
  const store = new SqliteStore(':memory:');
  const { server } = createServer({ store, token, sources: [], serveWeb: false, automaticPolling: false, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  return { root: `http://127.0.0.1:${server.address().port}`, store };
}

// Undici's fetch rewrites Host; use a raw HTTP request to exercise proxy/rebinding headers.
function request(url, method, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('loopback classification does not accept lookalike hostnames or public interfaces', () => {
  for (const host of ['127.0.0.1', '127.9.8.7', '::1', '[::1]', 'localhost', 'LOCALHOST']) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['0.0.0.0', '::', '192.168.1.20', 'localhost.evil.test', '127.evil.test', '127.999.0.1']) assert.equal(isLoopbackHost(host), false, host);
});

test('non-loopback startup requires authentication or an explicit development override', async () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.20']) {
    assert.throws(() => assertSafeLocalBind({ host, token: '' }), /requires RELAY_TOKEN/);
    assert.doesNotThrow(() => assertSafeLocalBind({ host, token: 'synthetic-token' }));
    assert.doesNotThrow(() => assertSafeLocalBind({ host, token: '', allowOpen: true }));
  }
  const path = join(scratch, 'refused.db');
  await assert.rejects(start({ host: '0.0.0.0', token: '', allowOpen: false, dbPath: path, log: () => {} }), /requires RELAY_TOKEN/);
  assert.equal(existsSync(path), false, 'refused startup must not initialize data or background work');
});

test('foreign-origin and cross-site simple writes are refused before credentials mutate', async (t) => {
  const { root } = await listener(t);
  const previous = process.env.LEARN_ICS_URL;
  const cases = [
    { origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site' },
    { origin: 'https://foreign.example' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { origin: 'https://foreign.example', 'sec-fetch-site': 'same-origin' },
  ];
  for (const headers of cases) {
    const response = await fetch(`${root}/v1/credentials`, {
      method: 'POST', headers: { 'content-type': 'text/plain', ...headers },
      body: JSON.stringify({ LEARN_ICS_URL: 'https://synthetic.example/must-not-be-saved.ics' }),
    });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.match((await response.json()).error, /cross-site/);
  }
  assert.equal(process.env.LEARN_ICS_URL, previous);
});

test('same-origin proxied writes and native clients without browser headers still work', async (t) => {
  const { root } = await listener(t);
  for (const headers of [
    {},
    { origin: root, 'sec-fetch-site': 'same-origin' },
    { origin: 'http://localhost:5173', host: 'localhost:5173', 'sec-fetch-site': 'same-origin' },
  ]) {
    const response = await request(`${root}/v1/poll`, 'POST', headers);
    assert.equal(response.status, 200, JSON.stringify(headers));
    assert.deepEqual(response.body.receipts, []);
  }
});

test('a spoofed non-local Host cannot read or mutate an open loopback relay', async (t) => {
  const { root } = await listener(t);
  for (const method of ['GET', 'POST']) {
    const response = await request(`${root}/v1/poll`, method, { host: 'rebound.example', origin: 'http://rebound.example', 'sec-fetch-site': 'same-origin' });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /non-local host/);
  }
});

test('bearer authentication remains required and does not bypass the browser write guard', async (t) => {
  const { root } = await listener(t, 'synthetic-token');
  assert.equal((await fetch(`${root}/v1/poll`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${root}/v1/poll`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${root}/v1/poll`, { method: 'POST', headers: { authorization: 'Bearer synthetic-token' } })).status, 200);
  assert.equal((await fetch(`${root}/v1/poll`, {
    method: 'POST', headers: { authorization: 'Bearer synthetic-token', origin: 'https://foreign.example' },
  })).status, 403);
});

test('local credentials reject non-object bodies and cleared values stay removed on disk', async (t) => {
  const { root, store } = await listener(t);
  const originalCwd = process.cwd();
  const names = ['PORTAL_ICS_URL', 'GOOGLE_CALENDAR_ICS_URL', 'LEARN_ICS_URL', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
  const originals = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.chdir(scratch);
  t.after(() => {
    process.chdir(originalCwd);
    for (const name of names) {
      if (originals[name] === undefined) delete process.env[name];
      else process.env[name] = originals[name];
    }
  });
  const post = payload => fetch(`${root}/v1/credentials`, { method: 'POST', body: JSON.stringify(payload) });
  for (const value of [null, [], 'oops']) assert.equal((await post(value)).status, 400);
  for (const name of names) process.env[name] = name.endsWith('_ICS_URL') ? 'https://synthetic.test/old.ics' : 'old-token';
  writeFileSync(join(scratch, '.env'), '# keep this\r\nUNRELATED=value\r\n' + names.map(name => `${name}=${process.env[name]}`).join('\r\n') + '\r\nLEARN_ICS_URL=https://synthetic.test/duplicate.ics\r\n');
  assert.equal((await post(Object.fromEntries(names.map(name => [name, ''])))).status, 200);
  const cleared = readFileSync(join(scratch, '.env'), 'utf8');
  assert.match(cleared, /# keep this/);
  assert.match(cleared, /UNRELATED=value/);
  for (const name of names) {
    assert.equal(process.env[name], undefined);
    assert.equal(cleared.includes(`${name}=`), false, name);
  }
  const future = Date.now() + 6 * 3600_000;
  store.scheduleJob('google-calendar-ics', future);
  store.scheduleJob('uw-learn-ics', future);
  assert.equal((await post({ GOOGLE_CALENDAR_ICS_URL: 'https://synthetic.test/new.ics', LEARN_ICS_URL: 'https://synthetic.test/new-learn.ics' })).status, 200);
  for (const job of store.jobs()) assert.ok(job.next_due_at <= Date.now(), 'changed feeds become due immediately');
});
