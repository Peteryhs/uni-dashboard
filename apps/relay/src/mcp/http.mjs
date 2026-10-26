/**
 * Streamable HTTP binding for the MCP endpoint.
 *
 * One POST per JSON-RPC message, answered with a single `application/json` object. The spec
 * permits either JSON or a request-scoped SSE stream; returning JSON is what makes this endpoint
 * survive Cloudflare Access: there is no long-lived response whose auth or idle state can expire
 * mid-stream, no keepalive to tune, and nothing for the 400 s client-idle or 900 s proxy-idle
 * limits to kill.
 *
 * Both live protocol eras are validated here because their HTTP rules differ, and the difference
 * matters: the same missing header is "assume 2025-03-26" in the legacy era and "reject with 400
 * HeaderMismatch" in the modern one.
 */
import {
  MODERN_VERSION,
  LEGACY_VERSIONS,
  protocolEra,
  handleMcpMessage,
  rpcError,
  unauthorizedBody,
} from './protocol.mjs';
import { recordMcpAudit } from './tokens.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const JSON_TYPE = 'application/json; charset=utf-8';

function jsonBody(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': JSON_TYPE, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
}

/** `=?base64?...?=` is the spec's sentinel for a header value that is not header-safe ASCII. */
function decodeHeaderValue(value) {
  const match = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!match) return value;
  try {
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}

function headerMismatch(id, message) {
  return jsonBody(rpcError(id, -32020, `Header mismatch: ${message}`), 400);
}

/**
 * DNS-rebinding protection. A browser always sends Origin; machine MCP clients do not. Only an
 * absent or same-origin value is accepted, so a hostile page cannot drive this endpoint with a
 * victim's credentials.
 */
function originAllowed(request, url) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === url.origin;
  } catch {
    return false;
  }
}

/** Validate one modern request's mirrored headers against its body, as the spec requires. */
function validateModernHeaders(request, message, meta) {
  const id = message.id;
  const version = request.headers.get('mcp-protocol-version');
  if (!version) return headerMismatch(id, 'missing MCP-Protocol-Version header');
  const bodyVersion = meta['io.modelcontextprotocol/protocolVersion'];
  if (version !== bodyVersion) {
    return headerMismatch(id, `MCP-Protocol-Version header value '${version}' does not match body value '${bodyVersion}'`);
  }
  if (version !== MODERN_VERSION) {
    return jsonBody(
      rpcError(id, -32022, 'Unsupported protocol version', {
        supported: [MODERN_VERSION, ...LEGACY_VERSIONS],
        requested: version,
      }),
      400,
    );
  }
  const methodHeader = request.headers.get('mcp-method');
  if (!methodHeader) return headerMismatch(id, 'missing Mcp-Method header');
  if (methodHeader !== message.method) {
    return headerMismatch(id, `Mcp-Method header value '${methodHeader}' does not match body value '${message.method}'`);
  }
  if (message.method === 'tools/call') {
    const nameHeader = request.headers.get('mcp-name');
    const bodyName = message.params?.name;
    if (nameHeader == null) return headerMismatch(id, 'missing Mcp-Name header for tools/call');
    if (decodeHeaderValue(nameHeader) !== bodyName) {
      return headerMismatch(id, `Mcp-Name header value '${decodeHeaderValue(nameHeader)}' does not match body value '${String(bodyName)}'`);
    }
  }
  return null;
}

/**
 * One MCP POST. Authentication happens in the caller (Worker Access check or local relay token)
 * because the credential source differs per deployment; everything after that is shared.
 */
export async function handleMcpHttp(request, ctx = {}) {
  const url = new URL(request.url);
  const log = ctx.log ?? ((line) => console.log(line));

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { allow: 'POST, OPTIONS', 'cache-control': 'no-store' } });
  }
  if (request.method !== 'POST') {
    // Stateless server: no GET stream for legacy clients, no DELETE session to terminate.
    return jsonBody(rpcError(null, -32600, `${request.method} is not supported by this MCP endpoint`), 405, {
      allow: 'POST, OPTIONS',
    });
  }
  if (!originAllowed(request, url)) {
    return jsonBody(rpcError(null, -32600, 'Origin not allowed'), 403);
  }
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return jsonBody(rpcError(null, -32600, 'Content-Type must be application/json'), 415);
  }
  // The client MUST accept both; this server answers JSON. An Accept that rules JSON out cannot be
  // served by a JSON-only implementation, and saying so is clearer than returning a type it refuses.
  const accept = (request.headers.get('accept') || '').toLowerCase();
  if (accept && !accept.includes('*/*') && !accept.includes('application/json')) {
    return jsonBody(rpcError(null, -32600, 'Accept must include application/json'), 406);
  }

  let raw;
  try {
    raw = await request.text();
  } catch {
    return jsonBody(rpcError(null, -32700, 'Could not read request body'), 400);
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return jsonBody(rpcError(null, -32600, `Request body exceeds ${MAX_BODY_BYTES} bytes`), 413);
  }
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return jsonBody(rpcError(null, -32700, 'Parse error: body is not JSON'), 400);
  }
  // JSON-RPC batching was removed in both live revisions; a client that sends it is wrong.
  if (Array.isArray(message)) {
    return jsonBody(rpcError(null, -32600, 'Invalid Request: JSON-RPC batching is not supported'), 400);
  }
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return jsonBody(rpcError(message?.id ?? null, -32600, 'Invalid Request: expected a single JSON-RPC 2.0 object'), 400);
  }

  const { era, meta } = protocolEra(message);
  if (era === 'modern') {
    const rejected = validateModernHeaders(request, message, meta);
    if (rejected) return rejected;
  } else {
    // Legacy clients that predate 2025-06-18 omit the header; that is legal and means 2025-03-26.
    const version = request.headers.get('mcp-protocol-version');
    if (version && !LEGACY_VERSIONS.includes(version)) {
      return jsonBody(rpcError(message.id, -32600, `Unsupported protocol version: ${version}`), 400);
    }
  }

  const result = await handleMcpMessage(message, ctx);
  const toolName = typeof message.params?.name === 'string' ? message.params.name : '';
  const failed = Boolean(result.body?.error) || result.body?.result?.isError === true;
  if (message.method === 'tools/call') {
    log(`[mcp] tools/call ${toolName || '?'} identity=${ctx.identity ?? 'unknown'} ${failed ? 'error' : 'ok'}`);
    /**
     * Audit is best-effort: a failed insert must never turn a successful tool call into an error,
     * but it must be loud in the log. Only tool calls are recorded — tools/list and discovery are
     * not security-relevant actions and would triple the write volume of a polling client.
     */
    if (ctx.recordAudit !== false && typeof ctx.store?.insertMcpAudit === 'function') {
      try {
        await recordMcpAudit(ctx.store, {
          tokenId: ctx.tokenId ?? null,
          identity: ctx.identity ?? '',
          method: 'tools/call',
          tool: toolName,
          ok: !failed,
          at: Date.now(),
        });
      } catch (error) {
        log(`[mcp] audit write failed: ${error?.message ?? error}`);
      }
    }
  }
  if (result.body === null) return new Response(null, { status: result.status, headers: { 'cache-control': 'no-store' } });
  return jsonBody(result.body, result.status);
}

/**
 * 401 with a JSON-RPC body. A machine client must never receive HTML in place of JSON-RPC: that is
 * the failure mode that makes an auth problem look like a protocol bug for weeks.
 */
export function unauthorizedResponse({ resourceMetadataUrl = null } = {}) {
  const challenge = resourceMetadataUrl
    ? `Bearer realm="uni-dashboard-mcp", resource_metadata="${resourceMetadataUrl}"`
    : 'Bearer realm="uni-dashboard-mcp"';
  return new Response(JSON.stringify(unauthorizedBody()), {
    status: 401,
    headers: {
      'content-type': JSON_TYPE,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'www-authenticate': challenge,
    },
  });
}

/** A valid credential that is missing a scope is `403`, and retrying it cannot help. */
export function forbiddenResponse({ requiredScope = null } = {}) {
  const scopePart = requiredScope ? `, scope="${requiredScope}"` : '';
  return new Response(
    JSON.stringify(rpcError(null, -32600, `Forbidden: this credential is missing the required scope${requiredScope ? ` "${requiredScope}"` : ''}`)),
    {
      status: 403,
      headers: {
        'content-type': JSON_TYPE,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'www-authenticate': `Bearer realm="uni-dashboard-mcp", error="insufficient_scope"${scopePart}`,
      },
    },
  );
}

/**
 * RFC 9728 protected-resource metadata, served only when the deployment has an authorization
 * server to name. Cloudflare Access Managed OAuth publishes the companion RFC 8414 document on the
 * team domain, so pointing here is what lets a spec-following MCP client complete discovery when
 * only `/mcp` and the well-known paths are reachable without a session.
 */
export function protectedResourceMetadata(origin, authorizationServers) {
  const servers = (authorizationServers ?? []).filter(Boolean);
  if (!servers.length) return null;
  return {
    resource: `${origin}/mcp`,
    authorization_servers: servers,
    bearer_methods_supported: ['header'],
    resource_name: 'Uni Dashboard MCP',
  };
}
