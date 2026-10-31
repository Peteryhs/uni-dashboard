import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { TransitStore, sqliteTransitTransaction } from '../apps/relay/src/transit-store.mjs';
import { TransitEngine, transitTarget } from '../apps/relay/src/transit.mjs';
import { importSchedule, scheduledJourneys, applyRealtime, relevantAlerts, serviceRuns } from '../apps/relay/src/transit-gtfs.mjs';
import { CommuteInput, departureTimes, leaveGuidance, serviceEpoch, transitDate, TransitView } from '#contract/transit.mjs';
import { TRANSIT_NOW as now, commuteDraft, seedTransit, transitZip } from './helpers/transit-fixture.mjs';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { createServer } from '../apps/relay/src/server.mjs';
import { buildRecommendations } from '../apps/relay/src/recommendations.mjs';
import bindings from 'gtfs-realtime-bindings';

function setup() {
  const db = new DatabaseSync(':memory:');
  const store = new TransitStore((sql, ...args) => db.prepare(sql).all(...args));
  seedTransit(store);
  return { db, store, engine: new TransitEngine(store) };
}
const event = { id: 'class', title: 'ECE 150', starts_at: Date.parse('2026-10-30T13:15:00Z'), location: 'E7 2317' };
function snapshot(store, commute, at = now) {
  const planned = scheduledJourneys(store, commute, at);
  store.put(`journey:${commute.id}`, { ...planned, generation: 'fixture', date: transitDate(at), alerts: [], alerts_at: at });
  return planned;
}

test('direct commutes use trip order and separate bus/ION identifiers', () => {
  const { engine, store } = setup();
  const commute = engine.save(commuteDraft);
  const journeys = snapshot(store, commute);
  assert.equal(journeys.departures[0].route, '13');
  assert.equal(journeys.departures[0].scheduled_arrival, serviceEpoch('2026-10-30', 8 * 3600 + 25 * 60));
  assert.throws(() => engine.save({ ...commuteDraft, destination: 'ion:2' }));
  assert.throws(() => engine.save({ ...commuteDraft, destination: 'bus:3' }), /no direct trip/);
  assert.throws(() => engine.save({ ...commuteDraft, route: '999' }), /no direct trip/);
  const rail = engine.save({ ...commuteDraft, origin: 'ion:1', destination: 'ion:2' });
  assert.notEqual(rail.id, commute.id);
  assert.ok(engine.stops('res').some(s => s.id === 'bus:1'));
  assert.ok(engine.stops('res').some(s => s.id === 'ion:1'));
  assert.ok(!engine.stops('camp', 'bus:1').some(s => s.mode === 'ion'));
});

test('commute inputs enforce buffers, limits and valid selected stops', () => {
  const { engine } = setup();
  assert.equal(CommuteInput.parse({ name: 'Campus', origin: 'bus:1', destination: 'bus:2' }).walk_to_minutes, 5);
  assert.throws(() => engine.save({ ...commuteDraft, walk_to_minutes: 121 }));
  assert.throws(() => engine.save({ ...commuteDraft, origin: 'bus:1', destination: 'bus:1' }));
  for (let i = 0; i < 6; i++) engine.save({ ...commuteDraft, name: `Trip ${i}` });
  assert.throws(() => engine.save(commuteDraft), /six commutes/);
  const first = engine.commutes()[0];
  assert.equal(engine.save({ ...first, name: 'Updated' }, first.id).id, first.id);
  engine.remove(first.id); assert.equal(engine.commutes().length, 5);
});

test('service exceptions, previous service days and GTFS daylight-saving semantics', () => {
  const { engine, store } = setup(); const c = engine.save(commuteDraft);
  assert.equal(serviceRuns({ start: '20260101', end: '20261231', days: Array(7).fill(true), exceptions: { '20261031': false } }, '2026-10-31'), false);
  const overnight = scheduledJourneys(store, c, Date.parse('2026-10-31T04:30:00Z'));
  assert.ok(overnight.departures.some(d => d.id.includes('NIGHT:2026-10-30') && d.scheduled_departure === Date.parse('2026-10-31T05:00:00Z')));
  assert.equal(new Date(serviceEpoch('2026-03-08', 3 * 3600)).toISOString(), '2026-03-08T07:00:00.000Z');
  assert.equal(new Date(serviceEpoch('2026-11-01', 3 * 3600)).toISOString(), '2026-11-01T08:00:00.000Z');
});

test('realtime respects stop sequences, service date, cancellations and stale timestamps', () => {
  const { engine, store } = setup(); const c = engine.save(commuteDraft);
  const departures = scheduledJourneys(store, c, now).departures;
  const fresh = { header: { timestamp: now / 1000 }, entity: [{ tripUpdate: { trip: { tripId: 'T1', startDate: '20261030' }, stopTimeUpdate: [{ stopSequence: 1, departure: { delay: 180 } }, { stopSequence: 2, arrival: { delay: 240 } }] } }] };
  const live = applyRealtime(departures, fresh, now)[0];
  assert.equal(live.predicted_departure, departures[0].scheduled_departure + 180000);
  assert.equal(live.predicted_arrival, departures[0].scheduled_arrival + 240000);
  assert.equal(departureTimes(live, now + 90001).predicted, false);
  assert.equal(departureTimes(live, now, true).departure, live.scheduled_departure);
  assert.equal(applyRealtime(departures, fresh, now + 90001)[0].predicted_departure, null);
  fresh.entity[0].tripUpdate.trip.scheduleRelationship = 3;
  assert.equal(applyRealtime(departures, fresh, now)[0].cancelled, true);
  delete fresh.entity[0].tripUpdate.trip.scheduleRelationship;
  fresh.entity[0].tripUpdate.stopTimeUpdate[0].scheduleRelationship = 1;
  assert.equal(applyRealtime(departures, fresh, now)[0].cancelled, true);
  fresh.entity[0].tripUpdate.trip.startDate = '20261029';
  assert.equal(applyRealtime(departures, fresh, now)[0].cancelled, false);
});

test('leave guidance selects the latest boardable arrival and activation expires across clients', () => {
  const { engine, store } = setup(); const c = engine.save(commuteDraft); const planned = snapshot(store, c);
  engine.activate(c.id, event, now);
  const view = engine.view({ now, target: event, events: [event] });
  assert.equal(view.guidance.departure.scheduled_departure, serviceEpoch('2026-10-30', 8 * 3600 + 30 * 60));
  assert.equal(view.guidance.leave_at, serviceEpoch('2026-10-30', 8 * 3600 + 25 * 60));
  assert.equal(TransitView.parse(view).guidance.basis, 'scheduled');
  assert.equal(new TransitEngine(store).view({ now, events: [event] }).activation.commute_id, c.id);
  assert.equal(engine.view({ now: event.starts_at + 1, events: [] }).guidance, null);
  const next = { ...event, id: 'next-class', starts_at: event.starts_at + 3_600_000 };
  assert.equal(engine.view({ now: event.starts_at + 1, events: [next], target: next }).target.id, next.id);
  assert.equal(engine.view({ now: now + 86400000, events: [event] }).activation, null);
  assert.equal(leaveGuidance(c, planned.departures, { ...event, starts_at: now + 60000 }, now).basis, 'unavailable');
  engine.cancel(); assert.equal(engine.view({ now, events: [event] }).guidance, null);
});

test('target excludes stale, online, cancelled, replaced and non-class entries', () => {
  const base = { ...event, category: 'class', state: 'live', all_day: false, attendance: 'scheduled' };
  const calendar = { days: [{ events: [base] }], alerts: [] };
  assert.equal(transitTarget(calendar, now).id, event.id);
  for (const change of [{ all_day: true }, { state: 'stale' }, { location: 'Online Zoom' }, { attendance: 'replaced' }, { category: 'deadline' }]) assert.equal(transitTarget({ ...calendar, days: [{ events: [{ ...base, ...change }] }] }, now), null);
  assert.equal(transitTarget({ ...calendar, alerts: [{ kind: 'cancelled', event_id: event.id }] }, now), null);
});

test('alerts match all supplied selectors and active time range', () => {
  const departures = [{ route_id: 'R', trip_id: 'T1' }];
  const alert = { headerText: { translation: [{ language: 'en', text: 'Detour' }] }, informedEntity: [{ routeId: 'R', stopId: '1' }] };
  assert.deepEqual(relevantAlerts({ entity: [{ alert }] }, commuteDraft, departures, now), ['Detour']);
  assert.deepEqual(relevantAlerts({ entity: [{ alert: { ...alert, informedEntity: [{ routeId: 'R', stopId: '999' }] } }] }, commuteDraft, departures, now), []);
  assert.deepEqual(relevantAlerts({ entity: [{ alert: { ...alert, activePeriod: [{ end: now / 1000 - 1 }] } }] }, commuteDraft, departures, now), []);
});

test('invalid imports cannot replace the selected generation and reads make no upstream calls', async () => {
  const { engine, store } = setup();
  assert.throws(() => importSchedule(store, transitZip({ 'stop_times.txt': null }), 'bus', 'bad'), /Missing stop_times/);
  assert.equal(store.get('feed:bus').generation, 'fixture');
  const original = globalThis.fetch; globalThis.fetch = () => { throw new Error('Unexpected network read'); };
  try { engine.stops('cam'); engine.view({ now }); engine.commutes(); } finally { globalThis.fetch = original; }
});

test('local timetable batches roll back staged writes when an import cannot finish', () => {
  const db = new DatabaseSync(':memory:');
  const store = new TransitStore((sql, ...args) => db.prepare(sql).all(...args), work => sqliteTransitTransaction(db, work));
  store.put('selected', 'old-generation');
  assert.throws(() => store.batch(() => { store.put('staged:1', ['a']); store.put('selected', 'new-generation'); throw new Error('import failed'); }), /import failed/);
  assert.equal(store.get('selected'), 'old-generation');
  assert.equal(store.get('staged:1'), null);
  db.close();
});

test('transit failure does not break recommendations or add calendar queries', async () => {
  const store = new SqliteStore(':memory:');
  const result = await buildRecommendations(store, { now, transit: { view() { throw new Error('offline'); } } });
  assert.equal(result.transit, null); assert.ok(Array.isArray(result.items)); store.close();
});

test('failed bus predictions and alerts preserve scheduled trips and allow ION updates', async () => {
  const { engine, store } = setup();
  const bus = engine.save(commuteDraft), rail = engine.save({ ...commuteDraft, origin: 'ion:1', destination: 'ion:2', name: 'ION' });
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).endsWith('/tripupdates/1') || String(url).endsWith('/alerts')) return new Response('unavailable', { status: 503 });
    const bytes = bindings.transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: now / 1000 }, entity: [] }).finish();
    return new Response(bytes);
  };
  try {
    await engine.tick(now);
    const view = engine.view({ now });
    assert.ok(view.journeys.find(j => j.commute_id === bus.id).departures.length);
    assert.ok(view.journeys.find(j => j.commute_id === rail.id).departures.length);
    assert.ok(calls.some(url => url.endsWith('/tripupdates/2')));
    assert.match(view.error, /503/);
    const busCalls = calls.filter(url => url.endsWith('/tripupdates/1')).length;
    await engine.tick(now + 30_000);
    assert.equal(calls.filter(url => url.endsWith('/tripupdates/1')).length, busCalls, 'provider backoff must prevent another fetch');
  } finally { globalThis.fetch = original; }
});

test('transit HTTP routes preserve local bearer and origin protections', async t => {
  const store = new SqliteStore(':memory:');
  const transitStore = new TransitStore((sql, ...args) => store.db.prepare(sql).all(...args)); seedTransit(transitStore);
  const { server } = createServer({ store, sources: [], token: 'test-token', serveWeb: false, automaticPolling: false, log() {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/v1/transit/commutes`)).status, 401);
  assert.equal((await fetch(`${base}/v1/transit/commutes`, { method: 'POST', headers: { authorization: 'Bearer test-token', origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify(commuteDraft) })).status, 403);
  const result = await fetch(`${base}/v1/transit/commutes`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify(commuteDraft) });
  assert.equal(result.status, 201);
  const list = await (await fetch(`${base}/v1/transit/commutes`, { headers: { authorization: 'Bearer test-token' } })).json();
  assert.equal(list.commutes[0].name, 'To campus');
});
