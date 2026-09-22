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
    const withoutUrls = line.replace(URL_RE, '').replace(/[\s:-]+$/, '').trim();
    if (!withoutUrls) continue; // a line that was only a link
    if (URL_RE.test(line) && withoutUrls.length < 40) continue; // "Label: Name - url" plumbing
    kept.push(withoutUrls);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** "ECE 150 - Assignment 3 due" carries the course in the title when LOCATION has nothing. */
const TITLE_COURSE_RE = /^([A-Z]{2,8}\s?\d{2,4}[A-Z]?)\b/;

/**
 * Everything the card and the detail panel need, from one event's fields.
 * `titleCourse` is an override for callers that already resolved the course themselves.
 */
export function taskContext({ title = '', location = '', description = '', titleCourse = '' } = {}) {
  const { course, place } = courseFromLocation(location);
  const links = extractLinks(description);
  const primary = links.find((l) => l.kind !== 'event') ?? links[0] ?? null;
  const fromTitle = TITLE_COURSE_RE.exec(String(title).trim())?.[1]?.replace(/\s+/g, ' ').toUpperCase() ?? '';
  return {
    course: course || titleCourse || fromTitle,
    place,
    links,
    url: primary?.url ?? '',
    body: descriptionBody(description),
  };
}
