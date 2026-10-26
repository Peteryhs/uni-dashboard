/**
 * Which poller source a saved feed setting configures.
 *
 * Removing a URL has to clear the same source the runner writes, not just the setting row. Keeping
 * the map here means the Worker and the local relay cannot disagree about which source to purge.
 * Calendar feeds that share a role (Portal and Google) still have distinct source ids, so removing
 * one never deletes the other's events.
 */
export const FEED_SOURCE_BY_SETTING = Object.freeze({
  PORTAL_ICS_URL: 'uw-portal-ics',
  GOOGLE_CALENDAR_ICS_URL: 'google-calendar-ics',
  LEARN_ICS_URL: 'uw-learn-ics',
});

export function feedSourceId(setting) {
  return FEED_SOURCE_BY_SETTING[setting] ?? null;
}
