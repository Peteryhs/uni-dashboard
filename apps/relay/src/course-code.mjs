const COURSE_RE = /^([A-Z]{2,6}\s?\d{2,3}[A-Z]?)\b/;
export function courseOf(title, location = '') {
  const match = COURSE_RE.exec(title ?? '');
  if (match) return match[1].toUpperCase();
  if (/(?:^|[\s\b])(?:CFE|r[ée]sum[ée]|resume)(?:[\s\b]|$)/i.test(title ?? '') || /\bCFE\b/i.test(location ?? '')) return 'CFE';
  return 'Other';
}
