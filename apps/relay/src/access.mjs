/**
 * Cloudflare Access verification for the Worker.
 *
 * Access sits in front of the Worker and signs every request it lets through with a JWT in the
 * `Cf-Access-Jwt-Assertion` header, for a browser login and a service token alike. Checking that
 * JWT here, instead of trusting that Access ran, closes the routes Access does not cover: the
 * `*.workers.dev` hostname, preview URLs, and any route added later without a policy.
 *
 * Fails closed: without ACCESS_TEAM_DOMAIN and ACCESS_AUD every /v1 route is refused, unless
 * ACCESS_DISABLED=1 is set explicitly (local `wrangler dev` and tests only, never in production).
 */

const CERTS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;

/** Signing keys per team domain, so an isolate fetches the certs once an hour, not per request. */
const certsCache = new Map();

export function accessConfig(env = {}) {
  const read = (key) => String(env[key] ?? process.env[key] ?? '').trim();
  const teamDomain = read('ACCESS_TEAM_DOMAIN').replace(/\/+$/, '');
  const aud = read('ACCESS_AUD');
  const disabled = /^(1|true|yes)$/i.test(read('ACCESS_DISABLED'));
  const normalized = teamDomain && !/^https:\/\//.test(teamDomain) ? `https://${teamDomain}` : teamDomain;
  return { teamDomain: normalized, aud, disabled, configured: Boolean(normalized && aud) };
}

function b64urlBytes(part) {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(part) {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(part)));
}

async function signingKeys(teamDomain, fetchImpl, now, force = false) {
  const hit = certsCache.get(teamDomain);
  if (hit && !force && now - hit.at < CERTS_TTL_MS) return hit.keys;
  const res = await fetchImpl(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs ${res.status}`);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  certsCache.set(teamDomain, { keys, at: now });
  return keys;
}

/**
 * Returns { ok: true, identity } or { ok: false, reason }. `reason` is for logs, not for the client.
 */
export async function verifyAccessJwt(token, { teamDomain, aud, fetchImpl = fetch, now = Date.now() }) {
  if (!token) return { ok: false, reason: 'missing assertion' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };

  let header;
  let payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    return { ok: false, reason: 'malformed token' };
  }
  // Pinning the algorithm stops `alg: none` and any HMAC-with-the-public-key confusion.
  if (!header || typeof header !== 'object' || Array.isArray(header) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'malformed token' };
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'unexpected algorithm' };

  let signature;
  try { signature = b64urlBytes(parts[2]); }
  catch { return { ok: false, reason: 'malformed signature' }; }

  let keys = await signingKeys(teamDomain, fetchImpl, now);
  // An unknown kid usually means Access rotated its keys since the cache filled.
  if (!keys.has(header.kid)) keys = await signingKeys(teamDomain, fetchImpl, now, true);
  const key = keys.get(header.kid);
  if (!key) return { ok: false, reason: 'unknown signing key' };

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
  if (!valid) return { ok: false, reason: 'bad signature' };

  const nowS = Math.floor(now / 1000);
  if (payload.iss !== teamDomain) return { ok: false, reason: 'wrong issuer' };
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) return { ok: false, reason: 'wrong audience' };
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < nowS) return { ok: false, reason: 'expired' };
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > nowS) return { ok: false, reason: 'not yet valid' };

  // A browser login carries an email; a service token carries its client id as common_name.
  return { ok: true, identity: payload.email || payload.common_name || payload.sub || 'unknown' };
}

/**
 * Browser logins authenticate by cookie, so a hostile page could make the browser send a write
 * request with that cookie attached. Refuse state-changing requests that say they came from
 * another site. The Android app sends neither header, so it is unaffected.
 */
export function isCrossSiteWrite(request, url) {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return false;
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = request.headers.get('origin');
  return Boolean(origin && origin !== url.origin);
}

/** Test hook: forget cached signing keys. */
export function clearAccessCache() {
  certsCache.clear();
}
