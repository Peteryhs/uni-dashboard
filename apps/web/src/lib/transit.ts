import { z } from 'zod';
import { Commute as CommuteSchema, CommuteInput, TransitStop as StopSchema, TransitView } from '#contract/transit.mjs';
import { countdown } from './time';
export type Commute = z.infer<typeof CommuteSchema>;
export type CommuteDraft = z.infer<typeof CommuteInput>;
export type TransitStop = z.infer<typeof StopSchema>;
export type TransitData = z.infer<typeof TransitView>;
export const emptyCommute: CommuteDraft = { name: '', origin: '', destination: '', route: '', walk_to_minutes: 5, walk_from_minutes: 5, arrival_buffer_minutes: 10 };
/** Matches the relay's limit in TransitEngine.save. */
export const MAX_COMMUTES = 6;

/** "Leave in 12m", or "Leave now" inside the last minute. */
export function leaveLabel(at: number, now: number): string {
  return at - now < 60_000 ? 'Leave now' : `Leave ${countdown(at, now)}`;
}

export function routeList(routes: string[]): string {
  if (!routes.length) return '';
  return routes.length === 1 ? `Route ${routes[0]}` : `Routes ${routes.join(', ')}`;
}

/** Secondary line for a stop: what kind it is, its sign number, and the routes that serve it. */
export function stopMeta(stop: TransitStop): string {
  // ION platforms have no public stop number, and every ION trip is route 301.
  if (stop.mode === 'ion') return 'ION station';
  return [`Bus stop ${stop.code}`, routeList(stop.routes)].filter(Boolean).join(' · ');
}

export function shortStopName(name: string): string {
  return name.replace(/\s+-\s+(north|south|east|west)bound$/i, '').trim();
}

export function suggestedCommuteName(destination?: string | null): string {
  return destination ? `To ${shortStopName(destination)}`.slice(0, 80) : 'To campus';
}

export function commuteSummary(c: Commute): string {
  return [c.route ? `Route ${c.route}` : 'Any direct route', `${c.walk_to_minutes} min to the stop`, `${c.walk_from_minutes} min after`, `${c.arrival_buffer_minutes} min early`].join(' · ');
}

const FAILURE_LABELS: [RegExp, string][] = [
  [/^static:bus:\s*/, 'Bus timetable: '], [/^static:ion:\s*/, 'ION timetable: '],
  [/^rt:bus:\s*/, 'Bus predictions: '], [/^rt:ion:\s*/, 'ION predictions: '], [/^alerts:\s*/, 'Service alerts: '],
];
/** The relay joins upstream failures with " · " and prefixes internal feed keys; name them plainly. */
export function describeTransitError(error: string): string[] {
  return [...new Set(error.split(' · ').map(part => {
    const text = part.trim();
    const label = FAILURE_LABELS.find(([pattern]) => pattern.test(text));
    return label ? text.replace(label[0], label[1]) : text;
  }).filter(Boolean))];
}
