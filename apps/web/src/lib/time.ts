/**
 * Time formatting.
 *
 * Everything renders in America/Toronto, not in the device timezone. A 14:30 lecture happens at
 * 14:30 in Waterloo whether the laptop thinks it is in Vancouver or not, so the campus timezone
 * is the correct frame and the device is the wrong one.
 */
export const CAMPUS_TZ = 'America/Toronto';

const timeFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAMPUS_TZ,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const weekdayTimeFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAMPUS_TZ,
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAMPUS_TZ,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

const shortDayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAMPUS_TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

export function formatTime(ms: number): string {
  return timeFmt.format(new Date(ms)).replace(/\s?([ap])\.?m\.?/i, (_, p) => p.toLowerCase() + 'm');
}

export function formatWeekdayTime(ms: number): string {
  return weekdayTimeFmt.format(new Date(ms)).replace(/\s?([ap])\.?m\.?/i, (_, p) => p.toLowerCase() + 'm');
}

export function formatDay(ms: number): string {
  return dayFmt.format(new Date(ms));
}

export function formatShortDay(ms: number): string {
  return shortDayFmt.format(new Date(ms));
}

/** Calendar date in the campus timezone, as YYYY-MM-DD. Matches the relay's service_date. */
export function campusDate(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: CAMPUS_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 0 = today, 1 = tomorrow, -1 = yesterday, in campus-calendar days. */
export function dayOffset(ms: number, now: number = Date.now()): number {
  const a = campusDate(ms);
  const b = campusDate(now);
  if (a === b) return 0;
  const diffMs = Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`);
  return Math.round(diffMs / 86_400_000);
}

/**
 * "in 2h 14m", "in 3 days", "12m ago". Coarse on purpose past an hour: a countdown to something
 * three days out does not need seconds, and showing them implies a precision the feed lacks.
 */
export function countdown(target: number, now: number = Date.now()): string {
  const delta = target - now;
  const past = delta < 0;
  const abs = Math.abs(delta);

  const mins = Math.floor(abs / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  let text: string;
  if (abs < 60_000) text = 'less than a minute';
  else if (mins < 60) text = `${mins}m`;
  else if (hours < 24) {
    const remMins = mins % 60;
    text = remMins ? `${hours}h ${remMins}m` : `${hours}h`;
  } else if (days < 7) {
    const remHours = hours % 24;
    text = remHours ? `${days}d ${remHours}h` : `${days}d`;
  } else text = `${days}d`;

  return past ? `${text} ago` : `in ${text}`;
}

/** Compact age for the freshness line: "< 1m", "12m", "3h", "2d". */
export function shortAge(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  const m = Math.floor(s / 60);
  if (m < 1) return '< 1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Human label for a diet tag. The feed uses lowercase single words. */
export function dietLabel(tag: string): string {
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}
