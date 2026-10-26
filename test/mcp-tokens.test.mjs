import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { D1Store } from '../apps/relay/src/d1-store.mjs';
import worker from '../apps/relay/src/worker.mjs';
import {
  ApiTokenInputError,
  MCP_SCOPES,
  authenticateApiToken,
  createApiToken,
  hashApiToken,
  listApiTokens,
  looksLikeApiToken,
  revokeApiToken,
} from '../apps/relay/src/mcp/tokens.mjs';

const now = Date.UTC(2026, 8, 21, 12);
const HEX = /^[a-f0-9]{64}$/;

const openStore = () => new SqliteStore(':memory:');

/** The Worker gets a D1 binding that is the same node:sqlite database the test can inspect. */
function createMockD1() {
  const db = new DatabaseSync(':memory:');
  const api = {
    async exec(query) { db.exec(query); return { count: 0, duration: 0 }; },
    prepare(sql) {
      let bound = [];
      return {
        bind(...args) { bound = args; return this; },
        async run() { const result = db.prepare(sql).run(...bound); return { success: true, meta: { changes: Number(result.changes ?? 0), last_row_id: Number(result.lastInsertRowid ?? 0) } }; },
        async all() { return { success: true, results: db.prepare(sql).all(...bound) }; },
        async first(column) { const row = db.prepare(sql).get(...bound); if (!row) return null; return column ? row[column] : row; },
      };
    },
    async batch(statements) { const out = []; for (const statement of statements) out.push(await statement.run()); return out; },
  };
  return { db, api };
}

function workerEnv(overrides = {}) {
  // Empty strings mask any ACCESS_* that a previously imported module put on process.env, so each
  // test decides its own auth configuration.
  return {
    DB: createMockD1().api,
    ACCESS_TEAM_DOMAIN: '',
    ACCESS_AUD: '',
    MCP_ACCESS_AUD: '',
    ...overrides,
  };
}

function rpc(method, params = {}, id = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

async function mcpPost(env, { method = 'POST', body = rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } }), headers = {} } = {}) {
  return worker.fetch(
    new Request('https://mcp.example/mcp', {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(method === 'POST' ? { body } : {}),
    }),
    env,
    {},
  );
}

// ---------------------------------------------------------------------------------------------
// Token store mechanics.
// ---------------------------------------------------------------------------------------------

test('a minted key is shown once and stored only as a SHA-256 hash', async () => {
  const store = openStore();
  const created = await createApiToken(store, { name: 'laptop', expiresInDays: 90 }, { now });
  assert.ok(looksLikeApiToken(created.token), 'token has the recognisable udmcp_ shape');
  assert.equal(created.name, 'laptop');
  assert.deepEqual(created.scopes, ['mcp:read']);
  assert.equal(created.expires_at, now + 90 * 86_400_000);
  assert.equal(created.token_sha256, undefined, 'the mint response does not echo the hash');
  assert.equal(await hashApiToken(created.token), await hashApiToken(created.token));

  const row = store.apiTokenByHash(await hashApiToken(created.token));
  assert.ok(row);
  assert.match(row.token_sha256, HEX);
  assert.notEqual(row.token_sha256, created.token);
  assert.equal(JSON.stringify(row).includes(created.token), false, 'plaintext never reaches the row');

  const listed = await listApiTokens(store);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].token_sha256, undefined);
  assert.equal(listed[0].id, created.id);
});

test('a key verifies only while it is present, unrevoked and unexpired', async () => {
  const store = openStore();
  const created = await createApiToken(store, { name: 'agent' }, { now });

  const verified = await authenticateApiToken(store, created.token, { now });
  assert.equal(verified.id, created.id);
  assert.equal(verified.token_sha256, undefined, 'authentication returns metadata, not the hash');

  assert.equal(await authenticateApiToken(store, 'not-a-token', { now }), null);
  assert.equal(await authenticateApiToken(store, `udmcp_${'a'.repeat(43)}`, { now }), null);
  assert.ok(await authenticateApiToken(store, created.token, { now: now + 10 * 86_400_000 }), 'no expiry was requested, so it stays valid');
  assert.equal(await revokeApiToken(store, created.id, { now }), true);
  assert.equal(await authenticateApiToken(store, created.token, { now }), null);
  assert.equal(await revokeApiToken(store, created.id, { now }), false, 'revoking twice does not move the timestamp');

  const expiring = await createApiToken(store, { name: 'temporary', expiresInDays: 1 }, { now });
  assert.equal(await authenticateApiToken(store, expiring.token, { now: now + 2 * 86_400_000 }), null);
  assert.ok(await authenticateApiToken(store, expiring.token, { now: now + 3_600_000 }));
});

test('last_used_at is written at most once per minute per key', async () => {
  const store = openStore();
  const created = await createApiToken(store, { name: 'poller' }, { now });
  const id = created.id;
  assert.equal(store.touchApiToken(id, now, now - 60_000), 1, 'first use records');
  assert.equal(store.touchApiToken(id, now + 1_000, now + 1_000 - 60_000), 0, 'a second call within a minute is not a write');
  assert.equal(store.touchApiToken(id, now + 120_000, now + 120_000 - 60_000), 1, 'a stale use records again');
  await authenticateApiToken(store, created.token, { now: now + 300_000 });
  assert.equal(store.apiTokens()[0].last_used_at, now + 300_000);
});

test('minting rejects bad input instead of producing a weak credential', async () => {
  const store = openStore();
  await assert.rejects(() => createApiToken(store, { name: '' }), ApiTokenInputError);
  await assert.rejects(() => createApiToken(store, { name: 'x'.repeat(61) }), ApiTokenInputError);
  await assert.rejects(() => createApiToken(store, { name: 'x', scopes: ['admin'] }), ApiTokenInputError);
  await assert.rejects(() => createApiToken(store, { name: 'x', scopes: [] }), ApiTokenInputError);
  await assert.rejects(() => createApiToken(store, { name: 'x', expiresInDays: 0 }), ApiTokenInputError);
  await assert.rejects(() => createApiToken(store, { name: 'x', expiresInDays: 1.5 }), ApiTokenInputError);
  assert.deepEqual(MCP_SCOPES, ['mcp:read']);
  assert.equal((await listApiTokens(store)).length, 0);
});

// ---------------------------------------------------------------------------------------------
// Worker: MCP_AUTH_MODE=token, no Cloudflare Access in the path.
// ---------------------------------------------------------------------------------------------

test('token mode accepts a minted key and nothing else', async () => {
  const mock = createMockD1();
  const env = { DB: mock.api, MCP_AUTH_MODE: 'token', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
  const store = new D1Store(mock.api);
  await store.init();
  const created = await createApiToken(store, { name: 'agent' }, { now: Date.now() });

  const allowed = await mcpPost(env, { headers: { authorization: `Bearer ${created.token}` } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).result.protocolVersion, '2025-11-25');

  const missing = await mcpPost(env);
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('www-authenticate') || '', /Bearer/);
  assert.equal((await missing.json()).error.code, -32600);

  const wrong = await mcpPost(env, { headers: { authorization: 'Bearer udmcp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
  assert.equal(wrong.status, 401);

  // Token auth must not require Access configuration to be present.
  const noAccessConfig = await mcpPost({ DB: mock.api, MCP_AUTH_MODE: 'token' }, { headers: { authorization: `Bearer ${created.token}` } });
  assert.equal(noAccessConfig.status, 200);

  // The settings screen reads the mode so it can warn when keys are stored but ignored.
  const listed = await worker.fetch(
    new Request('https://dash.example/v1/mcp-tokens'),
    { DB: mock.api, MCP_AUTH_MODE: 'token', ACCESS_DISABLED: '1' },
    {},
  );
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).auth, { mode: 'token' });
});

test('a revoked or expired key stops working immediately', async () => {
  const mock = createMockD1();
  const env = { DB: mock.api, MCP_AUTH_MODE: 'token', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
  const store = new D1Store(mock.api);
  await store.init();
  const created = await createApiToken(store, { name: 'agent' }, { now: Date.now() });
  assert.equal((await mcpPost(env, { headers: { authorization: `Bearer ${created.token}` } })).status, 200);
  await revokeApiToken(store, created.id, { now: Date.now() });
  assert.equal((await mcpPost(env, { headers: { authorization: `Bearer ${created.token}` } })).status, 401);

  const expiring = await createApiToken(store, { name: 'short', expiresInDays: 1 }, { now: Date.now() - 2 * 86_400_000 });
  assert.equal((await mcpPost(env, { headers: { authorization: `Bearer ${expiring.token}` } })).status, 401);
});

test('a key without mcp:read is forbidden with 403, not treated as a bad credential', async () => {
  const mock = createMockD1();
  const env = { DB: mock.api, MCP_AUTH_MODE: 'token', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
  const store = new D1Store(mock.api);
  await store.init();
  // Insert directly because the minting API refuses unknown scopes by design.
  await store.insertApiToken({
    id: 'scoped-out',
    name: 'no-read',
    tokenSha256: await hashApiToken('udmcp_' + 'b'.repeat(43)),
    scopes: 'other:read',
    createdAt: Date.now(),
    expiresAt: null,
  });
  const response = await mcpPost(env, { headers: { authorization: `Bearer udmcp_${'b'.repeat(43)}` } });
  assert.equal(response.status, 403);
  assert.match(response.headers.get('www-authenticate') || '', /insufficient_scope/);
});

test('both mode accepts an API key without Access configuration and still rejects nothing-present', async () => {
  const mock = createMockD1();
  const env = { DB: mock.api, MCP_AUTH_MODE: 'both', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
  const store = new D1Store(mock.api);
  await store.init();
  const created = await createApiToken(store, { name: 'mixed' }, { now: Date.now() });
  assert.equal((await mcpPost(env, { headers: { authorization: `Bearer ${created.token}` } })).status, 200);
  assert.equal((await mcpPost(env)).status, 401);
});

test('access mode ignores API keys and stays fail-closed', async () => {
  const mock = createMockD1();
  const store = new D1Store(mock.api);
  await store.init();
  const created = await createApiToken(store, { name: 'agent' }, { now: Date.now() });
  // Not configured at all: 503, before any credential is considered.
  const unconfigured = await mcpPost({ DB: mock.api, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' }, { headers: { authorization: `Bearer ${created.token}` } });
  assert.equal(unconfigured.status, 503);
  // Configured Access but no assertion: the API key is not a substitute in this mode.
  const configured = await mcpPost({
    DB: mock.api,
    ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    ACCESS_AUD: 'aud-tag',
  }, { headers: { authorization: `Bearer ${created.token}` } });
  assert.equal(configured.status, 401);
});

// ---------------------------------------------------------------------------------------------
// Owner-only administration over /v1, plus audit.
// ---------------------------------------------------------------------------------------------

test('the owner can mint, list and revoke keys over /v1 without leaking the secret', async () => {
  const env = { DB: createMockD1().api, ACCESS_DISABLED: '1' };
  const created = await worker.fetch(
    new Request('https://dash.example/v1/mcp-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'laptop', expires_in_days: 30 }),
    }),
    env,
    {},
  );
  assert.equal(created.status, 201);
  const minted = await created.json();
  assert.ok(looksLikeApiToken(minted.token));
  assert.equal(minted.name, 'laptop');
  assert.match(minted.warning, /only time/);

  const listed = await worker.fetch(new Request('https://dash.example/v1/mcp-tokens'), env, {});
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.tokens.length, 1);
  assert.deepEqual(body.auth, { mode: 'access' }, 'the UI is told which auth mode the deployment runs');
  assert.equal(body.tokens[0].token, undefined, 'the list never returns the plaintext');
  assert.equal(body.tokens[0].token_sha256, undefined, 'the list never returns the hash either');
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(minted.token), false);

  // The minted key works on the agent endpoint in token mode against the same database.
  const tokenEnv = { DB: env.DB, MCP_AUTH_MODE: 'token', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
  assert.equal((await mcpPost(tokenEnv, { headers: { authorization: `Bearer ${minted.token}` } })).status, 200);

  const revoked = await worker.fetch(new Request(`https://dash.example/v1/mcp-tokens/${minted.id}`, { method: 'DELETE' }), env, {});
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { ok: true });
  assert.equal((await mcpPost(tokenEnv, { headers: { authorization: `Bearer ${minted.token}` } })).status, 401);

  const again = await worker.fetch(new Request(`https://dash.example/v1/mcp-tokens/${minted.id}`, { method: 'DELETE' }), env, {});
  assert.equal(again.status, 404);
});

test('the admin routes validate input and reject unsupported methods', async () => {
  const env = { DB: createMockD1().api, ACCESS_DISABLED: '1' };
  const badScope = await worker.fetch(
    new Request('https://dash.example/v1/mcp-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', scopes: ['admin'] }),
    }),
    env,
    {},
  );
  assert.equal(badScope.status, 400);
  const noName = await worker.fetch(
    new Request('https://dash.example/v1/mcp-tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }),
    env,
    {},
  );
  assert.equal(noName.status, 400);
  const wrongMethod = await worker.fetch(new Request('https://dash.example/v1/mcp-tokens', { method: 'PUT' }), env, {});
  assert.equal(wrongMethod.status, 405);
  const badJson = await worker.fetch(
    new Request('https://dash.example/v1/mcp-tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' }),
    env,
    {},
  );
  assert.equal(badJson.status, 400);
});

test('tool calls by an API key are attributed in the audit table', async () => {
  const mock = createMockD1();
  const env = { DB: mock.api, MCP_AUTH_MODE: 'token', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' };
  const store = new D1Store(mock.api);
  await store.init();
  const created = await createApiToken(store, { name: 'auditor' }, { now: Date.now() });

  const call = await mcpPost(env, {
    headers: { authorization: `Bearer ${created.token}` },
    body: rpc('tools/call', { name: 'get_weather', arguments: {} }),
  });
  assert.equal(call.status, 200);
  assert.equal((await call.json()).result.isError, false);

  const rows = mock.db.prepare('SELECT token_id, identity, method, tool, ok FROM mcp_audit').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_id, created.id);
  assert.equal(rows[0].identity, `token:auditor#${created.id}`);
  assert.equal(rows[0].method, 'tools/call');
  assert.equal(rows[0].tool, 'get_weather');
  assert.equal(rows[0].ok, 1);

  // tools/list is not audited: it is not a security-relevant action and would multiply write volume.
  await mcpPost(env, { headers: { authorization: `Bearer ${created.token}` }, body: rpc('tools/list') });
  assert.equal(mock.db.prepare('SELECT COUNT(*) AS n FROM mcp_audit').get().n, 1);
});

// ---------------------------------------------------------------------------------------------
// Local relay parity: same keys work over the Node adapter, and RELAY_TOKEN still works.
// ---------------------------------------------------------------------------------------------

test('the local relay accepts an API key minted into its database', async (t) => {
  const { createServer } = await import('../apps/relay/src/server.mjs');
  const store = openStore();
  const created = await createApiToken(store, { name: 'local-agent' }, { now: Date.now() });
  const { server } = createServer({ store, token: '', sources: [], serveWeb: false, automaticPolling: false, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(() => { store.close(); resolve(); })));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = rpc('tools/call', { name: 'get_weather', arguments: {} });

  const allowed = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
    body,
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).result.isError, false);

  const wrong = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer udmcp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    body: rpc('tools/list'),
  });
  assert.equal(wrong.status, 401);

  const audit = store.db.prepare('SELECT identity, method, tool FROM mcp_audit').all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].identity, `token:local-agent#${created.id}`);
  assert.equal(audit[0].tool, 'get_weather');
});

test('the local relay exposes owner-only key routes so Settings works without curl', async (t) => {
  const { createServer } = await import('../apps/relay/src/server.mjs');
  const store = openStore();
  const { server } = createServer({ store, token: '', sources: [], serveWeb: false, automaticPolling: false, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(() => { store.close(); resolve(); })));
  const base = `http://127.0.0.1:${server.address().port}`;

  const mintedResponse = await fetch(`${base}/v1/mcp-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'vps-agent', expires_in_days: 30 }),
  });
  assert.equal(mintedResponse.status, 201);
  const minted = await mintedResponse.json();
  assert.ok(looksLikeApiToken(minted.token));
  assert.equal(minted.name, 'vps-agent');

  const listed = await fetch(`${base}/v1/mcp-tokens`);
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.tokens.length, 1);
  assert.deepEqual(body.auth, { mode: 'local' });
  assert.equal(JSON.stringify(body).includes(minted.token), false);
  assert.equal(body.tokens[0].token_sha256, undefined);

  const revoked = await fetch(`${base}/v1/mcp-tokens/${minted.id}`, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  const again = await fetch(`${base}/v1/mcp-tokens/${minted.id}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
});
