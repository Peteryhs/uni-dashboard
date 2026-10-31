import { z } from 'zod';

export const TRANSIT_ZONE = 'America/Toronto';
export const PREDICTION_MAX_AGE_MS = 90_000;
// routes: short names serving the stop (for a destination search, only routes direct from the origin).
// hint: why a stop matched when its name does not show it, such as "Near E7 · Engineering 7".
export const TransitStop = z.object({ id: z.string(), name: z.string(), code: z.string(), mode: z.enum(['bus', 'ion']),
  routes: z.array(z.string()).default([]), hint: z.string().nullable().default(null) });
export const CommuteInput = z.object({
  name: z.string().trim().min(1).max(80),
  origin: z.string().regex(/^(bus|ion):[^\s:]{1,100}$/),
  destination: z.string().regex(/^(bus|ion):[^\s:]{1,100}$/),
  route: z.string().trim().max(40).default(''),
  walk_to_minutes: z.number().int().min(0).max(120).default(5),
  walk_from_minutes: z.number().int().min(0).max(120).default(5),
  arrival_buffer_minutes: z.number().int().min(0).max(120).default(10),
}).refine(v => v.origin !== v.destination && v.origin.split(':')[0] === v.destination.split(':')[0], 'Choose different stops on the same bus or ION network.');
export const Commute = CommuteInput.safeExtend({ id: z.string(), origin_name: z.string(), destination_name: z.string() });
export const Departure = z.object({
  id: z.string(), route: z.string(), headsign: z.string(),
  scheduled_departure: z.number(), scheduled_arrival: z.number(),
  predicted_departure: z.number().nullable(), predicted_arrival: z.number().nullable(),
  prediction_at: z.number().nullable(), cancelled: z.boolean().default(false),
});
export const TransitView = z.object({
  generated_at: z.number(), status: z.enum(['initializing', 'ready', 'failed', 'unconfigured']),
  error: z.string().nullable(), updated_at: z.number().nullable(),
  commutes: z.array(Commute),
  journeys: z.array(z.object({ commute_id: z.string(), departures: z.array(Departure), alerts: z.array(z.string()), schedule_valid: z.boolean() })),
  activation: z.object({ commute_id: z.string(), event_id: z.string(), date: z.string() }).nullable(),
  target: z.object({ id: z.string(), title: z.string(), starts_at: z.number(), location: z.string() }).nullable(),
  guidance: z.object({ commute_id: z.string(), event_title: z.string(), leave_at: z.number().nullable(), departure: Departure.nullable(), basis: z.enum(['predicted', 'scheduled', 'unavailable']), message: z.string(), expires_at: z.number() }).nullable(),
});

const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TRANSIT_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const noonFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: TRANSIT_ZONE, hour: '2-digit', hourCycle: 'h23' });
const serviceStarts = new Map();
export const transitDate = at => formatter.format(new Date(at));

// GTFS service time is measured from noon minus twelve elapsed hours, including DST days.
export function serviceEpoch(date, seconds) {
  if (serviceStarts.has(date)) return serviceStarts.get(date) + seconds * 1000;
  const nominalNoon = Date.parse(`${date}T12:00:00Z`);
  const hour = Number(noonFormatter.format(nominalNoon));
  const start = nominalNoon + (12 - hour) * 3_600_000 - 12 * 3_600_000;
  if (serviceStarts.size >= 16) serviceStarts.delete(serviceStarts.keys().next().value);
  serviceStarts.set(date, start);
  return start + seconds * 1000;
}

export function departureTimes(departure, now, offline = false) {
  const live = !offline && departure.prediction_at != null && now >= departure.prediction_at && now - departure.prediction_at <= PREDICTION_MAX_AGE_MS;
  return { departure: live && departure.predicted_departure != null ? departure.predicted_departure : departure.scheduled_departure,
    arrival: live && departure.predicted_arrival != null ? departure.predicted_arrival : departure.scheduled_arrival,
    predicted: live && departure.predicted_departure != null };
}

export function leaveGuidance(commute, departures, event, now) {
  const candidates = departures.filter(d => !d.cancelled).map(d => ({ d, ...departureTimes(d, now) }))
    .filter(d => d.arrival >= d.departure && d.departure - commute.walk_to_minutes * 60_000 >= now && d.arrival + (commute.walk_from_minutes + commute.arrival_buffer_minutes) * 60_000 <= event.starts_at)
    .sort((a, b) => b.departure - a.departure);
  const chosen = candidates[0];
  if (!chosen) return { commute_id: commute.id, event_title: event.title, leave_at: null, departure: null, basis: 'unavailable', message: 'No boardable direct trip arrives with your walking and arrival buffers.', expires_at: event.starts_at };
  return { commute_id: commute.id, event_title: event.title, leave_at: chosen.departure - commute.walk_to_minutes * 60_000,
    departure: chosen.d, basis: chosen.predicted ? 'predicted' : 'scheduled', message: `From your saved origin. Allow ${commute.walk_to_minutes} min to the stop, ${commute.walk_from_minutes} min after arrival and ${commute.arrival_buffer_minutes} min early.`, expires_at: Math.min(event.starts_at, chosen.departure) };
}
