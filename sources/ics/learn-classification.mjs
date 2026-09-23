/** Normalize LEARN ICS items without treating every campus date as coursework. */
const EXAM_RE = /\b(midterm|final exam|exam)\b/i;
const ACTIVITY_RE = /\b(?:session|event|meeting|review|talk|webinar|office hours)\b/i;
const EXPLICIT_DUE_RE = /\b(?:due|deadline|submission closes|submissions close)\b/i;
const ASSESSMENT_RE = /\b(?:submission|assignment|quiz|prework|midterm|exam|test|lab report|homework|problem set)\b/i;

/** `kind` is the normalized calendar category. Generic LEARN items remain visible as events. */
export function learnEventCategory(title = '', storedKind = '') {
  const summary = String(title).trim();
  if (/[-\s]Available\s*$/i.test(summary)) return 'opens';
  if (ACTIVITY_RE.test(summary) && !EXPLICIT_DUE_RE.test(summary)) return 'event';
  if (EXAM_RE.test(summary)) return 'exam';
  if (EXPLICIT_DUE_RE.test(summary) || ASSESSMENT_RE.test(summary)) return 'deadline';

  // Old rows were all saved as deadlines. Preserve only a genuine exam with a clear title;
  // ambiguous historical rows are generic events rather than assumed student obligations.
  return storedKind === 'exam' ? 'exam' : 'event';
}

/** Source rows use the same title rules as calendar responses (before history is persisted). */
export function classifyLearnEvent(title = '') {
  const category = learnEventCategory(title);
  return category === 'opens' ? 'event' : category;
}
