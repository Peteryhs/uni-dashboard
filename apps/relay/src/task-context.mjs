/**
 * Task context, parsed out of a LEARN calendar event.
 *
 * LEARN does not use the iCalendar URL property at all. It writes everything into DESCRIPTION as
 * text, in a shape that repeats:
 *
 *   You must upload a screenshot of the final quiz grade to verify that you have completed WHMIS.
 *
 *   Dropbox:
 *   WHMIS Completion - https://learn.uwaterloo.ca/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=...
 *
 *   View event - https://learn.uwaterloo.ca/d2l/le/calendar/1318281/event/3818542/detailsview?ou=...
 *
 * and it puts the course in LOCATION ("ECE 198 - Fall 2026"), not the room. This module turns that
 * into the three things the card needs: which course, where to go, and what it actually says.
 *
 * Measured on the live feed on 2026-09-22: 84 upcoming events, 65 carrying a course in LOCATION and
 * 63 carrying at least one link in DESCRIPTION, zero carrying a URL property.
 */
import { zonedToEpoch } from '#sources/ics/parse.mjs';

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/**
 * D2L link shapes, most specific first. The kind decides the button label and the order the links
 * appear in, because "Open the dropbox" is the thing a student wants and "View event" is not.
 */
const LINK_KINDS = [
  { kind: 'submit', test: /\/d2l\/lms\/dropbox\// },
  { kind: 'quiz', test: /\/d2l\/lms\/quizzing\// },
  { kind: 'module', test: /\/d2l\/le\/content\// },
  { kind: 'discussion', test: /\/d2l\/le\/discussions\// },
  { kind: 'grade', test: /\/d2l\/lms\/grades\// },
  { kind: 'event', test: /\/d2l\/le\/calendar\// },
];

const KIND_LABELS = {
  submit: 'Open the dropbox',
  quiz: 'Open the quiz',
  module: 'Open the module',
  discussion: 'Open the discussion',
  grade: 'Open the gradebook',
  event: 'Open in LEARN calendar',
  link: 'Open link',
};

/** Section labels that exist only to introduce the link line under them. */
const SECTION_LABELS = /^\s*(quizzes?|dropbox|modules?|discussions?|assignments?|content|view event)\s*:?\s*$/i;

const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** ICS escapes text; a literal backslash-n is a newline and a literal backslash-comma is a comma. */
export function unescapeIcsText(value = '') {
  return String(value)
    .replace(/\\[nN]/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

export function classifyLink(url = '') {
  for (const { kind, test } of LINK_KINDS) {
    if (test.test(url)) return kind;
  }
  return 'link';
}

/** Lower sorts first. A dropbox or a quiz outranks the generic "View event" link. */
function kindRank(kind) {
  return LINK_KINDS.findIndex((k) => k.kind === kind) === -1 ? LINK_KINDS.length : LINK_KINDS.findIndex((k) => k.kind === kind);
}

/**
 * "ECE 198 - Fall 2026" is a course, "PSE 5353" is a room, "Claudette Millar Hall (CMH) - Great Hall
 * (CFE - Fall 2026)" is a place with a term glued on the end. Only the first shape is a course.
 */
export function courseFromLocation(location = '') {
  const trimmed = String(location).trim();
  if (!trimmed) return { course: '', place: '' };
  const m = /^(.*?)\s*[-\u2013]\s*(Fall|Winter|Spring)\s+20\d\d\s*$/i.exec(trimmed);
  const head = m ? m[1].trim() : '';
  const isCourseCode = /^[A-Z]{2,8}\s?\d{2,4}[A-Z]?(\s*\/\s*[A-Z]{2,8}\s?\d{2,4}[A-Z]?)*$/.test(head);
  if (isCourseCode) return { course: head.replace(/\s+/g, ' ').toUpperCase(), place: '' };
  return { course: '', place: trimmed };
}

/** Every link in the description, in the order a student would want them, deduplicated. */
export function extractLinks(description = '') {
  const lines = unescapeIcsText(description).split('\n');
  const found = [];
  const seen = new Set();
  for (const line of lines) {
    const urls = line.match(URL_RE) ?? [];
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      const before = line
        .slice(0, line.indexOf(url))
        .replace(/<[^>]+>/g, ' ')
        .replace(/[\s:-]+$/, '')
        .trim();
      const kind = classifyLink(url);
      found.push({ label: before || KIND_LABELS[kind], url, kind });
    }
  }
  return found.sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
}

/**
 * The prose, with the link plumbing removed. A line is dropped when it is a section label or when it
 * is mostly a URL, and kept when it carries a sentence, because those sentences hold the detail a
 * student needs ("use the side door", "upload a screenshot of the final quiz grade").
 */
export function descriptionBody(description = '') {
  const lines = unescapeIcsText(description).split('\n');
  const kept = [];
  for (const line of lines) {
    if (SECTION_LABELS.test(line)) continue;
    const cleanLine = line.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
    const withoutUrls = cleanLine.replace(URL_RE, '').replace(/[\s:-]+$/, '').trim();
    if (!withoutUrls) continue; // a line that was only a link
    if (URL_RE.test(line) && withoutUrls.length < 40) continue; // "Label: Name - url" plumbing
    kept.push(withoutUrls.replace(/\s+/g, ' '));
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** "ECE 150 - Assignment 3 due" carries the course in the title when LOCATION has nothing. */
const TITLE_COURSE_RE = /^([A-Z]{2,8}\s?\d{2,4}[A-Z]?)\b/;

function parseTime(timeStr) {
  if (!timeStr) return { hour: 23, minute: 59 };
  const s = timeStr.trim().toLowerCase();
  if (s === 'noon') return { hour: 12, minute: 0 };
  if (s === 'midnight') return { hour: 23, minute: 59 };
  const m12 = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)$/i.exec(s);
  if (m12) {
    let h = Number(m12[1]);
    const min = Number(m12[2] || 0);
    const isPm = m12[3].startsWith('p');
    if (h === 12) h = isPm ? 12 : 0;
    else if (isPm) h += 12;
    return { hour: h, minute: min };
  }
  const m24 = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (m24) return { hour: Number(m24[1]), minute: Number(m24[2]) };
  return null;
}

function parseDate(monthStr, dayStr, yearStr, refDateMs, tz) {
  const mKey = String(monthStr).slice(0, 3).toLowerCase();
  const month = MONTH_NAMES[mKey];
  if (!month) return null;
  const day = Number(dayStr);
  if (day < 1 || day > 31) return null;
  let year = yearStr ? Number(yearStr) : null;
  if (!year) {
    const refDate = new Date(refDateMs || Date.now());
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric' });
    const parts = Object.fromEntries(fmt.formatToParts(refDate).map((p) => [p.type, p.value]));
    const refYear = Number(parts.year);
    const refMonth = Number(parts.month);
    year = refYear;
    if (month < refMonth && refMonth - month > 6) {
      year = refYear + 1;
    }
  }
  return { year, month, day };
}

/**
 * Dynamically parse a due date/time stated in prose descriptions of events (such as
 * "To be submitted to Crowdmark by 6pm on Friday, Oct 2").
 */
export function parseDescriptionDueDate(rawDesc, { eventStart = Date.now(), timezone = 'America/Toronto' } = {}) {
  if (!rawDesc || typeof rawDesc !== 'string') return null;
  const clean = unescapeIcsText(rawDesc)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');

  const triggerRe = /\b(?:to\s+be\s+submitted|to\s+be\s+handed\s+in|must\s+be\s+submitted|submitted|submit|upload(?:ed)?|due(?:\s+date)?|deadline)\b/i;
  if (!triggerRe.test(clean)) return null;

  const timePatt = '(?:\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?m\\.?)|noon|midnight|[01]\\d:[0-5]\\d|2[0-3]:[0-5]\\d)';
  const monthPatt = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const dayPatt = '(\\d{1,2})(?:st|nd|rd|th)?';
  const yearPatt = '(?:[\\s,]+(20\\d\\d))?';
  const weekdayPatt = '(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[\\s,]+)?';

  // Pattern 1: 'by 6pm on Friday, Oct 2' or 'by 6pm, Oct 2'
  const p1 = new RegExp(
    `\\b(?:by|at|before|due:?|deadline:?)\\s+(${timePatt})[\\s,]+(?:on|by|before|,)?\\s*${weekdayPatt}(${monthPatt})\\.?\\s+${dayPatt}${yearPatt}`,
    'i'
  );
  // Pattern 2: 'on Friday, Oct 2 at 6pm' or 'Friday, Oct 2 by 6pm' or 'Oct 2, 6pm'
  const p2 = new RegExp(
    `(?:\\b(?:on|by|before|due:?|deadline:?)\\s+)?${weekdayPatt}(${monthPatt})\\.?\\s+${dayPatt}${yearPatt}[\\s,]+(?:at|by|before|,|due|\\s)\\s*(${timePatt})`,
    'i'
  );
  // Pattern 3: Day-Month order: '2nd of October at 6pm' or '2 Oct by 6pm'
  const p3 = new RegExp(
    `(?:\\b(?:on|by|before|due:?|deadline:?)\\s+)?${weekdayPatt}${dayPatt}\\s+(?:of\\s+)?(${monthPatt})\\.?${yearPatt}[\\s,]+(?:at|by|before|,|due|\\s)\\s*(${timePatt})`,
    'i'
  );
  // Pattern 4: ISO date format: 'Due 2026-10-02 at 18:00'
  const pIso = new RegExp(
    `\\b(?:to\\s+be\\s+submitted|to\\s+be\\s+handed\\s+in|must\\s+be\\s+submitted|submit(?:ted)?|due(?:\\s+date)?|deadline|by|before)\\b[^.!?\\n]*?(20\\d\\d)-(\\d{1,2})-(\\d{1,2})(?:[\\s,]+(?:at|by|before|,)?\\s*(${timePatt}))?`,
    'i'
  );
  // Pattern 5: 'Friday, Oct 2' without explicit time after a due/submit trigger
  const p5 = new RegExp(
    `\\b(?:to\\s+be\\s+submitted|to\\s+be\\s+handed\\s+in|must\\s+be\\s+submitted|submit(?:ted)?|due(?:\\s+date)?|deadline)\\b[^.!?\\n]*?\\b(?:(?:on|by|before)\\s+)?${weekdayPatt}(${monthPatt})\\.?\\s+${dayPatt}${yearPatt}`,
    'i'
  );

  let dInfo = null;
  let tInfo = null;
  let matchText = '';

  const m1 = p1.exec(clean);
  if (m1) {
    tInfo = parseTime(m1[1]);
    dInfo = parseDate(m1[2], m1[3], m1[4], eventStart, timezone);
    matchText = m1[0];
  } else {
    const m2 = p2.exec(clean);
    if (m2) {
      dInfo = parseDate(m2[1], m2[2], m2[3], eventStart, timezone);
      tInfo = parseTime(m2[4]);
      matchText = m2[0];
    } else {
      const m3 = p3.exec(clean);
      if (m3) {
        dInfo = parseDate(m3[2], m3[1], m3[3], eventStart, timezone);
        tInfo = parseTime(m3[4]);
        matchText = m3[0];
      } else {
        const mIso = pIso.exec(clean);
        if (mIso) {
          dInfo = { year: Number(mIso[1]), month: Number(mIso[2]), day: Number(mIso[3]) };
          tInfo = parseTime(mIso[4]);
          matchText = mIso[0];
        } else {
          const m5 = p5.exec(clean);
          if (m5) {
            dInfo = parseDate(m5[1], m5[2], m5[3], eventStart, timezone);
            tInfo = { hour: 23, minute: 59 };
            matchText = m5[0];
          }
        }
      }
    }
  }

  if (!dInfo || !tInfo) return null;
  const epoch = zonedToEpoch(dInfo.year, dInfo.month, dInfo.day, tInfo.hour, tInfo.minute, 0, timezone);
  return { due_at: epoch, text: matchText };
}

/**
 * Everything the card and the detail panel need, from one event's fields.
 * `titleCourse` is an override for callers that already resolved the course themselves.
 */
export function taskContext({ title = '', location = '', description = '', titleCourse = '', starts_at = null } = {}) {
  const { course, place } = courseFromLocation(location);
  const links = extractLinks(description);
  const primary = links.find((l) => l.kind !== 'event') ?? links[0] ?? null;
  const fromTitle = TITLE_COURSE_RE.exec(String(title).trim())?.[1]?.replace(/\s+/g, ' ').toUpperCase() ?? '';
  const parsedDue = parseDescriptionDueDate(description, { eventStart: starts_at });
  return {
    course: course || titleCourse || fromTitle,
    place,
    links,
    url: primary?.url ?? '',
    body: descriptionBody(description),
    due_at: parsedDue?.due_at ?? null,
  };
}

/** Determines whether an event signals work opening or work due. */
export function phaseOf(title = '') {
  return /-\s*Available\s*$/i.test(String(title ?? '').trim()) ? 'opens' : 'due';
}

/** Clean title removing trailing '- Available' or '- Due' status tags. */
export function cleanDisplayTitle(title = '') {
  return String(title ?? '')
    .replace(/\s+(?:[-–—]\s*)?Available\s*$/i, '')
    .replace(/\s+(?:[-–—]\s*)?Due\s*$/i, '')
    .trim();
}

/** Conservative identity check between two assessment titles for conflict resolution and deduplication. */
export function isSameAssessment(titleA = '', titleB = '', courseA = '', courseB = '') {
  const normCourseA = String(courseA || '').replace(/\s+/g, '').toUpperCase();
  const normCourseB = String(courseB || '').replace(/\s+/g, '').toUpperCase();
  if (normCourseA && normCourseB && normCourseA !== normCourseB) return false;

  const normalize = (title, course) => {
    let s = String(title || '').toLowerCase()
      .replace(/\s+(?:[-–—]\s*)?(?:due|available)\s*$/i, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\[[^\]]*\]/g, '');
    const c = String(course || '').replace(/\s+/g, '').toLowerCase();
    if (c) {
      s = s.replace(new RegExp(`\\b${c}\\b`, 'gi'), '');
    }
    s = s.replace(/^[a-z]{2,8}\s?\d{2,4}[a-z]?\s*[-–—:]\s*/i, '');
    return s.trim();
  };

  const strA = normalize(titleA, courseA || courseB);
  const strB = normalize(titleB, courseB || courseA);

  const keyA = strA.replace(/[^a-z0-9]/g, '');
  const keyB = strB.replace(/[^a-z0-9]/g, '');

  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;

  const digitsA = strA.match(/\d+/g) || [];
  const digitsB = strB.match(/\d+/g) || [];
  if (digitsA.join(',') !== digitsB.join(',')) return false;

  return keyA.includes(keyB) || keyB.includes(keyA);
}

const GROUP_SCOPE_RE = /\[\s*(?:Sec(?:tion)?\s*(\d+))?\s*(?:Groups?\s*(\d+)\s*-\s*(\d+))?\s*\]/i;

/** Extracts section and group range from titles like "[Sec 002 Groups 1-20]". */
export function groupScope(title = '') {
  const raw = String(title ?? '');
  const m = GROUP_SCOPE_RE.exec(raw);
  if (!m || (!m[1] && !m[2])) {
    return { section: null, groups: null, base: raw.trim() };
  }
  const section = m[1] ? Number(m[1]) : null;
  const groups = m[2] && m[3] ? [Number(m[2]), Number(m[3])] : null;
  const base = raw
    .replace(m[0], '')
    .replace(/\s+/g, ' ')
    .replace(/\s+-\s+Due$/i, ' - Due')
    .trim();
  return { section, groups, base };
}
