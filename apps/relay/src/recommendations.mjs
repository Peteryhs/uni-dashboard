/** A deterministic agenda engine: reads cached facts only; never calls AI or the network. */
import { buildCalendar } from './calendar.mjs';
import { config } from './config.mjs';
import { listCourseSyllabi, syllabusAssessmentMatches } from './syllabus.mjs';
import { validateRecommendations } from '#contract/recommendations.mjs';
import { zonedToEpoch } from '#sources/ics/parse.mjs';
import { ageState } from '#contract/cards.mjs';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const ACTION_KEY = 'RECOMMENDATION_ACTIONS_JSON';
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, hour: 'numeric', minute: '2-digit' });
function day(ms) { const parts = Object.fromEntries(dateFormat.formatToParts(new Date(ms)).map(p => [p.type, p.value])); return `${parts.year}-${parts.month}-${parts.day}`; }
function shift(date, days) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10); }
function clock(date, hour, minute = 0) { const [y, m, d] = date.split('-').map(Number); return zonedToEpoch(y, m, d, hour, minute, 0, config.timezone); }
function displayTime(ms) { return timeFormat.format(ms).replace(/\./g, ''); }
function json(raw, fallback) { try { return JSON.parse(raw || 'null') ?? fallback; } catch { return fallback; } }
function hash(value) { let n = 2166136261; for (const char of String(value)) { n ^= char.charCodeAt(0); n = Math.imul(n, 16777619); } return (n >>> 0).toString(36); }
function safeUrl(value) { try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } }
function effortFor(title, explicit) { return explicit && explicit !== 'unknown' ? explicit : /\b(project|essay|report|assignment|midterm|final|exam)\b/i.test(title) ? 'large' : /\b(quiz|prework|survey|training)\b/i.test(title) ? 'small' : 'unknown'; }
function item(kind, key, values) {
  const { revision_seed, ...rest } = values;
  const revision = hash(JSON.stringify(revision_seed || [values.title, values.starts_at, values.ends_at, values.due_at, values.topics, values.readings]));
  return { id: `rec:${kind}:${hash(key)}:${revision}`, revision, kind, priority: 0, title: '', body: '', course: null,
    starts_at: null, ends_at: null, due_at: null, scheduled_date: null, time_label: null, effort: 'unknown', estimated_minutes: null, available_minutes: null,
    action: null, topics: [], readings: [], reason: '', evidence: '', source_label: '', state: 'live', can_complete: false, ...rest };
}
function linkFor(event, course, entry = null) {
  const preferred = /quiz/i.test(event?.title || entry?.title || '') ? ['quiz', 'submit', 'module', 'discussion'] : ['submit', 'quiz', 'module', 'discussion'];
  for (const kind of preferred) {
    const found = event?.links?.find(link => link.kind === kind && safeUrl(link.url));
    if (found) return { label: { quiz: 'Open quiz', submit: 'Open submission', module: 'Open content', discussion: 'Open discussion' }[kind], url: safeUrl(found.url) };
  }
  if (safeUrl(entry?.url)) return { label: 'Open syllabus link', url: safeUrl(entry.url) };
  if (safeUrl(event?.url)) return { label: /\/calendar\//.test(event.url) ? 'View calendar entry' : 'Open event link', url: safeUrl(event.url) };
  if (safeUrl(course?.learn_url)) return { label: 'Open course', url: safeUrl(course.learn_url) };
  const resource = course?.resources?.find(resource => safeUrl(resource.url) && /content|lecture|notes/i.test(resource.title));
  return resource ? { label: 'Open course content', url: safeUrl(resource.url) } : null;
}
function explicitMatch(event, documents) {
  if (!event.course) return null;
  return documents.flatMap(doc => (doc.entries || []).map(entry => ({ entry, course: doc.course }))).find(({ entry, course }) => entry.kind === 'assessment' && syllabusAssessmentMatches(entry, course, event))?.entry || null;
}
function learningFor(course, date, documents) {
  const entries = documents.filter(doc => doc.course === course).flatMap(doc => doc.entries || []).filter(entry => entry.kind !== 'assessment' && entry.start_date <= date && (entry.end_date || entry.start_date) >= date);
  return { entries, period: entries.some(entry => entry.end_date && entry.start_date !== entry.end_date), topics: [...new Set(entries.flatMap(entry => entry.topics?.length ? entry.topics : entry.kind === 'topic' ? [entry.title] : []))].slice(0, 8), readings: [...new Set(entries.flatMap(entry => entry.readings?.length ? entry.readings : entry.kind === 'reading' ? [entry.title] : []))].slice(0, 8) };
}
function dueText(due, now) { return day(due) === day(now) ? `today at ${displayTime(due)}` : day(due) === shift(day(now), 1) ? `tomorrow at ${displayTime(due)}` : `${day(due)} at ${displayTime(due)}`; }
function descriptionCoverage(event) {
  const text = String(event?.description || '');
  const match = /\b(?:review(?:ed)?|study)\s+(?:the\s+)?(?:content|material|topics?)\s+(?:in|from)\s+([A-Za-z0-9][A-Za-z0-9 &–'’-]{0,59}?)(?=[.,;!?\n]|\s+(?:before|for|prior to)\b|$)/i.exec(text);
  const value = match?.[1]?.trim().replace(/\s+/g, ' ');
  return value ? [value] : [];
}
function taskPriority(delta, effort, exam) {
  if (delta < 0) return 705;
  if (delta <= HOUR) return exam ? 1200 : 1140;
  if (delta <= 2 * HOUR) return exam ? 1120 : 1030;
  if (delta <= 6 * HOUR) return 940;
  if (delta <= DAY) return 870;
  if (delta <= 2 * DAY) return 740;
  if (delta <= 7 * DAY) return effort === 'large' ? 690 : 470;
  return effort === 'large' ? 560 : 310;
}
function taskItem(event, entry, course, now) {
  const due = event?.all_day ? null : event?.starts_at ?? entry?.due_at ?? null;
  const date = event?.all_day ? day(event.starts_at) : due != null ? day(due) : entry?.start_date;
  if (!date || date < shift(day(now), -1) || date > shift(day(now), 14) || (due != null && due < now - DAY)) return null;
  const rankTime = due ?? clock(date, 23, 59);
  const title = event?.title || entry.title;
  const effort = effortFor(title, entry?.effort);
  const exam = event?.category === 'exam' || /\b(exam|midterm|final)\b/i.test(title);
  const ongoingExam = exam && event && event.starts_at <= now && event.ends_at > now;
  const overdue = !ongoingExam && (due != null ? due < now : date < day(now));
  const topics = entry?.topics?.length ? entry.topics : descriptionCoverage(event), readings = entry?.readings || [];
  const coverage = topics.length ? ` Coverage: ${topics.join('; ')}.` : /quiz|exam|midterm/i.test(title) ? ' Coverage has not been provided; check the course instructions.' : '';
  const noExact = !event?.links?.some(link => ['quiz', 'submit'].includes(link.kind));
  return item('task', event?.id || `${course?.course}:${entry.id}`, {
    revision_seed: [title, due, date, topics, readings],
    title: ongoingExam ? `Now: ${title}` : overdue ? `Confirm ${exam ? 'assessment' : 'submission'}: ${title}` : title,
    body: `${ongoingExam ? `Scheduled now until ${displayTime(event.ends_at)}${event.location ? ` · ${event.location}` : ''}.` : overdue ? `The listed ${exam ? 'assessment' : 'due'} ${due == null ? 'date' : 'time'} has passed; ${exam ? 'completion' : 'submission'} status is unknown.` : due == null ? `Listed for ${date}; no exact time was supplied. Check the course instructions.` : `${exam ? 'Starts' : 'Due'} ${dueText(due, now)}.`}${coverage}`,
    priority: ongoingExam ? 1200 : taskPriority(rankTime - now, effort, exam), course: event?.course || course?.course || null,
    due_at: exam ? null : due, starts_at: exam ? due : null, ends_at: exam ? event?.ends_at ?? null : null, scheduled_date: date, time_label: due == null ? 'Scheduled' : exam ? 'Starts' : 'Due', effort, estimated_minutes: entry?.estimated_minutes || null, topics, readings,
    action: linkFor(event, course, entry), source_label: event ? `${event.source_label}${entry ? ' + syllabus' : ''}` : 'Syllabus',
    state: event?.state || 'live', can_complete: true,
    reason: overdue ? `Check whether you already ${exam ? 'completed' : 'submitted'} this.` : rankTime - now > 2 * DAY && effort === 'large' ? 'Larger work is shown early so you can make progress before the deadline.' : exam ? 'An assessment is approaching.' : 'A deadline is approaching.',
    evidence: `${entry?.evidence || event?.description?.slice(0, 300) || 'Calendar due time.'}${noExact ? ' A direct submission link was not supplied.' : ''}${entry?.effort && entry.effort !== 'unknown' ? '' : effort !== 'unknown' ? ' Work size estimated from its title.' : ''}`,
  });
}
function taskTime(task) { return task.due_at ?? task.starts_at ?? (task.scheduled_date ? clock(task.scheduled_date, 23, 59) : Infinity); }

/** Preserve urgent ordering; use course variety among similarly ranked, non-urgent work. */
export function rankRecommendationItems(items) {
  const remaining = [...items].sort((a, b) => b.priority - a.priority || (a.due_at ?? a.starts_at ?? Infinity) - (b.due_at ?? b.starts_at ?? Infinity) || a.id.localeCompare(b.id));
  const ranked = [], counts = new Map();
  while (remaining.length) {
    const best = remaining[0].priority;
    let index = 0, score = -Infinity;
    for (let i = 0; i < remaining.length && remaining[i].priority >= best - 70; i++) {
      const candidate = remaining[i];
      const adjusted = candidate.priority - (candidate.priority >= 900 ? 0 : (counts.get(candidate.course) || 0) * 35);
      if (adjusted > score) { score = adjusted; index = i; }
    }
    const [next] = remaining.splice(index, 1); ranked.push(next);
    if (next.course) counts.set(next.course, (counts.get(next.course) || 0) + 1);
  }
  return ranked;
}

/** Pure entry point also used to simulate an entire day with fixed, synthetic data. */
export function recommendationsFromData({ calendar, syllabi = [], food = null, menu = [], weather = null, actions = {}, now = Date.now(), freshnessNow = now }) {
  const today = day(now), tomorrow = shift(today, 1), candidates = [], warnings = [];
  const courses = new Map((calendar.courses || []).map(course => [course.course, course]));
  const events = [...new Map(calendar.days.flatMap(date => date.events).map(event => [event.id, event])).values()];
  const tasks = [];
  const matched = new Set();
  for (const event of events.filter(event => ['deadline', 'exam'].includes(event.category))) {
    const entry = explicitMatch(event, syllabi);
    if (entry) matched.add(`${event.course}:${entry.id}`);
    const task = taskItem(event, entry, courses.get(event.course), now);
    if (task) tasks.push(task);
  }
  for (const doc of syllabi) for (const entry of doc.entries || []) {
    if (entry.kind !== 'assessment' || matched.has(`${doc.course}:${entry.id}`)) continue;
    const task = taskItem(null, entry, courses.get(doc.course) || { course: doc.course }, now);
    if (task) tasks.push(task);
  }
  const isVisible = candidate => {
    const saved = actions[candidate.id];
    return !saved || (saved.action !== 'done' && !(saved.action === 'snooze' && saved.until > now));
  };
  const activeTasks = tasks.filter(isVisible);
  candidates.push(...activeTasks);
  const blocks = events.filter(event => ['class', 'exam', 'event'].includes(event.category) &&
    !(event.source_id === 'uw-learn-ics' && event.category === 'event') &&
    !event.all_day && event.ends_at > now && event.starts_at < clock(tomorrow, 0)).sort((a, b) => a.starts_at - b.starts_at);
  for (const event of blocks.filter(event => event.category === 'class')) {
    const current = event.starts_at <= now, until = event.starts_at - now;
    const learning = learningFor(event.course, day(event.starts_at), syllabi);
    candidates.push(item('class', event.id, {
      revision_seed: [event.id, event.title, event.starts_at, event.ends_at, event.location, learning.topics, learning.readings],
      title: `${current ? 'Now' : until <= 15 * MIN ? 'Starting soon' : 'Next today'}: ${event.title}`,
      body: `${displayTime(event.starts_at)}–${displayTime(event.ends_at)}${event.location ? ` · ${event.location}` : ''}.${learning.topics.length ? ` ${learning.period ? 'Syllabus topics for this period' : 'Learning today'}: ${learning.topics.join('; ')}.` : ' No dated syllabus topic has been imported for this class.'}`,
      priority: current ? 1100 : until <= 15 * MIN ? 1080 : until <= HOUR ? 980 : until <= 3 * HOUR ? 800 : 630,
      course: event.course, starts_at: event.starts_at, ends_at: event.ends_at, time_label: 'Starts', topics: learning.topics, readings: learning.readings,
      action: linkFor(event, courses.get(event.course)), source_label: `${event.source_label}${learning.entries.length ? ' + syllabus' : ''}`, state: event.state,
      reason: current ? 'This class is on your timetable now.' : 'Your next scheduled class today.', evidence: learning.entries.map(entry => entry.evidence).filter(Boolean).join(' ').slice(0, 600) || 'Calendar time and room.',
    }));
  }
  for (const course of new Set(syllabi.map(doc => doc.course))) {
    const learning = learningFor(course, today, syllabi);
    // Class cards already carry the topic; keep readings actionable and quiet-day study visible.
    if (!learning.entries.length || (!learning.readings.length && blocks.some(event => event.course === course && event.category === 'class'))) continue;
    const key = `${course}:${learning.entries.map(entry => `${entry.id}:${entry.start_date}:${entry.end_date || entry.start_date}`).join(',')}`;
    candidates.push(item('learning', key, { title: `${course}: ${learning.readings.length ? learning.period ? 'Reading for this period' : 'Today’s reading' : learning.period ? 'Learning for this period' : 'Today’s learning'}`, body: [...learning.topics, ...learning.readings].join('; '),
      course, priority: 550, topics: learning.topics, readings: learning.readings, can_complete: true,
      action: linkFor(null, courses.get(course), learning.entries.find(entry => entry.url)), source_label: 'Syllabus', reason: learning.period ? 'This date falls within the syllabus period for this material; the exact lecture topic is not confirmed.' : 'Your syllabus maps this material to today.', evidence: learning.entries.map(entry => entry.evidence).filter(Boolean).join(' ').slice(0, 600) }));
  }
  const offices = events.filter(event => event.category === 'office_hours' && event.ends_at > now && event.starts_at <= now + 2 * DAY);
  for (const event of offices) {
    const workload = activeTasks.find(task => task.course === event.course && taskTime(task) > event.starts_at && taskTime(task) < event.starts_at + 7 * DAY);
    if (!workload) continue;
    candidates.push(item('office_hours', event.id, { title: `${event.course}: ask for help before ${workload.title}`, body: `${dueText(event.starts_at, now)}${event.location ? ` · ${event.location}` : ''}. Bring questions about the upcoming work.`,
      priority: event.starts_at <= now + HOUR ? 820 : 580, course: event.course, starts_at: event.starts_at, ends_at: event.ends_at, action: linkFor(event, courses.get(event.course)), source_label: event.source_label, state: event.state,
      reason: 'Office hours happen before a deadline in this course.', evidence: 'Matched by course and calendar time; no help requirement is assumed.' }));
  }
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
    const a = blocks[i], b = blocks[j];
    if (b.starts_at >= a.ends_at) break;
    candidates.push(item('conflict', [a.id, b.id].sort().join(':'), { title: 'Two scheduled events overlap', body: `${a.title} and ${b.title} overlap from ${displayTime(Math.max(a.starts_at, b.starts_at))}. Check which one you should attend.`,
      starts_at: Math.max(a.starts_at, b.starts_at), ends_at: Math.min(a.ends_at, b.ends_at), priority: Math.max(a.starts_at, b.starts_at) <= now + HOUR ? 1090 : 780, source_label: 'Calendar',
      state: a.state === 'dead' || b.state === 'dead' ? 'dead' : a.state === 'stale' || b.state === 'stale' ? 'stale' : 'live', reason: 'Your timetable contains overlapping commitments.', evidence: 'Overlap calculated from supplied event times.' }));
  }
  const nextBlock = blocks.find(event => event.starts_at > now);
  const currentBlock = blocks.find(event => event.starts_at <= now && event.ends_at > now);
  if (!currentBlock && now >= clock(today, 8) && now < clock(today, 21) && activeTasks.some(task => taskTime(task) >= now)) {
    const end = Math.min(nextBlock?.starts_at ?? clock(today, 21), clock(today, 21));
    const available = Math.floor((end - now) / MIN);
    if (available >= 25) {
      const task = rankRecommendationItems(activeTasks.filter(task => taskTime(task) >= now))[0];
      candidates.push(item('focus', `${today}:${nextBlock?.id || 'evening'}:${task.id}`, { revision_seed: [today, nextBlock?.id, task.id, end], title: `A study window for ${task.course || 'your next task'}`, body: `${available} minutes are clear in your imported timetable${nextBlock ? ` before ${nextBlock.title}` : ' until 9 pm'}. Make progress on ${task.title}; leave time for travel and breaks.`,
        priority: task.priority >= 900 ? 880 : 600, course: task.course, starts_at: now, ends_at: end, available_minutes: available, action: task.action,
        source_label: 'Calendar + deadlines', state: task.state, reason: 'An open timetable window lines up with upcoming work.', evidence: 'This is a schedule gap, not an estimate of how long the task takes.' }));
    }
  }
  if (now >= clock(today, 10, 30) && now < clock(today, 14, 30)) {
    const lunchSoon = now >= clock(today, 11, 15) && now < clock(today, 13, 30);
    const ready = food?.status === 'ready' && food.service_date === today ? food.recommendation : null;
    const top = ready?.ranked_outlets?.find(outlet => outlet.outlet === ready.top_outlet) || ready?.ranked_outlets?.[0];
    const freshMenu = menu.filter(row => row.service_date === today);
    if (ready || freshMenu.length) {
      const dishes = freshMenu.filter(row => !top || row.outlet === top.outlet).slice(0, 3);
      const observed = Math.max(food?.updated_at || 0, ...freshMenu.map(row => row.observed_at || 0));
      const state = observed ? ageState(observed, 12 * HOUR, freshnessNow) : 'stale';
      candidates.push(item('food', `lunch:${today}:${top?.outlet || 'menu'}`, { title: ready ? `Lunch: ${ready.top_outlet || top?.outlet || 'your dining picks'}` : 'Check today’s lunch menu',
        body: [ready?.headline, dishes.map(row => row.dish).join(', '), currentBlock ? 'You are in a scheduled class now; plan for your next break.' : 'Check the outlet’s posted opening hours before heading over.'].filter(Boolean).join(' '),
        priority: currentBlock ? 610 : lunchSoon ? 920 : 540, action: safeUrl(dishes[0]?.url) ? { label: 'View menu', url: safeUrl(dishes[0].url) } : null,
        state, source_label: ready ? 'Cached dining recommendation' : 'Today’s menu', reason: 'Lunch is approaching in your campus time zone.', evidence: ready ? 'Uses the saved menu ranking; no AI request was made for this update.' : 'Current menu dishes; no personalized ranking is available.' }));
    }
  }
  if (weather?.forecast?.length) {
    const target = nextBlock && nextBlock.starts_at <= now + 3 * HOUR ? nextBlock.starts_at : now;
    const hours = weather.forecast.filter(hour => hour.at >= now - HOUR && Math.abs(hour.at - target) <= 90 * MIN);
    const hour = [...hours].sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target))[0];
    if (hour) {
      const rain = Number.isFinite(hour.precip_prob) && hour.precip_prob >= 50 || Number.isFinite(hour.precip_mm) && hour.precip_mm >= 0.5;
      const cold = Number.isFinite(hour.feels_c) && hour.feels_c <= 0, hot = Number.isFinite(hour.feels_c) && hour.feels_c >= 30, windy = Number.isFinite(hour.wind_kmh) && hour.wind_kmh >= 35;
      const stale = ['stale', 'dead'].includes(weather.state);
      candidates.push(item('weather', `${today}:${hour.at}`, { title: rain ? 'Rain near your next trip' : cold ? 'Cold weather outside' : hot ? 'Hot weather outside' : windy ? 'Windy weather outside' : 'Weather for your next break',
        body: `${Number.isFinite(hour.temp_c) ? `${Math.round(hour.temp_c)}°C` : 'Temperature unavailable'}${Number.isFinite(hour.feels_c) ? `, feels like ${Math.round(hour.feels_c)}°C` : ''}${Number.isFinite(hour.precip_prob) ? `; ${Math.round(hour.precip_prob)}% chance of precipitation` : ''}.${rain ? ' Bring rain protection.' : ''}${stale ? ' This forecast is old; check current conditions.' : ''}`,
        priority: stale ? 250 : rain || cold || hot || windy ? 760 : 330, starts_at: hour.at, state: weather.state || 'live', source_label: 'Cached weather forecast',
        reason: nextBlock ? 'Conditions around the next scheduled trip.' : 'Conditions around your current campus time.', evidence: `Forecast cached ${weather.observed_at ? new Date(weather.observed_at).toISOString() : 'at an unknown time'}.` }));
    }
  }
  const sourceNames = { 'uw-portal-ics': 'Class schedule', 'uw-learn-ics': 'LEARN calendar', 'user-office-hours': 'Office hours' };
  for (const source of calendar.sources || []) if (source.status !== 'ok') warnings.push(`${sourceNames[source.id] || source.id}: ${source.status === 'failed' ? 'the latest sync failed; cached events may be out of date.' : source.status === 'unconfigured' ? 'not configured.' : 'waiting for its first sync.'}`);
  if (events.some(event => ['stale', 'dead'].includes(event.state))) warnings.push('Some calendar details are old. Confirm changed times and deadlines in the source course.');
  if (calendar.truncated) warnings.push('The calendar response was truncated; some events may be missing.');
  const ranked = rankRecommendationItems(candidates.filter(isVisible));
  const items = ranked.slice(0, 16);
  const sortedTasks = rankRecommendationItems(activeTasks);
  return validateRecommendations({ schema_version: 1, generated_at: now, timezone: config.timezone, refresh_after_ms: 60_000,
    headline: items[0]?.title || (warnings.length ? 'Your day is waiting for updated course information' : 'Nothing urgent in your imported schedule'), items,
    tasks: { large: sortedTasks.filter(task => task.effort === 'large').slice(0, 30), small: sortedTasks.filter(task => task.effort !== 'large').slice(0, 30) }, warnings: [...new Set(warnings)] });
}

export async function buildRecommendations(store, { now = Date.now(), freshnessNow = now, section = null, group = null, weather = null } = {}) {
  const date = day(now);
  const [calendar, syllabi, saved, foodRaw, menu] = await Promise.all([
    buildCalendar(store, { start: shift(date, -1), days: 16, section, group, now: freshnessNow, includeSyllabus: false }), listCourseSyllabi(store),
    store.getSetting(ACTION_KEY), store.getSetting('FOOD_AI_RECOMMENDATION_JSON'),
    store.rows('menu_item', { where: 'service_date = ?', params: [date], limit: 100 }),
  ]);
  return recommendationsFromData({ calendar, syllabi, actions: json(saved, {}), food: json(foodRaw, null), menu, weather, now, freshnessNow });
}

/** Bounded account-wide state survives browser changes and is reusable by Android. */
export async function saveRecommendationAction(store, { id, action, until = null } = {}, { now = Date.now() } = {}) {
  if (typeof id !== 'string' || !/^rec:[a-z_]+:[a-z0-9]+:[a-z0-9]+$/.test(id) || id.length > 240 || !['done', 'undo', 'snooze'].includes(action)) throw new RangeError('invalid recommendation action');
  if (action === 'done' && !/^rec:(task|learning):/.test(id)) throw new RangeError('only tasks and learning items can be completed');
  if (action === 'snooze' && until == null) until = now + HOUR;
  if (action === 'snooze' && (!Number.isInteger(until) || until <= now || until > now + 7 * DAY)) throw new RangeError('snooze must end within the next seven days');
  const previous = json(await store.getSetting(ACTION_KEY), {});
  const entries = Object.entries(previous).filter(([key, value]) => key !== id && value && value.at >= now - 90 * DAY && (value.action === 'done' || value.until > now)).sort((a, b) => b[1].at - a[1].at).slice(0, 255);
  const next = Object.fromEntries(entries);
  if (action !== 'undo') next[id] = { action, until: action === 'snooze' ? until : null, at: now };
  await store.setSetting(ACTION_KEY, JSON.stringify(next));
  return { ok: true, id, action, until: action === 'snooze' ? until : null };
}
