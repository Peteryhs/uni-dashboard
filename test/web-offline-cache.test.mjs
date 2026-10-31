import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ entryPoints: [new URL('../apps/web/src/lib/offline-cache.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], bundle: true, format: 'esm', platform: 'node', write: false });
const { savedRead, saveRead } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
function storage() {
  const values = {};
  globalThis.localStorage = {
    getItem: key => values[key] ?? null,
    setItem: (key, value) => { values[key] = value; globalThis.localStorage[key] = value; },
    removeItem: key => { delete values[key]; delete globalThis.localStorage[key]; },
  };
  return globalThis.localStorage;
}
const menu = { requested_date: '2026-10-30', service_date: '2026-10-30', status: 'today', observed_at: 1793400000000, state: 'live', items: [{ outlet: 'Test outlet', station: 'Test station', dish: 'Soup', diet: [], allergens: [], url: 'https://uwaterloo.ca/food-services/daily-menu' }] };
const key = path => `uni-dashboard:saved-read:v1:${path}`;

test('offline reads validate saved data and mark menu observations as saved', () => {
  storage(); saveRead('/v1/menu', menu);
  const cached = savedRead('/v1/menu');
  assert.equal(cached.state, 'stale'); assert.equal(cached.observed_at, menu.observed_at);
  assert.equal(cached.items[0].dish, 'Soup');
  globalThis.localStorage.setItem(key('/v1/menu'), '{bad JSON');
  assert.equal(savedRead('/v1/menu'), undefined);
});

test('API credentials, token responses and HTML are never eligible for the offline read cache', () => {
  const store = storage();
  saveRead('/v1/credentials', { private_url: 'https://example.invalid/private-token' });
  saveRead('/v1/mcp-tokens', { token: 'one-time-key' });
  saveRead('/v1/menu', '<html>Sign in</html>');
  assert.equal(store.getItem(key('/v1/credentials')), null);
  assert.equal(store.getItem(key('/v1/mcp-tokens')), null);
  assert.equal(savedRead('/v1/menu'), undefined);
});

test('offline read cache is bounded and rejects future timestamps or unavailable storage', () => {
  const store = storage();
  for (let i = 0; i < 45; i++) saveRead(`/v1/menu?date=${i}`, menu);
  assert.equal(Object.keys(store).filter(k => k.startsWith('uni-dashboard:')).length, 40);
  store.setItem(key('/v1/menu'), JSON.stringify({ at: Date.now() + 3600000, value: menu }));
  assert.equal(savedRead('/v1/menu'), undefined);
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } };
  assert.doesNotThrow(() => saveRead('/v1/menu', menu));
  assert.equal(savedRead('/v1/menu'), undefined);
});
