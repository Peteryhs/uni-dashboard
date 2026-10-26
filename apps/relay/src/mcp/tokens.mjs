/**
 * Application API keys for the MCP endpoint.
 *
 * The point of these keys is to own the *machine* credential without owning an identity provider:
 * no passwords, no sessions, no OAuth authorization server. A key is 256 random bits, stored only as
 * SHA-256, shown exactly once, scoped, expirable, revocable, and attributable in the audit log.
 *
 * Design rules:
 *   - Opaque tokens, not JWTs. There is nothing to verify offline and nothing to get wrong about
 *     algorithms or key rotation; a lookup by hash is the check.
 *   - The plaintext never reaches storage or a response after creation.
 *   - SHA-256 is right here because the input is 256 bits of uniformity-generated entropy, so there
 *     is no dictionary to attack the way there would be for a password.
 *   - Scopes are checked in the caller before any tool runs, and only names in `MCP_SCOPES` are
 *     accepted when minting, so a typo cannot silently create a broader credential.
 */

export const TOKEN_PREFIX = 'udmcp_';
const TOKEN_BYTES = 32;
export const MCP_SCOPES = Object.freeze(['mcp:read']);
export const DEFAULT_SCOPE = 'mcp:read';
const TOUCH_INTERVAL_MS = 60_000;
const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const AUDIT_PRUNE_ONE_IN = 64;
const MAX_NAME = 60;
const MAX_DAYS = 3650;

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** 256 random bits, prefixed so a leaked string is recognisable in logs and secret scanners. */
export function generateApiToken() {
  return `${TOKEN_PREFIX}${base64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))}`;
}

/** Hex SHA-256, the only form that is stored. Works in Workerd and Node through Web Crypto. */
export async function hashApiToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Cheap shape check before a hash lookup, so garbage never reaches the database. */
export function looksLikeApiToken(value) {
  return typeof value === 'string' && /^udmcp_[A-Za-z0-9_-]{43}$/.test(value);
}

/** `Authorization: Bearer <token>` only. No query-string credentials, which leak into logs. */
export function bearerFrom(request) {
  const header = request?.headers?.get?.('authorization') ?? '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : '';
}

export function parseScopes(value) {
  const scopes = Array.isArray(value) ? value : String(value ?? '').split(/\s+/);
  return [...new Set(scopes.map((scope) => String(scope).trim()).filter(Boolean))];
}

function publicToken(row) {
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    created_at: row.created_at,
    expires_at: row.expires_at ?? null,
    last_used_at: row.last_used_at ?? null,
    revoked_at: row.revoked_at ?? null,
  };
}

/**
 * Validate a presented key. Returns the public row plus `tokenId`, or null for wrong, revoked or
 * expired keys. The returned object never contains the hash.
 */
export async function authenticateApiToken(store, token, { now = Date.now() } = {}) {
  if (!looksLikeApiToken(token)) return null;
  const row = await store.apiTokenByHash(await hashApiToken(token));
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at != null && row.expires_at <= now) return null;
  // One write at most per minute per key: a client that polls tools/list should not turn into a
  // D1 write per request.
  await store.touchApiToken(row.id, now, now - TOUCH_INTERVAL_MS);
  return publicToken(row);
}

export class ApiTokenInputError extends Error {}

/**
 * Mint a key. The returned `.token` is the only copy of the plaintext; everything else is metadata
 * that is safe to show again.
 */
export async function createApiToken(store, { name, scopes = [DEFAULT_SCOPE], expiresInDays = null } = {}, { now = Date.now() } = {}) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName || cleanName.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(cleanName)) {
    throw new ApiTokenInputError(`name must be 1-${MAX_NAME} printable characters`);
  }
  const requested = parseScopes(scopes);
  if (!requested.length) throw new ApiTokenInputError('at least one scope is required');
  const unknown = requested.filter((scope) => !MCP_SCOPES.includes(scope));
  if (unknown.length) throw new ApiTokenInputError(`unknown scope: ${unknown.join(', ')}; allowed: ${MCP_SCOPES.join(', ')}`);
  let expiresAt = null;
  if (expiresInDays != null) {
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > MAX_DAYS) {
      throw new ApiTokenInputError(`expiresInDays must be an integer between 1 and ${MAX_DAYS}, or null`);
    }
    expiresAt = now + expiresInDays * 86_400_000;
  }
  const token = generateApiToken();
  const row = {
    id: crypto.randomUUID(),
    name: cleanName,
    tokenSha256: await hashApiToken(token),
    scopes: requested.join(' '),
    createdAt: now,
    expiresAt,
  };
  await store.insertApiToken(row);
  return {
    token,
    ...publicToken({
      id: row.id,
      name: row.name,
      scopes: row.scopes,
      created_at: row.createdAt,
      expires_at: row.expiresAt,
      last_used_at: null,
      revoked_at: null,
    }),
  };
}

/** Metadata only: safe to list, and it contains no hash. */
export async function listApiTokens(store) {
  const rows = await store.apiTokens();
  return rows.map(publicToken);
}

/** Revoke once; a second revoke reports false rather than moving the timestamp. */
export async function revokeApiToken(store, id, { now = Date.now() } = {}) {
  if (typeof id !== 'string' || !id.trim()) throw new ApiTokenInputError('token id is required');
  return (await store.revokeApiToken(id.trim(), now)) > 0;
}

/**
 * One audit row per tool call, pruned lazily. Pruning is probabilistic on purpose: a DELETE on every
 * call would spend D1 quota and query budget for a table that needs bound, not exact, retention.
 */
export async function recordMcpAudit(store, { tokenId = null, identity = '', method, tool = '', ok = true, at = Date.now() }) {
  await store.insertMcpAudit({ tokenId, identity, method, tool, ok, at });
  if (Math.random() < 1 / AUDIT_PRUNE_ONE_IN) await store.pruneMcpAudit(at - AUDIT_RETENTION_MS);
}
