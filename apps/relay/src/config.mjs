/**
 * Personal configuration. Deliberately a committed file in v1, not a settings UI: editing pins
 * is a text edit, and the UI version is a write path plus a settings screen on two clients.
 *
 * There is no walk-time table, no building coordinate set and no routing any more. The owner
 * commutes by bus, so "leave by" was a number nobody acted on, and the walk table itself turned
 * out to have been invented in the first build session rather than measured. Removed in one piece:
 * table, coordinates, OSM foot routing, Haversine fallback, room parsing, the nav link, and the
 * walk_minutes / leave_by / from_* fields on the next commitment card.
 */
export const config = {
  timezone: 'America/Toronto',

  /** Pinned outlets always render, even when nothing was posted for them that day. */
  pinnedOutlets: [
    'REVelation - Residence Dining Hall',
    "Mudie's - Residence Dining Hall",
    'The Market - Residence Dining Hall',
  ],

  /** Alert slot shows only when status is not normal. */
  alertSeverities: ['minor', 'major', 'critical', 'credential'],
};
