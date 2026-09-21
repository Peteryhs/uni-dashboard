/**
 * Personal configuration. Deliberately a committed file in v1, not a settings UI: editing pins
 * is a text edit, and the UI version is a write path plus a settings screen on two clients.
 */
export const config = {
  timezone: 'America/Toronto',

  /** Pinned outlets always render, even closed. REV is home; CMH is the other hall worth the walk. */
  pinnedOutlets: ['REVelation - Residence Dining Hall', "Mudie's - Residence Dining Hall"],

  /** Building-to-building walk minutes, written once by hand. Replaces live transit data. */
  homeBuilding: 'REV',
  walkMinutes: {
    'REV->E7': 14,
    'REV->E5': 15,
    'REV->E3': 12,
    'REV->MC': 17,
    'REV->DC': 20,
    'REV->RCH': 13,
    'REV->CPH': 14,
    'REV->PHY': 16,
    'REV->QNC': 12,
    'E7->E5': 2,
    'E7->E3': 4,
    'E5->E3': 3,
  },

  /** Only used to guess the walk when a room string has no building prefix. */
  defaultWalkMinutes: 15,

  /** Alert slot shows only when status is not normal. */
  alertSeverities: ['minor', 'major', 'critical', 'credential'],
};

export function walkMinutes(from, to) {
  if (!from || !to) return config.defaultWalkMinutes;
  if (from === to) return 0;
  return config.walkMinutes[`${from}->${to}`] ?? config.walkMinutes[`${to}->${from}`] ?? config.defaultWalkMinutes;
}

/**
 * "E7 2317" -> "E7", "MC 4021" -> "MC", "RCH 305" -> "RCH", "PAC 1" -> "PAC", "SLC" -> "SLC".
 * UW room strings put a short building code first (one to four characters, optionally one digit),
 * then the room number. Getting this wrong silently falls back to a default walk time, which is
 * how a leave-by time becomes a lie.
 */
export function buildingOf(room) {
  if (!room) return '';
  const trimmed = room.trim();
  const withNumber = /^([A-Za-z]{1,4}\d?)[\s\-]+(\d{1,5}[A-Za-z]?)$/.exec(trimmed);
  if (withNumber) return withNumber[1].toUpperCase();
  const bare = /^([A-Za-z]{1,4}\d?)$/.exec(trimmed);
  if (bare) return bare[1].toUpperCase();
  const loose = /^([A-Za-z]{1,4}\d?)\b/.exec(trimmed);
  return loose ? loose[1].toUpperCase() : '';
}
