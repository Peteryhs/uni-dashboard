import { zipSync, strToU8 } from 'fflate';
import { importSchedule } from '../../apps/relay/src/transit-gtfs.mjs';

export const TRANSIT_NOW = Date.parse('2026-10-30T11:50:00Z');
export function transitZip(overrides = {}) {
  const csv = {
    'stops.txt': 'stop_id,stop_code,stop_name\n1,100,Residence\n2,200,Campus\n3,300,Other\n',
    'routes.txt': 'route_id,route_short_name\nR,13\n',
    'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id\nR,S,T1,Campus,0\nR,S,T2,Campus,0\nR,S,T3,Residence,1\nR,S,NIGHT,Campus,0\n',
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20261231\n',
    'calendar_dates.txt': 'service_id,date,exception_type\nS,20261031,2\n',
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nT1,08:10:00,08:10:00,1,1,0,0\nT1,08:25:00,08:25:00,2,2,0,0\nT2,08:30:00,08:30:00,1,1,0,0\nT2,08:45:00,08:45:00,2,2,0,0\nT3,08:20:00,08:20:00,2,1,0,0\nT3,08:35:00,08:35:00,1,2,0,0\nNIGHT,25:00:00,25:00:00,1,1,0,0\nNIGHT,25:15:00,25:15:00,2,2,0,0\n',
    ...overrides,
  };
  return zipSync(Object.fromEntries(Object.entries(csv).filter(([, text]) => text != null).map(([name, text]) => [name, strToU8(text)])));
}
export function seedTransit(store, now = TRANSIT_NOW, bytes = transitZip()) {
  for (const mode of ['bus', 'ion']) {
    const meta = importSchedule(store, bytes, mode, 'fixture');
    store.put(`feed:${mode}`, { ...meta, checked_at: now });
  }
}
export const commuteDraft = { name: 'To campus', origin: 'bus:1', destination: 'bus:2', route: '', walk_to_minutes: 5, walk_from_minutes: 5, arrival_buffer_minutes: 10 };
