/** Synthetic local server for browser verification. Never opens the owner's relay.db or polls feeds. */
import { SqliteStore } from '../../apps/relay/src/store.mjs';
import { createServer } from '../../apps/relay/src/server.mjs';
import { TransitStore } from '../../apps/relay/src/transit-store.mjs';
import { TransitEngine } from '../../apps/relay/src/transit.mjs';
import { scheduledJourneys } from '../../apps/relay/src/transit-gtfs.mjs';
import { serviceEpoch, transitDate } from '#contract/transit.mjs';
import { seedTransit, commuteDraft, transitZip } from './transit-fixture.mjs';

const now = Date.now(), date = transitDate(now), start = serviceEpoch(date, 0);
const secs = Math.floor((now - start) / 1000);
const time = seconds => [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
let stopTimes = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n';
for (const [i, trip] of ['T1', 'T2'].entries()) {
  const departure = secs + (20 + i * 20) * 60, arrival = departure + 15 * 60;
  stopTimes += `${trip},${time(departure)},${time(departure)},1,1,0,0\n${trip},${time(arrival)},${time(arrival)},2,2,0,0\n`;
}
const store = new SqliteStore(':memory:');
const transitStore = new TransitStore((sql, ...args) => store.db.prepare(sql).all(...args));
seedTransit(transitStore, now, transitZip({ 'stop_times.txt': stopTimes, 'calendar_dates.txt': 'service_id,date,exception_type\n' }));
const engine = new TransitEngine(transitStore), commute = engine.save(commuteDraft);
const planned = scheduledJourneys(transitStore, commute, now);
transitStore.put(`journey:${commute.id}`, { ...planned, generation: 'fixture', date, alerts: [], alerts_at: now });
transitStore.put('status', { updated_at: now, error: null });
store.upsertRows('timeline_event', [{ source_id: 'uw-portal-ics', external_id: 'preview-class', kind: 'class', title: 'ECE 150 LEC 001', location: 'E7 2317', starts_at: now + 100 * 60_000, ends_at: now + 160 * 60_000, observed_at: now, valid_until: now + 6 * 3_600_000, all_day: false }]);
store.insertRun({ source_id: 'uw-portal-ics', started_at: now, finished_at: now, outcome: 'ok' });
const { server } = createServer({ store, sources: [], token: '', automaticPolling: false, log() {} });
let expired = false, navigations = 0;
const relay = server.listeners('request')[0]; server.removeAllListeners('request');
server.on('request', (req, res) => {
  if (req.url === '/__test/expire') { expired = true; res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/__test/reset') { expired = false; res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/__test/state') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ navigations })); return; }
  if (req.url === '/') { navigations++; if (expired) { res.writeHead(302, { location: '/cdn-cgi/access/login' }); res.end(); return; } }
  if (req.url === '/cdn-cgi/access/login') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><body>Test sign-in page</body></html>'); return; }
  if (expired && req.url.startsWith('/v1/')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"sign in required"}'); return; }
  return relay(req, res);
});
server.listen(Number(process.env.PREVIEW_PORT || 8799), '127.0.0.1', () => console.log(`Synthetic preview ready at http://127.0.0.1:${server.address().port}`));
