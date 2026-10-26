/**
 * MCP protocol core for the dashboard: JSON-RPC 2.0 plus the two live protocol eras.
 *
 * The specification moved to a stateless, per-request shape in 2026-07-28: `initialize`,
 * `notifications/initialized`, `ping`, sessions and the GET stream are gone, and each request
 * carries its own version, capabilities and identity in `_meta`. Nearly every client deployed
 * today still opens with the 2025-11-25 handshake, and the spec's own compatibility matrix says a
 * legacy client cannot fall forward to a modern-only server. This module therefore implements a
 * DUAL-ERA server, which the spec explicitly permits: an `initialize` opens the legacy branch, a
 * request carrying modern `_meta` opens the modern one, and both may be served on one endpoint.
 *
 * Transport concerns (headers, HTTP status, Origin) live in http.mjs; this file decides what a
 * message means. That split is what lets the same dispatch serve HTTP and stdio.
 */
import { mcpTools, callTool, ToolInputError } from './tools.mjs';

export const SERVER_INFO = Object.freeze({ name: 'uni-dashboard', version: '0.1.0' });

/** Current revision: stateless, per-request metadata, no handshake. */
export const MODERN_VERSION = '2026-07-28';
/** Newest handshake revision. Advertised to legacy clients that ask for something we do not know. */
export const LEGACY_VERSION = '2025-11-25';
export const LEGACY_VERSIONS = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18', LEGACY_VERSION]);
export const SUPPORTED_VERSIONS = Object.freeze([MODERN_VERSION, ...LEGACY_VERSIONS]);

const MODERN_PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const MODERN_CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const MODERN_SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';

const INSTRUCTIONS = [
  'Read-only access to one University of Waterloo student dashboard: that dashboard\'s timetable,',
  'deadlines, reviewed syllabus dates, dining menus, saved dining ranking, live study-space',
  'occupancy, campus service notices, weather, and collection health.',
  '',
  'Data is whatever the dashboard last collected from its configured sources; nothing here polls a',
  'source, writes a row, dismisses an alert, or starts an AI ranking job. Every card and row carries',
  'a freshness envelope: observed_at / valid_until are epoch milliseconds, and state is one of live,',
  'ageing, stale, dead, empty, degraded or failed. Treat stale/dead data as historical, not current,',
  'and check get_source_health before concluding that an empty result means "nothing is happening".',
  '',
  'Dates are YYYY-MM-DD and default to today in America/Toronto. Prefer get_dashboard for an',
  'overview, list_recommendations for priority order, and search_stored_items for a specific',
  'keyword. Do not assume a posted menu means an outlet is open.',
].join('\n');

export function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Which protocol era a message opens. A modern request is identified by its per-request version;
 * anything else — including an `initialize` — is legacy. The spec defines era selection from how
 * the client opens, not from what it claims afterwards.
 */
export function protocolEra(message) {
  if (message?.method === 'initialize') return { era: 'legacy' };
  const meta = message?.params?._meta;
  // Either reserved key marks a modern request. A modern request missing one of them is still
  // modern: the caller must reject it as malformed (-32602, HTTP 400) rather than silently serving
  // it under legacy semantics, which would make the failure look like an unknown method.
  if (meta && typeof meta === 'object' && !Array.isArray(meta) &&
      (typeof meta[MODERN_PROTOCOL_VERSION_KEY] === 'string' || MODERN_CLIENT_CAPABILITIES_KEY in meta)) {
    return { era: 'modern', meta };
  }
  return { era: 'legacy' };
}

/** Modern results carry the polymorphic result type and the server's self-identification. */
function modernResult(id, result) {
  return rpcResult(id, {
    resultType: 'complete',
    ...result,
    _meta: { [MODERN_SERVER_INFO_KEY]: SERVER_INFO },
  });
}

function toolsListPayload() {
  return {
    tools: mcpTools(),
    // The tool set is static, so the client may cache it. Deterministic order is already given by
    // the declaration array, which the spec asks for so clients can cache and prompt-cache reliably.
    ttlMs: 300_000,
    cacheScope: 'private',
  };
}

function discoverPayload() {
  // A dual-era server tells a modern client about both eras it serves; a client that selects a
  // 2025-* version here is expected to fall back to the initialize handshake.
  return {
    supportedVersions: [MODERN_VERSION, LEGACY_VERSION],
    capabilities: { tools: { listChanged: false } },
    instructions: INSTRUCTIONS,
    ttlMs: 3_600_000,
    cacheScope: 'public',
  };
}

/**
 * One tool call, shaped as an MCP tool result. Unknown tools and malformed arguments are protocol
 * errors (-32602: the request is structurally wrong and a model cannot repair it); a tool that
 * fails while running returns `isError: true`, which a model can read and retry. Per the spec,
 * a structured error result carries no structuredContent.
 */
async function toolCallResult(params, ctx) {
  const name = typeof params?.name === 'string' ? params.name : '';
  const args = params?.arguments;
  if (!name) throw new ToolInputError('tools/call requires a tool name');
  try {
    const data = await callTool(name, args, ctx);
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return {
      content: [{ type: 'text', text }],
      structuredContent: data,
      isError: false,
    };
  } catch (error) {
    if (error instanceof ToolInputError) throw error;
    const message = error?.message || String(error);
    ctx?.log?.(`[mcp] tool ${name} failed: ${message}`);
    return { content: [{ type: 'text', text: `Tool ${name} failed: ${message}` }], isError: true };
  }
}

async function dispatchModern(message, ctx) {
  const id = message.id;
  switch (message.method) {
    case 'server/discover':
      return { status: 200, body: modernResult(id, discoverPayload()) };
    case 'tools/list':
      return { status: 200, body: modernResult(id, toolsListPayload()) };
    case 'tools/call': {
      const result = await toolCallResult(message.params ?? {}, ctx);
      return { status: 200, body: modernResult(id, result) };
    }
    default:
      // Spec: an unknown modern RPC method is 404 with -32601, not 200.
      return { status: 404, body: rpcError(id, -32601, `Method not found: ${message.method}`) };
  }
}

/**
 * Modern requests must carry their version and client capabilities. Missing either is a malformed
 * request (HTTP 400, -32602); a version we do not implement is -32022 with the versions we do.
 */
function validateModernMeta(message, meta) {
  const version = meta?.[MODERN_PROTOCOL_VERSION_KEY];
  if (typeof version !== 'string' || !version) {
    return { status: 400, body: rpcError(message.id, -32602, `Missing required _meta field: ${MODERN_PROTOCOL_VERSION_KEY}`) };
  }
  if (version !== MODERN_VERSION) {
    return {
      status: 400,
      body: rpcError(message.id, -32022, 'Unsupported protocol version', {
        supported: [MODERN_VERSION, LEGACY_VERSION],
        requested: version,
      }),
    };
  }
  if (!(MODERN_CLIENT_CAPABILITIES_KEY in meta)) {
    return { status: 400, body: rpcError(message.id, -32602, `Missing required _meta field: ${MODERN_CLIENT_CAPABILITIES_KEY}`) };
  }
  return null;
}

async function dispatchLegacy(message, ctx) {
  const id = message.id;
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      const negotiated = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSION;
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      // No ttlMs/cacheScope here: those are modern-era result fields, and a legacy client has no
      // contract for them. The tool array itself is identical across eras.
      return { status: 200, body: rpcResult(id, { tools: mcpTools() }) };
    case 'tools/call': {
      const result = await toolCallResult(message.params ?? {}, ctx);
      return { status: 200, body: rpcResult(id, result) };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { status: 202, body: null };
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${message.method}`) };
  }
}

/**
 * Handle one decoded JSON-RPC message. Returns `{ status, body }`; a null body means "accepted
 * notification, no response", which HTTP renders as 202 and stdio renders as no line.
 */
export async function handleMcpMessage(message, ctx = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request: body must be one JSON-RPC object') };
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { status: 400, body: rpcError(message.id ?? null, -32600, 'Invalid Request: expected JSON-RPC 2.0 with a method') };
  }
  // Notifications have no id and must never receive a response.
  if (message.id === undefined || message.id === null) {
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
      return { status: 202, body: null };
    }
    return { status: 202, body: null };
  }
  try {
    const { era, meta } = protocolEra(message);
    if (era === 'modern') {
      const malformed = validateModernMeta(message, meta);
      if (malformed) return malformed;
      return await dispatchModern(message, ctx);
    }
    return await dispatchLegacy(message, ctx);
  } catch (error) {
    if (error instanceof ToolInputError) {
      // Invalid arguments: -32602. Legacy answers 200, modern answers 200 as well because this is
      // not one of the transport-level failures the spec maps to 400.
      return { status: 200, body: rpcError(message.id, -32602, error.message) };
    }
    return { status: 200, body: rpcError(message.id, -32603, `Internal error: ${error?.message || error}`) };
  }
}

/**
 * Shared 401 for every transport. The body is a JSON-RPC error object, never HTML: a machine client
 * that parses the response as JSON-RPC must see a protocol answer, not an IdP login page.
 */
export function unauthorizedBody() {
  return rpcError(null, -32600, 'Unauthorized: this MCP endpoint requires a Cloudflare Access identity or a configured bearer token');
}
