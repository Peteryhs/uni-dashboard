const campusDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });
const date = at => campusDay.format(at);

/** Date-only entries stay current until their final campus day ends. */
export function calendarEventPassed(event, now) {
  if (event.all_day) return date(now) > date(Math.max(event.starts_at, event.ends_at - 1));
  return Math.max(event.starts_at, event.ends_at) <= now;
}

/** Agenda rows are not a time grid: the marker advances past ended events. */
export function calendarNowIndex(events, now) {
  const today = date(now);
  const index = events.findIndex(event => date(event.starts_at) > today || (!event.all_day && !calendarEventPassed(event, now)));
  return index < 0 ? events.length : index;
}
