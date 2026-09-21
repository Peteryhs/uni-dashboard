import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as food from '../sources/food/source.mjs';
import { portalIcs } from '../sources/ics/source.mjs';
import * as status from '../sources/status/source.mjs';
import { hourlyForecast } from '../apps/relay/src/weather.mjs';

/**
 * Every outbound fetch must be bounded. An unbounded fetch that hangs holds the runner's poll
 * loop open behind its `polling` guard, so one stuck socket stops every source until a restart.
 * This test stubs fetch and checks the init each source actually passes.
 */
test('every source fetch carries a timeout signal', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  const realPortalUrl = process.env.PORTAL_ICS_URL;
  process.env.PORTAL_ICS_URL = 'https://example.test/portal.ics';
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{}',
      json: async () => ({ hourly: { time: [] }, timezone: 'America/Toronto' }),
    };
  };
  try {
    await food.fetchRaw({ now: Date.UTC(2026, 8, 21, 12) });
    await portalIcs.fetchRaw({ now: Date.UTC(2026, 8, 21, 12) });
    await status.fetchRaw({});
    await hourlyForecast(Date.now(), { force: true });
  } finally {
    globalThis.fetch = realFetch;
    if (realPortalUrl === undefined) delete process.env.PORTAL_ICS_URL;
    else process.env.PORTAL_ICS_URL = realPortalUrl;
  }

  assert.equal(calls.length, 4, `expected 4 fetches, saw ${calls.length}`);
  for (const call of calls) {
    assert.ok(call.init.signal instanceof AbortSignal, `${call.url} was fetched without a timeout`);
  }
});
