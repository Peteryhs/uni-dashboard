import { z } from 'zod';
import { Commute as CommuteSchema, CommuteInput, TransitStop as StopSchema, TransitView } from '#contract/transit.mjs';
export type Commute = z.infer<typeof CommuteSchema>;
export type CommuteDraft = z.infer<typeof CommuteInput>;
export type TransitStop = z.infer<typeof StopSchema>;
export type TransitData = z.infer<typeof TransitView>;
export const emptyCommute: CommuteDraft = { name: '', origin: '', destination: '', route: '', walk_to_minutes: 5, walk_from_minutes: 5, arrival_buffer_minutes: 10 };
