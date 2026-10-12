import { AsyncLocalStorage } from 'node:async_hooks';

const runtimeEnv = new AsyncLocalStorage();
const ENV_KEYS = new Set([
  'PORTAL_ICS_URL',
  'GOOGLE_CALENDAR_ICS_URL',
  'LEARN_ICS_URL',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
]);

/**
 * Build the immutable environment view used by one Worker invocation. Explicit settings saved in
 * D1 take precedence over deployment bindings, and per-request overrides can deliberately mask a
 * binding when a credential is cleared during that invocation.
 */
export function createRuntimeEnv(bindings = {}, settings = [], overrides = new Map()) {
  const values = Object.create(null);
  for (const key of ENV_KEYS) {
    const value = bindings?.[key];
    if (typeof value === 'string' && value) values[key] = value;
  }
  for (const row of settings) {
    if (ENV_KEYS.has(row?.name) && typeof row.value === 'string' && row.value) values[row.name] = row.value;
  }
  for (const [key, value] of overrides) {
    if (ENV_KEYS.has(key)) values[key] = typeof value === 'string' ? value : '';
  }
  return Object.freeze(values);
}

/** Read the invocation-scoped Worker value, or the ordinary Node environment outside a Worker. */
export function getRuntimeEnv(key) {
  const scoped = runtimeEnv.getStore();
  if (scoped) return scoped[key] || '';
  return process.env[key] || '';
}

/** Run async work with the same immutable configuration snapshot across awaited operations. */
export function withRuntimeEnv(values, callback) {
  return runtimeEnv.run(values, callback);
}
