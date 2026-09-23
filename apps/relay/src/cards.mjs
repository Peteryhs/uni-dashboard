/**
 * Card builders. Server-computed priority, so web and Android agree on order without a release.
 *
 * Every card carries observed_at and valid_until, and a card that cannot be built is still sent,
 * with state 'empty' or 'degraded'. Absence is a state, not a missing key.
 */
import { ageState, buildBundle } from '#contract/cards.mjs';
import { validateCardData } from '#contract/card-data.mjs';
import { config } from './config.mjs';
import { taskContext, phaseOf, groupScope } from './task-context.mjs';
import { hourlyForecast, at as weatherAt, worthShowing } from './weather.mjs';
import { alertIdentity, alertSummaryFor, ALERT_SUMMARY_SETTING, ALERT_DISMISSED_SETTING } from './alert-summary.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function envelope(rows, { now, cadenceMs, fallback }) {
  const fresh = rows.filter((r) => r.observed_at != null);
  const observed = fresh.length ? Math.max(...fresh.map((r) => r.observed_at)) : null;
  const valid = fresh.length ? Math.max(...fresh.map((r) => r.valid_until ?? 0)) : null;
  const state = fresh.length ? ageState(observed, cadenceMs, now) : (fallback ?? 'empty');
  return { observed_at: observed, valid_until: valid || null, state };
}

function maybePromise(val, fn) {
  return val && typeof val.then === 'function' ? val.then(fn) : fn(val);
}

/**
 * Checks whether a source has had a successful fetch in the reasonable past (within 6x cadence).
 * If the latest attempt failed or was skipped, and no successful fetch exists in the reasonable past,
 * returns { ok: false, state: 'failed' | 'degraded', error: string }.
 */
function sourceHealth(store, sourceId, cadenceMs, now) {
  if (!store || typeof store.lastRunPerSource !== 'function') {
    return { ok: true, state: 'empty' };
  }
  return maybePromise(store.lastRunPerSource(), (runs) => {
    const lastRun = (runs || []).find((r) => r.source_id === sourceId);
    if (!lastRun) {
      return { ok: true, state: 'empty' };
    }

    if (lastRun.outcome === 'skipped') {
      return {
        ok: false,
        state: 'degraded',
        error: lastRun.error || 'Feed URL not configured in Settings',
      };
    }

    if (lastRun.outcome === 'failed' || lastRun.outcome === 'implausible') {
      return maybePromise(store.lastSuccessfulRun?.(sourceId), (lastSuccess) => {
        const reasonablePastMs = cadenceMs * 6;
        const hadRecentSuccess = lastSuccess && (now - lastSuccess.finished_at <= reasonablePastMs);
        if (!hadRecentSuccess) {
          return {
            ok: false,
            state: 'failed',
            error: lastRun.error || 'Failed to sync with upstream feed',
          };
        }
        return { ok: true, state: 'live' };
      });
    }

    return { ok: true, state: 'live' };
  });
}

/** Card 1: the next class, with the deadlines card as its own space. What, where and when. */
export async function nextCommitmentCard(store, { now = Date.now(), useWeather = true } = {}) {
  /**
   * The hero card belongs to the schedule feed.
   *
   * It used to take the soonest of anything, class or deadline, which sounded right and read wrong:
   * LEARN carries far more items than a timetable does (84 upcoming events against a handful of
   * classes), so a term date or a quiz opening hijacked the countdown to the next class. The
   * schedule feed goes first, and a deadline only takes the hero slot when nothing is scheduled
   * ahead, which is the honest fallback rather than a permanent override.
   */
  const schedule = (
    await store.rows('timeline_event', {
      where: 'source_id = ? AND starts_at >= ?',
      params: [SCHEDULE_SOURCE, now - 5 * MIN],
      limit: 200,
      orderBy: 'starts_at',
    })
  ).sort((a, b) => a.starts_at - b.starts_at);

  const deadlines = (
    await store.rows('timeline_event', {
      where: 'kind IN (?,?) AND starts_at >= ?',
      params: ['deadline', 'exam', now - 5 * MIN],
      limit: 200,
      orderBy: 'starts_at',
    })
  ).sort((a, b) => a.starts_at - b.starts_at);

  const next = schedule[0] ?? deadlines[0];

  if (!next) {
    const health = await sourceHealth(store, SCHEDULE_SOURCE, 15 * MIN, now);
    if (!health.ok) {
      return {
        id: 'next_commitment',
        type: 'next_commitment',
        priority: 100,
        state: health.state,
        observed_at: null,
        valid_until: null,
        source_id: SCHEDULE_SOURCE,
        data: {
          title: health.state === 'failed' ? 'Unable to fetch schedule' : 'Schedule feed not configured',
          subtitle: health.error,
        },
      };
    }
    // An empty timetable is a fact, not an error: no server-side failure, nothing due today.
    return {
      id: 'next_commitment',
      type: 'next_commitment',
      priority: 100,
      state: 'empty',
      observed_at: null,
      valid_until: null,
      source_id: '',
      data: { title: 'Nothing scheduled', subtitle: 'No class or deadline ahead' },
    };
  }

  let weather = null;
  if (useWeather) {
    try {
      const byHour = await hourlyForecast(now);
      const w = weatherAt(byHour, next.starts_at);
      const verdict = worthShowing(w);
      weather = w && { ...w, show: verdict.show, reason: verdict.reason };
    } catch (e) {
      weather = { error: e.message };
    }
  }

  let following = null;
  if (next === schedule[0]) {
    const nextExam = deadlines.find(
      (d) => d.kind === 'exam' && d.starts_at >= next.starts_at && d.external_id !== next.external_id,
    );
    if (nextExam && (!schedule[1] || nextExam.starts_at < schedule[1].starts_at)) {
      following = nextExam;
    } else {
      following =
        schedule[1] ??
        deadlines.find((d) => d.starts_at >= next.starts_at && d.external_id !== next.external_id) ??
        null;
    }
  } else {
    following = deadlines[1] ?? null;
  }

  const source = await store.rows('timeline_event', { where: 'source_id = ?', params: [next.source_id], limit: 1 });
  return {
    id: 'next_commitment',
    type: 'next_commitment',
    priority: 100,
    ...envelope(source.length ? source : [next], { now, cadenceMs: 15 * MIN }),
    source_id: next.source_id,
    data: {
      title: next.title,
      subtitle: next.subtitle ?? '',
      kind: next.kind,
      location: next.location ?? '',
      starts_at: next.starts_at,
      ends_at: next.ends_at,
      all_day: Boolean(next.all_day),
      weather,
      following: following
        ? {
            title: following.title,
            kind: following.kind,
            location: following.location ?? '',
            starts_at: following.starts_at,
            ends_at: following.ends_at,
            all_day: Boolean(following.all_day),
          }
        : null,
    },
  };
}

export function significant(item = {}) {
  return (
    item.kind === 'exam' ||
    /\b(group deliverable|major assignment|process task|project|midterm|final exam|report|presentation)\b/i.test(item.title ?? '')
  );
}

function getWeekInfo(epochMs, timezone = config.timezone) {
  const d = new Date(epochMs);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, day] = formatter.format(d).split('-').map(Number);
  const weekdayStr = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(d);
  const dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const diff = dayMap[weekdayStr] ?? 0;
  const monDate = new Date(Date.UTC(y, m - 1, day - diff));
  const monYear = monDate.getUTCFullYear();
  const monMonth = monDate.getUTCMonth();
  const monDay = monDate.getUTCDate();
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(monYear, monMonth, monDay)));
  const label = `Week of ${monthName} ${monDay}`;
  return { label, week_start: Date.UTC(monYear, monMonth, monDay) };
}

/** Card 2: what is due. Count plus nearest, grouped by course, seven day window. Opens, Due, Ahead. */
export function dueSoonCard(store, { now = Date.now() } = {}) {
  const horizon = now + 120 * DAY;
  return maybePromise(
    store.rows('timeline_event', {
      where: 'source_id = ? AND starts_at BETWEEN ? AND ?',
      params: ['uw-learn-ics', now - 5 * MIN, horizon],
      limit: 500,
      orderBy: 'starts_at',
    }),
    (rawRows) => {
      const rows = (rawRows || []).slice().sort((a, b) => a.starts_at - b.starts_at);

      const enriched = rows.map((d) => {
        const ctx = taskContext({ title: d.title, location: d.location, description: d.description });
        const course = ctx.course || courseOf(d.title, d.location);
        const phase = phaseOf(d.title);
        const gs = groupScope(d.title);
        const isSig = significant({ kind: d.kind, title: d.title });
        return {
          course,
          item: {
            title: d.title,
            starts_at: d.starts_at,
            course,
            ...(d.kind ? { kind: d.kind } : {}),
            ...(ctx.url ? { url: ctx.url } : {}),
            ...(ctx.place ? { location: ctx.place } : {}),
            ...(ctx.body ? { description: ctx.body.slice(0, 1500) } : {}),
            ...(ctx.links.length ? { links: ctx.links } : {}),
            ...(d.uid ? { uid: d.uid } : {}),
            occurrence_id: d.external_id,
            phase,
            all_day: Boolean(d.all_day),
            significant: isSig,
            group_scope: { section: gs.section, groups: gs.groups },
          },
        };
      });

      const due = enriched
        .map((e) => e.item)
        .filter((i) => i.phase === 'due' && i.starts_at <= now + 7 * DAY);

      const opens = enriched
        .map((e) => e.item)
        .filter((i) => i.phase === 'opens' && i.starts_at <= now + 7 * DAY)
        .map((item) => ({
          ...item,
          description: undefined,
          links: [],
        }));

      const candidateMajors = enriched
        .map((e) => e.item)
        .filter((i) => i.phase === 'due' && i.significant && i.starts_at > now + 3 * DAY);

      const nextMajorItem = candidateMajors[0] ?? null;
      const next_major = nextMajorItem
        ? { title: nextMajorItem.title, course: nextMajorItem.course, starts_at: nextMajorItem.starts_at }
        : null;

      const aheadItems = candidateMajors.slice(0, 24);
      const weekGroups = new Map();
      for (const item of aheadItems) {
        const { label, week_start } = getWeekInfo(item.starts_at, config.timezone);
        if (!weekGroups.has(week_start)) {
          weekGroups.set(week_start, { week_start, label, items: [] });
        }
        weekGroups.get(week_start).items.push({
          ...item,
          description: undefined,
          links: [],
        });
      }
      const ahead = [...weekGroups.values()].sort((a, b) => a.week_start - b.week_start);

      const byCourse = new Map();
      for (const item of due) {
        const c = item.course ?? 'Other';
        if (!byCourse.has(c)) byCourse.set(c, []);
        byCourse.get(c).push(item);
      }

      return maybePromise(
        sourceHealth(store, 'uw-learn-ics', 15 * MIN, now),
        (health) => {
          if (!rows.length && !health.ok) {
            return {
              id: 'due_soon',
              type: 'due_soon',
              priority: 90,
              state: health.state,
              observed_at: null,
              valid_until: null,
              source_id: 'uw-learn-ics',
              data: {
                count: 0,
                nearest_at: null,
                window_days: 7,
                items: [],
                courses: [],
                due: [],
                opens: [],
                ahead: [],
                next_major: null,
                error: health.error,
              },
            };
          }

          const env = envelope(rows, { now, cadenceMs: 15 * MIN });
          return {
            id: 'due_soon',
            type: 'due_soon',
            priority: 90,
            ...env,
            source_id: 'uw-learn-ics',
            data: {
              count: due.length,
              nearest_at: due[0]?.starts_at ?? null,
              window_days: 7,
              items: due,
              courses: [...byCourse.entries()].map(([course, items]) => ({ course, count: items.length, items: items.slice(0, 3) })),
              due,
              opens,
              ahead,
              next_major,
            },
          };
        },
      );
    },
  );
}

const COURSE_RE = /^([A-Z]{2,6}\s?\d{2,3}[A-Z]?)\b/;

export function courseOf(title, location = '') {
  const m = COURSE_RE.exec(title ?? '');
  if (m) return m[1].toUpperCase();
  if (/(?:^|[\s\b])(?:CFE|r[ée]sum[ée]|resume)(?:[\s\b]|$)/i.test(title ?? '') || /\bCFE\b/i.test(location ?? '')) return 'CFE';
  return 'Other';
}

/**
 * Card 3: food. Pinned outlets always render; unpinned ones only when they are serving today.
 *
 * Honest limitation, stated rather than hidden: the daily menu page carries no reliable hours, so
 * this card says "serving today" (dishes present) and not "open right now". Real open/closed needs
 * the locations-and-hours page, which is slice 2 work.
 */
export function foodCard(store, { now = Date.now(), date = null } = {}) {
  return maybePromise(
    store.rows('menu_item', { where: 'service_date = ?', params: [date ?? todayLocal(now)], limit: 500 }),
    (rows) => {
      const byOutlet = new Map();
      for (const r of rows || []) {
        const key = r.outlet;
        if (!byOutlet.has(key)) byOutlet.set(key, []);
        byOutlet.get(key).push(r);
      }

      return maybePromise(
        sourceHealth(store, 'uw-food-daily-menu', 12 * HOUR, now),
        (health) => {
          if (!rows.length && !health.ok) {
            return {
              id: 'food',
              type: 'food',
              priority: 80,
              state: health.state,
              observed_at: null,
              valid_until: null,
              source_id: 'uw-food-daily-menu',
              data: {
                service_date: date ?? todayLocal(now),
                pinned: config.pinnedOutlets.map((name) => ({
                  outlet: name,
                  pinned: true,
                  serving: false,
                  dish_count: 0,
                  dishes: [],
                  hidden_dishes: 0,
                })),
                others: [],
                others_count: 0,
                total_dishes: 0,
                error: health.error,
              },
            };
          }

          const pinned = config.pinnedOutlets.map((name) => {
            const dishes = byOutlet.get(name) ?? [];
            return {
              outlet: name,
              pinned: true,
              serving: dishes.length > 0,
              dish_count: dishes.length,
              dishes: dishes.slice(0, 6).map((d) => ({ dish: d.dish, diet: d.diet ?? [], url: d.url ?? '' })),
              hidden_dishes: Math.max(0, dishes.length - 6),
            };
          });

          const unpinned = [...byOutlet.entries()]
            .filter(([name]) => !config.pinnedOutlets.includes(name))
            .map(([name, dishes]) => ({ outlet: name, pinned: false, serving: true, dish_count: dishes.length }));

          const env = envelope(rows, { now, cadenceMs: 12 * HOUR });
          return {
            id: 'food',
            type: 'food',
            priority: 80,
            ...env,
            source_id: 'uw-food-daily-menu',
            data: {
              service_date: date ?? todayLocal(now),
              pinned,
              others: unpinned,
              others_count: unpinned.length,
              total_dishes: rows.length,
            },
          };
        },
      );
    },
  );
}

/**
 * Alert slot: usually invisible, because an empty slot renders zero height, not a green card.
 *
 * Silence has two meanings here: nothing is wrong, or nobody looked. The run record is the only
 * thing that separates them. Keep the last incident visible when polling stops, with its age
 * state showing that it is stale. A successful all-clear run tombstones the incident immediately.
 */
export function alertCard(store, { now = Date.now() } = {}) {
  return maybePromise(
    store.rows('notice', { where: 'source_id = ?', params: [STATUS_SOURCE], limit: 20 }),
    (rawNotices) => {
      const notices = (rawNotices || [])
        .filter((n) => config.alertSeverities.includes(n.severity))
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

      return maybePromise(store.getSetting(ALERT_SUMMARY_SETTING), (summaryRaw) => maybePromise(store.getSetting(ALERT_DISMISSED_SETTING), (dismissedKey) => maybePromise(
        store.lastRunPerSource(),
        (runs) => {
          const run = (runs || []).find((r) => r.source_id === STATUS_SOURCE) ?? null;
          const checkedAt = run?.finished_at ?? null;

          if (!notices.length) {
            return maybePromise(
              sourceHealth(store, STATUS_SOURCE, STATUS_CADENCE_MS, now),
              (health) => {
                const state = !health.ok && health.state === 'failed'
                  ? 'failed'
                  : checkedAt == null ? 'empty' : ageState(checkedAt, STATUS_CADENCE_MS, now);
                return {
                  id: 'alert',
                  type: 'alert',
                  priority: 95,
                  state,
                  observed_at: checkedAt,
                  valid_until: checkedAt == null ? null : checkedAt + STATUS_CADENCE_MS,
                  source_id: STATUS_SOURCE,
                  data: { count: 0, checked_at: checkedAt, notices: [], summary: '', key: '', dismissed: false },
                };
              },
            );
          }

          const env = envelope(notices, { now, cadenceMs: STATUS_CADENCE_MS });
          return {
            id: 'alert',
            type: 'alert',
            priority: 95,
            ...env,
            source_id: STATUS_SOURCE,
            data: {
              count: notices.length,
              checked_at: checkedAt ?? env.observed_at,
              summary: alertSummaryFor(notices, summaryRaw),
              key: alertIdentity(notices),
              dismissed: dismissedKey === alertIdentity(notices),
              notices: notices.map((n) => ({ severity: n.severity, title: n.title, body: n.body ?? '', components: n.components ?? [], incident_status: n.incident_status ?? '', url: n.url ?? '' })),
            },
          };
        },
      )));
    },
  );
}

/** The alert slot is the status source's card, so it uses the status source's own cadence. */
const STATUS_SOURCE = 'uw-status';
const STATUS_CADENCE_MS = MIN;

/** The schedule feed, whatever URL it points at: the Portal export or a Google Calendar secret. */
const SCHEDULE_SOURCE = 'uw-portal-ics';

function severityRank(s) {
  return { info: 0, minor: 1, major: 2, critical: 3, credential: 4 }[s] ?? 0;
}

function todayLocal(now) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(now))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

export async function buildDashboard(store, { now = Date.now(), useWeather = true } = {}) {
  const cards = (await Promise.all([
    alertCard(store, { now }),
    nextCommitmentCard(store, { now, useWeather }),
    dueSoonCard(store, { now }),
    foodCard(store, { now }),
  ])).map((card) => ({ ...card, data: validateCardData(card.type, card.data) }));
  return buildBundle(cards, now);
}
