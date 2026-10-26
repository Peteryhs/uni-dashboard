import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import worker from '../apps/relay/src/worker.mjs';
import { handleMcpMessage, MODERN_VERSION, LEGACY_VERSION } from '../apps/relay/src/mcp/protocol.mjs';
import { handleMcpHttp } from '../apps/relay/src/mcp/http.mjs';
import { mcpTools } from '../apps/relay/src/mcp/tools.mjs';

const MODERN = MODERN_VERSION;
const now = Date.UTC(2026, 8, 21, 12); // 2026-09-21 08:00 in Toronto
const MIN = 60_000;

/** A fixed clock keeps every freshness state and default date deterministic. */
const ctx = (store, overrides = {}) => ({
  store,
  now,
  runtime: { target: 'node', uptime_scope: 'process', polling: 'manual' },
  identity: 'test',
  log: () => {},
  ...overrides,
});

function seed(store) {
  store.upsertRows('timeline_event', [
    { source_id: 'uw-portal-ics', external_id: 'c1', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'class', title: 'ECE 150 LEC 001', location: 'E7 2317', starts_at: now + 6 * 60 * MIN, ends_at: now + 7 * 60 * MIN },
    { source_id: 'uw-learn-ics', external_id: 'd1', observed_at: now - MIN, valid_until: now + 15 * MIN, kind: 'deadline', title: 'ECE 150 - Assignment 3 due', starts_at: now + 20 * 60 * MIN, ends_at: now + 20 * 60 * MIN },
  ]);
  store.upsertRows('menu_item', [
    { source_id: 'uw-food-daily-menu', external_id: '2026-09-21::REV::Soup', observed_at: now - 3600_000, valid_until: now + 12 * 3600_000, outlet: 'REVelation - Residence Dining Hall', station: 'Hot Dish', dish: 'Soup', service_date: '2026-09-21' },
    { source_id: 'uw-food-daily-menu', external_id: '2026-09-21::OTH::Chicken', observed_at: now - 3600_000, valid_until: now + 12 * 3600_000, outlet: 'Station 57', station: 'Grill', dish: 'Chicken', service_date: '2026-09-21' },
  ]);
  store.upsertRows('notice', [
    { source_id: 'uw-status', external_id: 'n1', observed_at: now - MIN, valid_until: now + 60 * MIN, severity: 'major', scope: 'Campus', title: 'Power outage in E7', body: 'Classes may be moved.', url: 'https://status.example/1' },
  ]);
  return store;
}

const freshStore = () => new SqliteStore(':memory:');

// ---------------------------------------------------------------------------------------------
// Helpers that speak the HTTP binding exactly as a client would.
// ---------------------------------------------------------------------------------------------

function post(body, { headers = {}, origin = null, url = 'https://dash.example/mcp' } = {}) {
  const finalHeaders = { 'content-type': 'application/json', ...headers };
  if (origin) finalHeaders.origin = origin;
  return new Request(url, { method: 'POST', headers: finalHeaders, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

function modernMessage(method, params = {}, id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
}

function modernHeaders(method, name = null) {
  const headers = { 'mcp-protocol-version': MODERN, 'mcp-method': method };
  if (name) headers['mcp-name'] = name;
  return headers;
}

async function callHttp(body, options = {}, store = freshStore()) {
  const request = post(body, options);
  const response = await handleMcpHttp(request, ctx(store));
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

// The Worker test uses an in-memory D1 shim so the same handler code runs without Wrangler.
function createMockD1() {
  const db = new DatabaseSync(':memory:');
  return {
    async exec(query) { db.exec(query); return { count: 0, duration: 0 }; },
    prepare(sql) {
      let bound = [];
      return {
        bind(...args) { bound = args; return this; },
        async run() { const result = db.prepare(sql).run(...bound); return { success: true, meta: { changes: Number(result.changes ?? 0) } }; },
        async all() { return { success: true, results: db.prepare(sql).all(...bound) }; },
        async first(column) { const row = db.prepare(sql).get(...bound); if (!row) return null; return column ? row[column] : row; },
      };
    },
    async batch(statements) { const out = []; for (const statement of statements) out.push(await statement.run()); return out; },
  };
}

// This suite drives the handlers directly and reads a local SQLite store, so it needs no network
// stub. Deliberately no top-level beforeEach: under `node --test --test-isolation=none` such a hook
// applies to every test in the process, and a fetch stub here would hijack other files' clients.

// ---------------------------------------------------------------------------------------------
// Legacy era (2025-11-25 and earlier): the handshake nearly every deployed client uses.
// ---------------------------------------------------------------------------------------------

test('legacy initialize echoes a supported version and declares the tools capability', async () => {
  const result = await handleMcpMessage({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
  }, ctx(freshStore()));
  assert.equal(result.status, 200);
  assert.equal(result.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(result.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(result.body.result.serverInfo.name, 'uni-dashboard');
  assert.match(result.body.result.instructions, /Read-only/);
});

test('legacy initialize falls back to the newest handshake revision when the request is unknown', async () => {
  const result = await handleMcpMessage({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '1900-01-01', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
  }, ctx(freshStore()));
  assert.equal(result.body.result.protocolVersion, LEGACY_VERSION);
});

test('legacy ping, initialized notification and unknown methods follow handshake rules', async () => {
  const store = freshStore();
  const ping = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'ping' }, ctx(store));
  assert.deepEqual(ping.body.result, {});
  const initialized = await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx(store));
  assert.equal(initialized.status, 202);
  assert.equal(initialized.body, null);
  // Legacy: an unknown method is a JSON-RPC error on an HTTP 200, not a 404.
  const unknown = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} }, ctx(store));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.error.code, -32601);
});

test('legacy tools/list returns the full read-only catalogue with portable schemas', async () => {
  const { status, body } = await callHttp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(status, 200);
  assert.equal(body.result.tools.length, mcpTools().length);
  assert.deepEqual(body.result.tools.map((tool) => tool.name), mcpTools().map((tool) => tool.name));
  for (const tool of body.result.tools) {
    assert.match(tool.name, /^[A-Za-z0-9_.-]{1,128}$/);
    assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.$schema, undefined, 'the dialect marker is stripped for older validators');
    assert.equal(tool.annotations.readOnlyHint, true);
  }
});

test('legacy tools/call returns one text block mirroring structuredContent', async () => {
  const store = seed(freshStore());
  const { status, body } = await callHttp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_dashboard', arguments: {} } }, {}, store);
  assert.equal(status, 200);
  const result = body.result;
  assert.equal(result.isError, false);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.ok(Array.isArray(result.structuredContent.cards));
  assert.ok(result.structuredContent.cards.length >= 5);
  for (const card of result.structuredContent.cards) {
    assert.equal(typeof card.priority, 'number');
    assert.equal(typeof card.state, 'string');
  }
});

test('unknown tools and invalid arguments are protocol errors, not tool results', async () => {
  const store = freshStore();
  const unknown = await callHttp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'drop_database', arguments: {} } }, {}, store);
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.error.code, -32602);
  assert.match(unknown.body.error.message, /Unknown tool/);

  const badDate = await callHttp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_calendar', arguments: { start: '2026-02-31' } } }, {}, store);
  assert.equal(badDate.body.error.code, -32602);

  const badType = await callHttp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_weather', arguments: { hours: 'twelve' } } }, {}, store);
  assert.equal(badType.body.error.code, -32602);
});

test('a tool that fails while running reports isError with no structuredContent', async () => {
  const broken = { rows() { throw new Error('database unavailable'); } };
  const { status, body } = await callHttp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_menu', arguments: {} } }, {}, broken);
  assert.equal(status, 200);
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /database unavailable/);
  assert.equal(body.result.structuredContent, undefined);
});

test('search_stored_items searches saved rows across shapes', async () => {
  const store = seed(freshStore());
  const { body } = await callHttp({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'search_stored_items', arguments: { query: 'ECE' } },
  }, {}, store);
  assert.equal(body.result.isError, false);
  const payload = body.result.structuredContent;
  assert.ok(payload.events.some((event) => event.title.includes('ECE 150')));
  assert.equal(payload.menu.length, 0);
  assert.equal(payload.notices.length, 0, 'the seeded notice has no ECE text');

  const noticeSearch = await callHttp({
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'search_stored_items', arguments: { query: 'outage', kinds: ['notices'] } },
  }, {}, store);
  const noticePayload = noticeSearch.body.result.structuredContent;
  assert.equal(noticePayload.notices.length, 1);
  assert.equal(noticePayload.notices[0].severity, 'major');
  assert.equal(noticePayload.events.length, 0, 'unrequested kinds are not queried');
});

test('get_menu returns the parsed dishes for the campus day, not tomorrow’s pre-posted menu', async () => {
  const store = freshStore();
  store.upsertRows('menu_item', [
    {
      source_id: 'uw-food-daily-menu', external_id: 'menu-today-soup',
      observed_at: now - 3_600_000, valid_until: now + 12 * 3_600_000,
      outlet: 'REVelation - Residence Dining Hall', station: 'Hot Dish', dish: 'Soup',
      service_date: '2026-09-21', diet: ['vegan', 'gluten'], allergens: ['milk'],
    },
    {
      source_id: 'uw-food-daily-menu', external_id: 'menu-tomorrow-curry',
      observed_at: now - 3_600_000, valid_until: now + 36 * 3_600_000,
      outlet: 'REVelation - Residence Dining Hall', station: 'Hot Dish', dish: 'Tomorrow Curry',
      service_date: '2026-09-22', diet: ['halal'], allergens: [],
    },
  ]);
  const { body } = await callHttp({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'get_menu', arguments: { date: '2026-09-21' } },
  }, {}, store);
  const menu = body.result.structuredContent;
  assert.equal(menu.requested_date, '2026-09-21');
  assert.equal(menu.service_date, '2026-09-21');
  assert.equal(menu.status, 'today');
  assert.equal(menu.state, 'live');
  assert.equal(menu.items.length, 1, 'a future service date is not served as today');
  assert.deepEqual(menu.items[0], {
    outlet: 'REVelation - Residence Dining Hall',
    dish: 'Soup',
    station: 'Hot Dish',
    diet: ['vegan', 'gluten'],
    url: '',
    allergens: ['milk'],
  });
});

test('get_menu falls back to the most recent earlier posting', async () => {
  const store = freshStore();
  store.upsertRows('menu_item', [{
    source_id: 'uw-food-daily-menu', external_id: 'menu-friday-pie',
    observed_at: now - 3 * 24 * 3_600_000, valid_until: now - 2 * 24 * 3_600_000,
    outlet: "Mudie's - Residence Dining Hall", station: 'Bakery', dish: 'Friday Pie',
    service_date: '2026-09-18', diet: ['vegetarian'], allergens: [],
  }]);
  const { body } = await callHttp({
    jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'get_menu', arguments: {} },
  }, {}, store);
  const menu = body.result.structuredContent;
  assert.equal(menu.requested_date, '2026-09-21');
  assert.equal(menu.service_date, '2026-09-18');
  assert.equal(menu.status, 'previous');
  assert.equal(menu.items[0].dish, 'Friday Pie');
});

test('search_stored_items reads today’s menu rather than tomorrow’s pre-posted one', async () => {
  const store = freshStore();
  store.upsertRows('menu_item', [
    {
      source_id: 'uw-food-daily-menu', external_id: 'menu-search-today',
      observed_at: now - 3_600_000, valid_until: now + 12 * 3_600_000,
      outlet: 'REVelation - Residence Dining Hall', station: 'Hot Dish', dish: 'BBQ Chicken Drums',
      service_date: '2026-09-21', diet: ['halal'], allergens: [],
    },
    {
      source_id: 'uw-food-daily-menu', external_id: 'menu-search-tomorrow',
      observed_at: now - 3_600_000, valid_until: now + 36 * 3_600_000,
      outlet: 'REVelation - Residence Dining Hall', station: 'Hot Dish', dish: 'Tomorrow Curry',
      service_date: '2026-09-22', diet: ['halal'], allergens: [],
    },
  ]);

  const todaySearch = await callHttp({
    jsonrpc: '2.0', id: 11, method: 'tools/call',
    params: { name: 'search_stored_items', arguments: { query: 'BBQ', kinds: ['menu'] } },
  }, {}, store);
  const todayMenu = todaySearch.body.result.structuredContent.menu;
  assert.equal(todayMenu.length, 1);
  assert.equal(todayMenu[0].service_date, '2026-09-21');

  const tomorrowSearch = await callHttp({
    jsonrpc: '2.0', id: 12, method: 'tools/call',
    params: { name: 'search_stored_items', arguments: { query: 'Tomorrow', kinds: ['menu'] } },
  }, {}, store);
  assert.equal(tomorrowSearch.body.result.structuredContent.menu.length, 0, 'tomorrow is not today’s menu');
});

test('tool calls never write to the store', async () => {
  const store = seed(freshStore());
  const before = {
    runs: store.recentRuns(100).length,
    menu: store.rows('menu_item', {}).length,
    events: store.rows('timeline_event', {}).length,
    notices: store.rows('notice', {}).length,
  };
  for (const tool of mcpTools()) {
    await handleMcpMessage({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: tool.name, arguments: {} } }, ctx(store));
  }
  assert.equal(store.recentRuns(100).length, before.runs);
  assert.equal(store.rows('menu_item', {}).length, before.menu);
  assert.equal(store.rows('timeline_event', {}).length, before.events);
  assert.equal(store.rows('notice', {}).length, before.notices);
});

// ---------------------------------------------------------------------------------------------
// Modern era (2026-07-28): stateless, per-request metadata, no handshake.
// ---------------------------------------------------------------------------------------------

test('modern requests need no handshake, but over HTTP they must carry the mirrored headers', async () => {
  // Protocol level: a single request is self-contained.
  const direct = await handleMcpMessage(modernMessage('tools/list'), ctx(freshStore()));
  assert.equal(direct.status, 200);
  assert.equal(direct.body.result.resultType, 'complete');

  // Transport level: the same body without MCP-Protocol-Version is a header mismatch, not a
  // request that silently falls back to the legacy era.
  const headingless = await callHttp(modernMessage('tools/list'));
  assert.equal(headingless.status, 400);
  assert.equal(headingless.body.error.code, -32020);
});

test('modern server/discover advertises both eras, capabilities and identity', async () => {
  const { status, body } = await callHttp(modernMessage('server/discover'), { headers: modernHeaders('server/discover') });
  assert.equal(status, 200);
  const result = body.result;
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.supportedVersions, [MODERN, LEGACY_VERSION]);
  assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
  assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'uni-dashboard');
  assert.equal(typeof result.instructions, 'string');
  assert.equal(typeof result.ttlMs, 'number');
  assert.equal(typeof result.cacheScope, 'string');
});

test('modern tools/list and tools/call carry resultType and structured results', async () => {
  const store = seed(freshStore());
  const list = await callHttp(modernMessage('tools/list'), { headers: modernHeaders('tools/list') }, store);
  assert.equal(list.status, 200);
  assert.equal(list.body.result.resultType, 'complete');
  assert.equal(list.body.result.tools.length, mcpTools().length);

  const call = await callHttp(
    modernMessage('tools/call', { name: 'get_dashboard', arguments: {} }),
    { headers: modernHeaders('tools/call', 'get_dashboard') },
    store,
  );
  assert.equal(call.status, 200);
  assert.equal(call.body.result.resultType, 'complete');
  assert.equal(call.body.result.isError, false);
  assert.equal(call.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'uni-dashboard');
  assert.ok(Array.isArray(call.body.result.structuredContent.cards));
});

test('modern header validation rejects missing and mismatched mirrored headers', async () => {
  const missingVersion = await callHttp(modernMessage('tools/list'), { headers: { 'mcp-method': 'tools/list' } });
  assert.equal(missingVersion.status, 400);
  assert.equal(missingVersion.body.error.code, -32020);

  const mismatch = await callHttp(modernMessage('tools/list'), { headers: { ...modernHeaders('tools/list'), 'mcp-method': 'tools/call' } });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, -32020);

  const missingName = await callHttp(
    modernMessage('tools/call', { name: 'get_dashboard', arguments: {} }),
    { headers: modernHeaders('tools/call') },
  );
  assert.equal(missingName.status, 400);
  assert.equal(missingName.body.error.code, -32020);

  const wrongName = await callHttp(
    modernMessage('tools/call', { name: 'get_dashboard', arguments: {} }),
    { headers: modernHeaders('tools/call', 'get_weather') },
  );
  assert.equal(wrongName.status, 400);
  assert.equal(wrongName.body.error.code, -32020);
});

test('modern version and _meta requirements map to their specified errors', async () => {
  const unsupported = modernMessage('tools/list');
  unsupported.params._meta['io.modelcontextprotocol/protocolVersion'] = '1999-01-01';
  const version = await callHttp(unsupported, {
    headers: { 'mcp-protocol-version': '1999-01-01', 'mcp-method': 'tools/list' },
  });
  assert.equal(version.status, 400);
  assert.equal(version.body.error.code, -32022);
  assert.ok(version.body.error.data.supported.includes(MODERN));

  const noCapabilities = modernMessage('tools/list');
  delete noCapabilities.params._meta['io.modelcontextprotocol/clientCapabilities'];
  const capabilities = await callHttp(noCapabilities, { headers: modernHeaders('tools/list') });
  assert.equal(capabilities.status, 400);
  assert.equal(capabilities.body.error.code, -32602);
});

test('modern unknown methods are 404 with -32601, as the transport specifies', async () => {
  const { status, body } = await callHttp(modernMessage('resources/list'), { headers: modernHeaders('resources/list') });
  assert.equal(status, 404);
  assert.equal(body.error.code, -32601);
});

test('a modern notification is accepted with 202 and no body', async () => {
  const message = { jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} } } };
  const { status, body } = await callHttp(message, { headers: modernHeaders('notifications/initialized') });
  assert.equal(status, 202);
  assert.equal(body, null);
});

// ---------------------------------------------------------------------------------------------
// HTTP binding behaviour shared by both eras.
// ---------------------------------------------------------------------------------------------

test('the endpoint is POST-only and stateless: GET and DELETE answer 405', async () => {
  for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
    const response = await handleMcpHttp(new Request('https://dash.example/mcp', { method }), ctx(freshStore()));
    assert.equal(response.status, 405, `${method} must be refused`);
    assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
  }
  const options = await handleMcpHttp(new Request('https://dash.example/mcp', { method: 'OPTIONS' }), ctx(freshStore()));
  assert.equal(options.status, 204);
});

test('malformed bodies and JSON-RPC batching are rejected before dispatch', async () => {
  const notJson = await callHttp('{not json');
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body.error.code, -32700);

  const batch = await callHttp([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  assert.equal(batch.status, 400);
  assert.equal(batch.body.error.code, -32600);

  const wrongEnvelope = await callHttp({ jsonrpc: '1.0', id: 1, method: 'tools/list' });
  assert.equal(wrongEnvelope.status, 400);
  assert.equal(wrongEnvelope.body.error.code, -32600);
});

test('cross-origin POSTs are refused, same-origin and origin-less requests are allowed', async () => {
  const evil = await callHttp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const same = await callHttp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { origin: 'https://dash.example' });
  assert.equal(same.status, 200);
  const absent = await callHttp({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(absent.status, 200);
});

test('content negotiation requires a JSON body and a JSON-capable Accept', async () => {
  const wrongType = await handleMcpHttp(new Request('https://dash.example/mcp', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
  }), ctx(freshStore()));
  assert.equal(wrongType.status, 415);

  const sseOnly = await handleMcpHttp(new Request('https://dash.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }), ctx(freshStore()));
  assert.equal(sseOnly.status, 406);
});

test('a legacy protocol-version header must name a supported handshake revision', async () => {
  const unsupported = await callHttp(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { headers: { 'mcp-protocol-version': '2024-01-01' } },
  );
  assert.equal(unsupported.status, 400);
  const supported = await callHttp(
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { headers: { 'mcp-protocol-version': '2025-11-25' } },
  );
  assert.equal(supported.status, 200);
});

// ---------------------------------------------------------------------------------------------
// Local relay: the Node adapter path (IncomingMessage -> Web Request -> Web Response).
// ---------------------------------------------------------------------------------------------

test('the local relay serves /mcp with JSON-RPC framing and relay-token auth', async (t) => {
  const { createServer } = await import('../apps/relay/src/server.mjs');
  const store = new SqliteStore(':memory:');
  const { server } = createServer({ store, token: 'synthetic-token', sources: [], serveWeb: false, automaticPolling: false, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  const denied = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate') || '', /Bearer/);
  assert.equal((await denied.json()).error.code, -32600, 'the 401 body is JSON-RPC');

  const allowed = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-token' },
    body,
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).result.tools.length, mcpTools().length);

  // Auth is evaluated before transport semantics: an unauthenticated GET is 401, and an
  // authenticated one reaches the stateless handler and gets 405 (no SSE stream exists).
  const unauthGet = await fetch(`${base}/mcp`);
  assert.equal(unauthGet.status, 401);

  const get = await fetch(`${base}/mcp`, { headers: { authorization: 'Bearer synthetic-token' } });
  assert.equal(get.status, 405);
  assert.match(get.headers.get('content-type') || '', /^application\/json/i);
});

// ---------------------------------------------------------------------------------------------
// Worker wiring: route reachability, auth gate and discovery document.
// ---------------------------------------------------------------------------------------------

function workerEnv(overrides = {}) {
  return { DB: createMockD1(), ...overrides };
}

test('the Worker serves /mcp and refuses it without an Access assertion when Access is on', async () => {
  const disabledEnv = workerEnv({ ACCESS_DISABLED: '1' });
  const allowed = await worker.fetch(
    new Request('https://dash.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'w', version: '1' } } }),
    }),
    disabledEnv,
    {},
  );
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).result.protocolVersion, '2025-11-25');

  const guardedEnv = workerEnv({
    ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    ACCESS_AUD: 'aud-tag',
  });
  const denied = await worker.fetch(
    new Request('https://dash.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    }),
    guardedEnv,
    {},
  );
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('content-type') || '', /^application\/json/i);
  assert.match(denied.headers.get('www-authenticate') || '', /resource_metadata=/);
  assert.equal((await denied.json()).error.code, -32600, 'the 401 body is JSON-RPC, never HTML');
});

test('the Worker publishes RFC 9728 protected-resource metadata when Access is configured', async () => {
  const env = workerEnv({ ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud-tag' });
  const response = await worker.fetch(new Request('https://dash.example/.well-known/oauth-protected-resource'), env, {});
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.resource, 'https://dash.example/mcp');
  assert.deepEqual(metadata.authorization_servers, ['https://team.cloudflareaccess.com']);
  assert.deepEqual(metadata.bearer_methods_supported, ['header']);

  const unconfigured = await worker.fetch(new Request('https://dash.example/.well-known/oauth-protected-resource'), workerEnv(), {});
  assert.equal(unconfigured.status, 404);
});

test('MCP_ACCESS_AUD pins /mcp to the agent application and configures it on its own', async () => {
  // A dedicated MCP hostname has its own Access app. Setting MCP_ACCESS_AUD must both (a) make the
  // endpoint configured when the dashboard AUD is absent, and (b) never fall back to ACCESS_AUD.
  const env = workerEnv({ ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', MCP_ACCESS_AUD: 'mcp-aud-tag' });
  const response = await worker.fetch(
    new Request('https://mcp.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    env,
    {},
  );
  assert.equal(response.status, 401, 'an MCP_ACCESS_AUD-only deployment is configured, so it is 401 not 503');
  assert.equal((await response.json()).error.code, -32600);
});

test('the Worker MCP route does not leak the SPA shell and /v1 stays independently gated', async () => {
  const env = workerEnv({ ACCESS_DISABLED: '1' });
  const mcpGet = await worker.fetch(new Request('https://dash.example/mcp', { method: 'GET' }), env, {});
  assert.equal(mcpGet.status, 405);
  assert.match(mcpGet.headers.get('content-type') || '', /^application\/json/i);

  const guarded = workerEnv({ ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud-tag' });
  const v1 = await worker.fetch(new Request('https://dash.example/v1/dashboard'), guarded, {});
  assert.equal(v1.status, 401);
  assert.equal((await v1.json()).error, 'unauthorized');
});

