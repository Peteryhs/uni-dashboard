import { unzipSync } from 'fflate';
import { parse } from 'csv-parse/sync';
import bindings from 'gtfs-realtime-bindings';
import { serviceEpoch, transitDate } from '#contract/transit.mjs';

export const FEEDS = { bus: 1, ion: 2 };
export const GRT_BASE = 'https://webapps.regionofwaterloo.ca/api/grt-routes/api';
const FILES = ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt'];
const MAX_CHUNK = 400_000;
const MIN = 60_000;

function rows(files, name, each) {
  if (!files[name]) return;
  parse(new TextDecoder().decode(files[name]), { bom: true, columns: true, skip_empty_lines: true, on_record(record) { each(record); return null; } });
}
function seconds(value) {
  if (!/^\d{1,3}:\d{2}:\d{2}$/.test(value)) throw new Error('Invalid GTFS time');
  const [h, m, s] = value.split(':').map(Number);
  if (m > 59 || s > 59) throw new Error('Invalid GTFS time');
  return h * 3600 + m * 60 + s;
}

/** Parse only required ZIP members. on_record avoids retaining a second copy of every CSV row. */
export function importSchedule(store, bytes, mode, generation) {
  let expandedBytes = 0;
  const files = unzipSync(bytes, { filter: file => {
    if (!FILES.includes(file.name)) return false;
    expandedBytes += file.originalSize;
    if (expandedBytes > 16_000_000) throw new Error('Expanded timetable exceeds the import limit');
    return true;
  } });
  for (const required of ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt']) if (!files[required]) throw new Error(`Missing ${required}`);
  if (!files['calendar.txt'] && !files['calendar_dates.txt']) throw new Error('Missing service dates');
  const prefix = `gtfs:${mode}:${generation}:`;
  const stops = {}, routes = {}, trips = {}, services = {}, byStop = new Map();
  rows(files, 'stops.txt', r => { if (r.stop_id && r.stop_name) stops[r.stop_id] = { id: `${mode}:${r.stop_id}`, name: r.stop_name, code: r.stop_code || r.stop_id, mode }; });
  rows(files, 'routes.txt', r => { routes[r.route_id] = r.route_short_name || r.route_long_name || r.route_id; });
  rows(files, 'trips.txt', r => { trips[r.trip_id] = [r.route_id, r.service_id, r.trip_headsign || '', r.direction_id || '']; });
  rows(files, 'calendar.txt', r => { services[r.service_id] = { start: r.start_date, end: r.end_date, days: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(d => r[d] === '1'), exceptions: {} }; });
  rows(files, 'calendar_dates.txt', r => { const service = services[r.service_id] ??= { exceptions: {} }; service.exceptions[r.date] = r.exception_type === '1'; });
  let count = 0;
  rows(files, 'stop_times.txt', r => {
    if (!trips[r.trip_id] || !stops[r.stop_id]) throw new Error('GTFS stop time references missing metadata');
    if (!r.arrival_time || !r.departure_time) return; // Untimed intermediate stops cannot supply a departure.
    const entry = [r.trip_id, Number(r.stop_sequence), seconds(r.arrival_time), seconds(r.departure_time), Number(r.pickup_type || 0), Number(r.drop_off_type || 0)];
    if (!Number.isFinite(entry[1])) throw new Error('Invalid stop sequence');
    if (!byStop.has(r.stop_id)) byStop.set(r.stop_id, []);
    byStop.get(r.stop_id).push(entry); count++;
  });
  if (!count || !Object.keys(services).length || !Object.keys(stops).length) throw new Error('Empty timetable');
  let chunks = 0;
  for (const [stop, entries] of byStop) {
    const batches = []; let batch = [], size = 0;
    for (const row of entries) { const n = JSON.stringify(row).length + 1; if (size + n > MAX_CHUNK && batch.length) { batches.push(batch); batch = []; size = 0; } batch.push(row); size += n; }
    if (batch.length) batches.push(batch);
    batches.forEach((part, i) => { store.put(`${prefix}stop:${stop}:${i}`, part); chunks++; });
    store.put(`${prefix}parts:${stop}`, batches.length);
  }
  // Metadata is sharded too: no object can exceed SQLite's per-row limit.
  const tripRoutes = {};
  for (const [id, trip] of Object.entries(trips)) { (tripRoutes[trip[0]] ??= {})[id] = trip; }
  for (const [route, values] of Object.entries(tripRoutes)) store.put(`${prefix}trips:${route}`, values);
  // Stop rows include route IDs so a read loads only the route metadata relevant to that stop.
  const stopRoutes = {};
  for (const [stop, entries] of byStop) { stopRoutes[stop] = [...new Set(entries.map(r => trips[r[0]][0]))]; store.put(`${prefix}routes:${stop}`, stopRoutes[stop]); }
  store.put(`${prefix}stop-routes`, stopRoutes);
  store.put(`${prefix}stops`, stops); store.put(`${prefix}routes`, routes); store.put(`${prefix}services`, services);
  return { generation, count, stops: Object.keys(stops).length, chunks };
}

export function stopData(store, mode, generation, stop, withTrips = true) {
  const prefix = `gtfs:${mode}:${generation}:`;
  const count = store.get(`${prefix}parts:${stop}`) || 0;
  const entries = [];
  for (let i = 0; i < count; i++) entries.push(...store.get(`${prefix}stop:${stop}:${i}`));
  const trips = {};
  if (withTrips) for (const route of store.get(`${prefix}routes:${stop}`) || []) Object.assign(trips, store.get(`${prefix}trips:${route}`));
  return { entries, trips };
}

export function serviceRuns(service, date) {
  if (!service) return false;
  const key = date.replaceAll('-', '');
  if (Object.hasOwn(service.exceptions || {}, key)) return service.exceptions[key];
  return key >= service.start && key <= service.end && Boolean(service.days?.[new Date(`${date}T12:00:00Z`).getUTCDay()]);
}

/** Both stops must occur on the same trip, in boarding order, with allowed pickup/drop-off. */
export function scheduledJourneys(store, commute, now) {
  const [mode, origin] = commute.origin.split(':'), destination = commute.destination.split(':')[1];
  const meta = store.get(`feed:${mode}`);
  if (!meta?.generation) return { departures: [], schedule_valid: false };
  const prefix = `gtfs:${mode}:${meta.generation}:`;
  const services = store.get(`${prefix}services`), routes = store.get(`${prefix}routes`);
  const from = stopData(store, mode, meta.generation, origin), to = stopData(store, mode, meta.generation, destination);
  const destinationTrips = new Map();
  for (const row of to.entries) { if (!destinationTrips.has(row[0])) destinationTrips.set(row[0], []); destinationTrips.get(row[0]).push(row); }
  const today = transitDate(now);
  const dates = [-1, 0, 1].map(offset => new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10));
  const departures = [];
  for (const date of dates) for (const row of from.entries) {
    const trip = from.trips[row[0]];
    if (row[4] !== 0 || !trip || !serviceRuns(services[trip[1]], date) || (commute.route && commute.route !== routes[trip[0]])) continue;
    const dest = destinationTrips.get(row[0])?.filter(d => d[1] > row[1] && d[5] === 0).sort((a, b) => a[1] - b[1])[0];
    if (!dest) continue;
    const departure = serviceEpoch(date, row[3]), arrival = serviceEpoch(date, dest[2]);
    if (departure < now - 90 * MIN || departure > now + 24 * 60 * MIN || arrival < departure) continue;
    departures.push({ id: `${mode}:${row[0]}:${date}:${row[1]}`, route: routes[trip[0]], headsign: trip[2], scheduled_departure: departure, scheduled_arrival: arrival,
      predicted_departure: null, predicted_arrival: null, prediction_at: null, cancelled: false,
      trip_id: row[0], route_id: trip[0], service_date: date, origin_sequence: row[1], destination_sequence: dest[1] });
  }
  const scheduleValid = Object.values(services).some(s => serviceRuns(s, today));
  return { departures: departures.sort((a, b) => a.scheduled_departure - b.scheduled_departure), schedule_valid: scheduleValid };
}

export function decodeRealtime(bytes) { return bindings.transit_realtime.FeedMessage.decode(bytes); }
function stamp(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n * 1000 : null; }
function eventTime(event, scheduled) { return event && Object.hasOwn(event, 'time') ? stamp(event.time) : event && Object.hasOwn(event, 'delay') ? scheduled + Number(event.delay) * 1000 : null; }

export function applyRealtime(departures, feed, now) {
  const headerAt = stamp(feed.header?.timestamp);
  const updates = new Map();
  for (const entity of feed.entity || []) if (entity.tripUpdate) { const u = entity.tripUpdate; const key = u.trip?.tripId; if (key) { if (!updates.has(key)) updates.set(key, []); updates.get(key).push(u); } }
  return departures.map(departure => {
    const u = updates.get(departure.trip_id)?.find(u => u.trip.startDate ? u.trip.startDate === departure.service_date.replaceAll('-', '') : departure.service_date === transitDate(now));
    if (!u) return departure;
    const at = stamp(u.timestamp) ?? headerAt;
    if (!at || now < at || now - at > 90_000 || !headerAt || now - headerAt > 90_000) return departure;
    const stops = u.stopTimeUpdate || [];
    const from = stops.find(s => s.stopSequence === departure.origin_sequence), to = stops.find(s => s.stopSequence === departure.destination_sequence);
    if (u.trip.scheduleRelationship === 3 || from?.scheduleRelationship === 1 || to?.scheduleRelationship === 1) return { ...departure, cancelled: true, prediction_at: at };
    const noData = from?.scheduleRelationship === 2;
    return { ...departure, prediction_at: at,
      predicted_departure: noData ? null : eventTime(from?.departure ?? from?.arrival, departure.scheduled_departure),
      predicted_arrival: to?.scheduleRelationship === 2 ? null : eventTime(to?.arrival ?? to?.departure, departure.scheduled_arrival) };
  });
}

export function relevantAlerts(feed, commute, departures, now) {
  const routes = new Set(departures.map(d => d.route_id));
  const trips = new Set(departures.map(d => d.trip_id));
  const stops = new Set([commute.origin.split(':')[1], commute.destination.split(':')[1]]);
  return [...new Set((feed.entity || []).flatMap(entity => {
    const a = entity.alert;
    if (!a || (a.activePeriod?.length && !a.activePeriod.some(p => (!p.start || Number(p.start) * 1000 <= now) && (!p.end || Number(p.end) * 1000 > now)))) return [];
    if (a.informedEntity?.length && !a.informedEntity.some(e => (!e.routeId || routes.has(e.routeId)) && (!e.stopId || stops.has(e.stopId)) && (!e.trip?.tripId || trips.has(e.trip.tripId)))) return [];
    const translations = a.headerText?.translation || [];
    const text = translations.find(t => !t.language || t.language.startsWith('en'))?.text || translations[0]?.text;
    return text ? [text.slice(0, 1000)] : [];
  }))].slice(0, 8);
}
