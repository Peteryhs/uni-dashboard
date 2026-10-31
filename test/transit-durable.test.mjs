import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import bindings from 'gtfs-realtime-bindings';
import { transitZip, TRANSIT_NOW } from './helpers/transit-fixture.mjs';

test('SQLite Durable Object serves cached transit, schedules alarms and survives runtime restart', { timeout: 45000 }, async () => {
  const root = resolve(import.meta.dirname, '..');
  const compiled = await build({ stdin: { resolveDir: root, contents: `
    import { TransitCoordinator } from './apps/relay/src/transit-coordinator.mjs';
    import { importSchedule, scheduledJourneys } from './apps/relay/src/transit-gtfs.mjs';
    import { transitZip, commuteDraft, TRANSIT_NOW } from './test/helpers/transit-fixture.mjs';
    export class TestTransit extends TransitCoordinator {
      seed() {
        for (const mode of ['bus','ion']) {
          const meta = importSchedule(this.engine.store, transitZip(), mode, 'fixture');
          this.engine.store.put('feed:'+mode, {...meta, checked_at: TRANSIT_NOW});
        }
        const c = this.engine.save(commuteDraft);
        return c;
      }
      async update() { await this.engine.tick(TRANSIT_NOW); return this.engine.view({now:TRANSIT_NOW}); }
      alarmTime() { return this.ctx.storage.getAlarm(); }
    }
    export default { async fetch(request, env) {
      const stub = env.TRANSIT.get(env.TRANSIT.idFromName('test'));
      const path = new URL(request.url).pathname;
      const value = path === '/seed' ? await stub.seed() : path === '/update' ? await stub.update()
        : path === '/alarm' ? (await stub.ensureAlarm(), await stub.alarmTime())
        : await stub.view({now:${TRANSIT_NOW}});
      return Response.json(value);
    }};
  ` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], conditions: ['workerd', 'worker', 'browser'] });
  const directory = await mkdtemp(join(tmpdir(), 'transit-do-'));
  let network = 0;
  const options = { name: 'transit-regression', modules: true, script: compiled.outputFiles[0].text, compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'], durableObjects: { TRANSIT: { className: 'TestTransit', useSQLite: true } },
    outboundService(request) {
      network++;
      const path = new URL(request.url).pathname;
      if (path.includes('staticfeeds')) return new Response(transitZip());
      const bytes = bindings.transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: TRANSIT_NOW / 1000 }, entity: [] }).finish();
      return new Response(bytes, { headers: { 'content-type': 'application/x-google-protobuf' } });
    } };
  let runtime;
  try {
    runtime = new Miniflare({ ...convertV4MiniflareOptions(options), resourcePersistencePath: directory });
    const commute = await (await runtime.dispatchFetch('https://test/seed')).json();
    const view = await (await runtime.dispatchFetch('https://test/update')).json();
    assert.equal(view.journeys[0].departures[0].route, '13');
    const fetched = network;
    assert.equal((await (await runtime.dispatchFetch('https://test/view')).json()).commutes[0].id, commute.id);
    assert.equal(network, fetched, 'ordinary reads must never fetch GRT');
    const alarm = await (await runtime.dispatchFetch('https://test/alarm')).json();
    assert.ok(alarm > Date.now() - 1000);
    await runtime.dispose(); runtime = new Miniflare({ ...convertV4MiniflareOptions(options), resourcePersistencePath: directory });
    const restored = await (await runtime.dispatchFetch('https://test/view')).json();
    assert.equal(restored.commutes[0].id, commute.id);
    assert.equal(restored.journeys[0].departures[0].route, '13');
  } finally { if (runtime) await runtime.dispose(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/')); await rm(directory, { recursive: true, force: true }); }
});
