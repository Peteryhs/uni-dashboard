/** User-selected course links; LEARN itself remains behind the student's sign-in. */
const KEY = 'COURSE_LIBRARY_JSON';
export const COURSE_RE = /^[A-Z]{2,8}\s?\d{2,4}[A-Z]?(?:\s*\/\s*[A-Z]{2,8}\s?\d{2,4}[A-Z]?)*$/;

export function normalizeCourse(value) {
  const course = String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!COURSE_RE.test(course)) throw new RangeError('invalid course code');
  return course;
}

export async function courseLibrary(store) {
  try {
    const parsed = JSON.parse(await store.getSetting(KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function cleanUrl(value, allowRelative = false) {
  try {
    if (typeof value !== 'string' || !value.trim()) return null;
    if (!allowRelative && !/^https:\/\//i.test(value)) return null;
    const url = new URL(value.replace(/\\&/g, '&').replace(/&amp;/g, '&'), 'https://learn.uwaterloo.ca');
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function previewCourseImport(input) {
  const text = String(input || '').slice(0, 100_000);
  const candidates = [];
  for (const match of text.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    candidates.push({ url: match[1], label: match[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), section: '' });
  }
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = /^#{1,4}\s+(.+)$/.exec(line);
    if (heading) section = heading[1].replace(/\[[^\]]+\]\([^)]*\)/g, '').trim().toLowerCase();
    for (const match of line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
      candidates.push({ url: match[2], label: match[1], section });
    }
    if (line.includes('](') || /<a\b/i.test(line)) continue;
    for (const match of line.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
      candidates.push({ url: match[0].replace(/[.,;]+$/, ''), label: line.slice(0, match.index).replace(/[\s:-]+$/, '').trim(), section });
    }
  }
  const seen = new Set();
  return candidates.map(({ url, label, section }) => {
    const href = cleanUrl(url, true);
    if (!href || seen.has(href)) return null;
    const parsed = new URL(href);
    const path = parsed.pathname.toLowerCase();
    const title = label.replace(/\*\*/g, '').replace(/&#x9;|&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
    const lower = `${title} ${href}`.toLowerCase();
    if (/mental health|library resources|course tools/.test(section) || /mental health|course admin|show all announcements/i.test(title)) return null;
    if (path.includes('/d2l/le/calendar/') || path.includes('/d2l/lp/cmc/') || /\/d2l\/le\/news\/\d+\/\d+\/view/.test(path)) return null;
    const isLearn = parsed.hostname === 'learn.uwaterloo.ca';
    const isCoursePage = isLearn && (/^\/d2l\/home\/\d+/.test(path) || /^\/d2l\/le\/content\//.test(path) || /^\/d2l\/lms\/grades\//.test(path) || /^\/d2l\/lms\/news\/main\.d2l/.test(path) || /^\/d2l\/common\/dialogs\/quicklink\//.test(path));
    const isTextbook = /textbook|e-?book|pearson|wiley|mcgraw|cengage/.test(lower);
    const isCourseMaterial = /syllabus|course outline|lecture|slides|worksheet|workshop|assignment|lab manual|crowdmark|piazza|edstem|ed discussion/i.test(lower);
    if (!isCoursePage && !isTextbook && !isCourseMaterial) return null;
    seen.add(href);
    const kind = isTextbook ? 'textbook' : isLearn ? 'learn' : 'resource';
    return { title: title.slice(0, 120) || (isLearn ? 'LEARN page' : parsed.hostname), url: href, kind };
  }).filter(Boolean).slice(0, 100);
}

export async function saveCourseResources(store, courseInput, input) {
  const course = normalizeCourse(courseInput);
  if (!Array.isArray(input) || input.length > 100) throw new RangeError('resources must be an array of at most 100 links');
  const resources = [];
  const seen = new Set();
  for (const item of input) {
    const url = cleanUrl(item?.url);
    if (!url) throw new RangeError('each resource needs an HTTPS URL');
    if (seen.has(url)) continue;
    seen.add(url);
    const title = String(item?.title || '').trim().slice(0, 120) || new URL(url).hostname;
    const kind = ['learn', 'textbook', 'resource'].includes(item?.kind) ? item.kind : 'resource';
    resources.push({ title, url, kind });
  }
  const library = await courseLibrary(store);
  library[course] = resources;
  await store.setSetting(KEY, JSON.stringify(library));
  return resources;
}

export function learnHomeFromEvents(events) {
  for (const event of events) for (const link of event.links || []) {
    try {
      const url = new URL(link.url);
      if (url.hostname !== 'learn.uwaterloo.ca') continue;
      const orgUnit = url.searchParams.get('ou');
      if (orgUnit && /^\d+$/.test(orgUnit)) return `https://learn.uwaterloo.ca/d2l/home/${orgUnit}`;
      const home = /^\/d2l\/home\/(\d+)/.exec(url.pathname);
      if (home) return `https://learn.uwaterloo.ca/d2l/home/${home[1]}`;
    } catch {}
  }
  return null;
}
