#!/usr/bin/env node
/**
 * Configure Cloudflare Access Managed OAuth for the Android client.
 *
 * The command is deliberately preview-only unless --apply is supplied:
 *
 *   npm run access:oauth -- --dashboard https://dashboard.example.com --app-id <id>
 *   npm run access:oauth -- --dashboard https://dashboard.example.com --app-id <id> --apply
 *
 * CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are read from the environment.  They are
 * never printed, persisted, or included in a returned summary.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const ACCESS_API_ROOT = 'https://api.cloudflare.com/client/v4';
export const ANDROID_CALLBACK_PATH = '/oauth/android/callback';
export const ACCESS_TOKEN_LIFETIME = '15m';
export const GRANT_SESSION_DURATION = '336h';
export function grantDurationForWeeks(weeks) {
  if (![1, 2, 3].includes(weeks)) throw new Error('--grant-weeks must be 1, 2, or 3');
  return `${weeks * 168}h`;
}
export const ACCESS_REQUEST_TIMEOUT_MS = 15_000;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Normalize the dashboard input to an HTTPS origin.  The callback URI is derived from this
 * value at runtime, so a path, query, fragment, or credentials in the input is ambiguous and
 * refused rather than silently changing the redirect target.
 */
export function normalizeDashboardOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('--dashboard must be an HTTPS origin, for example https://dashboard.example.com');
  }
  if (/\s/.test(value)) {
    throw new Error('--dashboard must not contain whitespace');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--dashboard must be a valid HTTPS origin');
  }
  if (url.protocol !== 'https:') {
    throw new Error('--dashboard must use https');
  }
  if (!url.hostname || url.username || url.password) {
    throw new Error('--dashboard must not contain userinfo');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--dashboard must be an origin without a path, query, or fragment');
  }
  return url.origin;
}

export function androidCallbackUri(dashboard) {
  return `${normalizeDashboardOrigin(dashboard)}${ANDROID_CALLBACK_PATH}`;
}

function parseTarget(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const target = value.trim();
  try {
    const explicitScheme = target.includes('://');
    const url = new URL(explicitScheme ? target : `https://${target}`);
    return { explicitScheme, url };
  } catch {
    return null;
  }
}

function targetMatchesHostname(value, originUrl) {
  const parsed = parseTarget(value);
  if (!parsed || parsed.url.search || parsed.url.hash) return false;
  const targetHost = parsed.url.hostname.toLowerCase().replace(/\.$/, '');
  const wanted = originUrl.hostname.toLowerCase().replace(/\.$/, '');
  if (targetHost.startsWith('*.')) {
    const suffix = targetHost.slice(2);
    if (wanted === suffix || !wanted.endsWith(`.${suffix}`)) return false;
  } else {
    // Cloudflare supports wildcard destinations, but accepting an arbitrary wildcard here could
    // make a typo secure a broader app than the dashboard.  Only the documented leftmost *. form
    // above is considered; everything else must match exactly.
    if (targetHost.includes('*') || targetHost !== wanted) return false;
  }

  // A dashboard on a non-default HTTPS port is a different Access destination.  A target with no
  // explicit scheme is the legacy `domain` form and is interpreted as HTTPS.
  const targetPort = parsed.url.port || (parsed.url.protocol === 'http:' ? '80' : '443');
  const dashboardPort = originUrl.port || '443';
  return parsed.url.protocol === 'https:' && targetPort === dashboardPort;
}

function targetCoversPath(value, path, originUrl) {
  const parsed = parseTarget(value);
  if (!parsed || parsed.url.protocol !== 'https:' || parsed.url.search || parsed.url.hash) return false;
  if (!targetMatchesHostname(value, originUrl)) return false;
  const targetPath = parsed.url.pathname || '/';
  if (targetPath === '/') return true;
  if (targetPath === path) return true;
  // Access uses a trailing `/*` to allow all sub-paths.  The callback is below the root, so a
  // root wildcard covers it; narrower existing destinations must explicitly cover the callback.
  return targetPath.endsWith('/*') && path.startsWith(targetPath.slice(0, -1));
}

function applicationTargets(application) {
  const values = [];
  if (typeof application?.domain === 'string') values.push(application.domain);

  for (const domain of application?.self_hosted_domains ?? []) {
    if (typeof domain === 'string') values.push(domain);
    else if (domain && typeof domain === 'object') {
      for (const key of ['domain', 'uri', 'hostname']) {
        if (typeof domain[key] === 'string') values.push(domain[key]);
      }
    }
  }

  for (const destination of application?.destinations ?? []) {
    if (typeof destination === 'string') values.push(destination);
    else if (destination && typeof destination === 'object') {
      for (const key of ['uri', 'domain', 'hostname']) {
        if (typeof destination[key] === 'string') values.push(destination[key]);
      }
    }
  }
  return values;
}

/** Return true when the Access application protects the dashboard hostname. */
export function applicationCoversDashboard(application, dashboard) {
  const origin = normalizeDashboardOrigin(dashboard);
  const originUrl = new URL(origin);
  const targets = applicationTargets(application);
  return ['/', ANDROID_CALLBACK_PATH].every((path) =>
    targets.some((target) => targetCoversPath(target, path, originUrl)),
  );
}

/**
 * Build a full Access application PUT body.  Cloudflare's update endpoint replaces the
 * application, so the body starts as a deep copy of GET result and only the Managed OAuth
 * fields needed by Android are changed.
 */
export function buildUpdatedApplication(application, callbackUri, grantWeeks = 2) {
  const grantDuration = grantDurationForWeeks(grantWeeks);
  if (!application || typeof application !== 'object' || Array.isArray(application)) {
    throw new Error('Cloudflare returned an invalid Access application');
  }
  let callback;
  try {
    callback = new URL(callbackUri);
  } catch {
    callback = null;
  }
  if (
    !callback ||
    callback.protocol !== 'https:' ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    callback.pathname !== ANDROID_CALLBACK_PATH
  ) {
    throw new Error('callback URI is invalid');
  }

  const updated = cloneJson(application);
  const oauth = updated.oauth_configuration && typeof updated.oauth_configuration === 'object'
    && !Array.isArray(updated.oauth_configuration)
    ? updated.oauth_configuration
    : {};
  const dynamic = oauth.dynamic_client_registration && typeof oauth.dynamic_client_registration === 'object'
    && !Array.isArray(oauth.dynamic_client_registration)
    ? oauth.dynamic_client_registration
    : {};
  const grant = oauth.grant && typeof oauth.grant === 'object' && !Array.isArray(oauth.grant)
    ? oauth.grant
    : {};

  if (dynamic.allowed_uris !== undefined && !Array.isArray(dynamic.allowed_uris)) {
    throw new Error('existing Managed OAuth allowed_uris is not an array; refusing to overwrite it');
  }
  const allowedUris = dynamic.allowed_uris ?? [];
  if (allowedUris.some((uri) => typeof uri !== 'string')) {
    throw new Error('existing Managed OAuth allowed_uris contains a non-string value; refusing to overwrite it');
  }
  if (!allowedUris.includes(callbackUri)) allowedUris.push(callbackUri);

  oauth.enabled = true;
  dynamic.enabled = true;
  dynamic.allowed_uris = allowedUris;
  grant.access_token_lifetime = ACCESS_TOKEN_LIFETIME;
  grant.session_duration = grantDuration;
  oauth.dynamic_client_registration = dynamic;
  oauth.grant = grant;
  updated.oauth_configuration = oauth;
  return updated;
}

function apiPathForApplication(accountId, appId) {
  return `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}`;
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function accessRequest({ fetchImpl, accountId, token, method, path, body, timeoutMs = ACCESS_REQUEST_TIMEOUT_MS }) {
  const response = await fetchImpl(`${ACCESS_API_ROOT}${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await readJsonResponse(response);
  if (response.ok === false || (response.status >= 400) || payload?.success === false) {
    const status = response.status ? ` (${response.status})` : '';
    throw new Error(`Cloudflare Access API ${method} request failed${status}`);
  }
  return payload;
}

export async function getAccessApplication({ accountId, token, appId, fetchImpl = globalThis.fetch, timeoutMs = ACCESS_REQUEST_TIMEOUT_MS }) {
  const payload = await accessRequest({
    fetchImpl,
    accountId,
    token,
    method: 'GET',
    path: `${apiPathForApplication(accountId, appId)}`,
    timeoutMs,
  });
  if (!payload || !payload.result || typeof payload.result !== 'object' || Array.isArray(payload.result)) {
    throw new Error('Cloudflare Access API returned no application');
  }
  return payload.result;
}

export async function updateAccessApplication({ accountId, token, appId, application, fetchImpl = globalThis.fetch, timeoutMs = ACCESS_REQUEST_TIMEOUT_MS }) {
  const payload = await accessRequest({
    fetchImpl,
    accountId,
    token,
    method: 'PUT',
    path: apiPathForApplication(accountId, appId),
    body: application,
    timeoutMs,
  });
  if (!payload || payload.result === undefined) {
    throw new Error('Cloudflare Access API returned no updated application');
  }
  return payload.result;
}

export function readAccessAudFromWrangler(file = 'wrangler.toml') {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = text.match(/^\s*ACCESS_AUD\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m);
  return match?.[1] ?? null;
}

async function discoverApplicationId({ accountId, token, aud, fetchImpl, timeoutMs }) {
  const path = `/accounts/${encodeURIComponent(accountId)}/access/apps?aud=${encodeURIComponent(aud)}`;
  const payload = await accessRequest({ fetchImpl, accountId, token, method: 'GET', path, timeoutMs });
  if (!Array.isArray(payload?.result)) throw new Error('Cloudflare Access API returned no application list');

  // The API supports filtering by aud, and its application schema exposes the optional `aud`
  // field. Require the returned record to carry the exact value as a second boundary: a response
  // that omits aud is ambiguous and must be resolved with an explicit --app-id.
  const withMatchingAud = payload.result.filter((app) => app?.aud === aud);
  if (withMatchingAud.length !== 1) {
    throw new Error(`expected exactly one Access application for ACCESS_AUD; found ${withMatchingAud.length}`);
  }
  const appId = withMatchingAud[0]?.id;
  if (typeof appId !== 'string' || !appId) throw new Error('discovered Access application has no id');
  return appId;
}

export async function resolveApplicationId({ accountId, token, appId, aud, wranglerFile = 'wrangler.toml', fetchImpl = globalThis.fetch, timeoutMs }) {
  if (appId) return appId;
  const configuredAud = aud ?? process.env.ACCESS_AUD ?? readAccessAudFromWrangler(wranglerFile);
  if (!configuredAud) {
    throw new Error('--app-id is required (or configure ACCESS_AUD in wrangler.toml for discovery)');
  }
  return discoverApplicationId({ accountId, token, aud: configuredAud, fetchImpl, timeoutMs });
}

export async function configureManagedOAuth({
  dashboard,
  accountId,
  token,
  appId,
  aud,
  apply = false,
  grantWeeks = 2,
  wranglerFile = 'wrangler.toml',
  fetchImpl = globalThis.fetch,
  timeoutMs = ACCESS_REQUEST_TIMEOUT_MS,
}) {
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
  grantDurationForWeeks(grantWeeks);
  const dashboardOrigin = normalizeDashboardOrigin(dashboard);
  const callbackUri = androidCallbackUri(dashboardOrigin);
  const resolvedAppId = await resolveApplicationId({ accountId, token, appId, aud, wranglerFile, fetchImpl, timeoutMs });
  const current = await getAccessApplication({ accountId, token, appId: resolvedAppId, fetchImpl, timeoutMs });

  if (!applicationCoversDashboard(current, dashboardOrigin)) {
    throw new Error(`Access application does not protect dashboard hostname ${new URL(dashboardOrigin).hostname}`);
  }
  const updated = buildUpdatedApplication(current, callbackUri, grantWeeks);
  const changed = JSON.stringify(updated) !== JSON.stringify(current);
  let applied = false;
  if (apply && changed) {
    await updateAccessApplication({ accountId, token, appId: resolvedAppId, application: updated, fetchImpl, timeoutMs });
    applied = true;
  }
  return { appId: resolvedAppId, dashboardOrigin, callbackUri, changed, applied, current, updated };
}

export function parseArgs(argv) {
  const options = { apply: false, appId: null, aud: null, dashboard: null, grantWeeks: 2, wranglerFile: 'wrangler.toml' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dashboard') options.dashboard = argv[++i];
    else if (arg === '--app-id') options.appId = argv[++i];
    else if (arg === '--aud') options.aud = argv[++i];
    else if (arg === '--wrangler') options.wranglerFile = argv[++i];
    else if (arg === '--grant-weeks') options.grantWeeks = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!options.help && !options.dashboard) {
    throw new Error('--dashboard is required; the redirect URI is derived from it at runtime');
  }
  grantDurationForWeeks(options.grantWeeks);
  return options;
}

function printHelp() {
  console.log('Configure Cloudflare Access Managed OAuth for Android.');
  console.log('Usage: npm run access:oauth -- --dashboard https://dashboard.example.com [--app-id ID] [--grant-weeks 1|2|3] [--apply]');
  console.log('Credentials: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID environment variables.');
  console.log('Without --apply, the command previews the GET-derived PUT and performs no mutation.');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  const result = await configureManagedOAuth({
    dashboard: options.dashboard,
    appId: options.appId,
    aud: options.aud ?? env.ACCESS_AUD,
    wranglerFile: options.wranglerFile,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN,
    apply: options.apply,
    grantWeeks: options.grantWeeks,
  });

  console.log(`Access application: ${result.appId}`);
  console.log(`Dashboard origin: ${result.dashboardOrigin}`);
  console.log(`Android redirect URI: ${result.callbackUri}`);
  const previousOauth = result.current.oauth_configuration ?? {};
  console.log(`Managed OAuth: ${previousOauth.enabled ? 'enabled' : 'disabled'} -> enabled`);
  console.log(`Dynamic client registration: ${previousOauth.dynamic_client_registration?.enabled ? 'enabled' : 'disabled'} -> enabled`);
  console.log(`Access token lifetime: ${previousOauth.grant?.access_token_lifetime ?? 'Cloudflare default'} -> ${ACCESS_TOKEN_LIFETIME}`);
  console.log(`Grant duration: ${previousOauth.grant?.session_duration ?? 'Cloudflare default'} -> ${result.updated.oauth_configuration.grant.session_duration}`);
  console.log('Existing Access policies and redirect allowances are preserved.');
  if (result.applied) console.log('Managed OAuth configuration applied.');
  else if (result.changed) console.log('Preview only; no PUT was sent. Re-run with --apply to mutate Access.');
  else console.log('Managed OAuth is already configured; no PUT was sent.');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`configure-access-oauth: ${error.message}`);
    process.exitCode = 1;
  });
}

