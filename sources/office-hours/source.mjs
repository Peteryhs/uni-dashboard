/**
 * Source: user-office-hours
 *
 * Expands saved user office hours rules into canonical timeline_event rows.
 * Inherits the standard source machinery: sliding freshness window, tombstoning,
 * receipts, and circuit breaker.
 */
import { OfficeHoursConfig } from '#contract/office-hours.mjs';
import { expandRecurrence, zonedToEpoch } from '#sources/ics/parse.mjs';
import { config as appConfig } from '../../apps/relay/src/config.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_TZ = appConfig.timezone || 'America/Toronto';

/**
 * Expand a single office hour rule into concrete occurrence intervals across [windowStart, windowEnd].
 * Handles DST shifts correctly by delegating local date calculations to zonedToEpoch.
 */
export function expandRuleOccurrences(rule, {
  windowStart,
  windowEnd,
  tz = DEFAULT_TZ,
  maxPerEvent = 400,
  now = Date.now(),
} = {}) {
  const [sh, sm] = (rule.start_local || '00:00').split(':').map(Number);
  const [eh, em] = (rule.end_local || '00:00').split(':').map(Number);

  let eventStart;
  let eventEnd;

  if (rule.starts_on) {
    const [sy, smo, sd] = rule.starts_on.split('-').map(Number);
    eventStart = zonedToEpoch(sy, smo, sd, sh, sm, 0, tz);
    // If end is earlier than start on same day (e.g. invalid), ensure duration is at least 1h
    const sameDayEnd = zonedToEpoch(sy, smo, sd, eh, em, 0, tz);
    eventEnd = sameDayEnd > eventStart ? sameDayEnd : eventStart + HOUR_MS;
  } else {
    // Anchor to 7 days before windowStart to ensure all window dates are generated
    const anchorMs = (windowStart ?? now) - 7 * DAY_MS;
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const [ay, amo, ad] = fmt.format(new Date(anchorMs)).split('-').map(Number);
    eventStart = zonedToEpoch(ay, amo, ad, sh, sm, 0, tz);
    const sameDayEnd = zonedToEpoch(ay, amo, ad, eh, em, 0, tz);
    eventEnd = sameDayEnd > eventStart ? sameDayEnd : eventStart + HOUR_MS;
  }

  let untilStr;
  if (rule.until) {
    untilStr = rule.until.replace(/-/g, '') + 'T235959';
  } else {
    const defaultUntilMs = (now ?? Date.now()) + 120 * DAY_MS;
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    untilStr = fmt.format(new Date(defaultUntilMs)).replace(/-/g, '') + 'T235959';
  }

  const bydayList = Array.isArray(rule.byday) && rule.byday.length > 0 ? rule.byday : ['MO'];
  const rrule = `FREQ=WEEKLY;BYDAY=${bydayList.join(',')};UNTIL=${untilStr}`;

  const syntheticEvent = {
    uid: `office-hours-${rule.id || 'preview'}`,
    start: eventStart,
    end: eventEnd,
    rrule,
  };

  return expandRecurrence(syntheticEvent, {
    windowStart: windowStart ?? (now - 12 * HOUR_MS),
    windowEnd: windowEnd ?? (now + 60 * DAY_MS),
    tz,
    maxPerEvent,
  });
}

/**
 * Generate up to `count` concrete occurrence previews across an array of draft/saved rules.
 */
export function buildPreviewOccurrences(rules, {
  now = Date.now(),
  tz = DEFAULT_TZ,
  count = 6,
} = {}) {
  const windowStart = now;
  const windowEnd = now + 60 * DAY_MS;
  const allOccurrences = [];

  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
    const rule = rules[ruleIndex];
    const occurrences = expandRuleOccurrences(rule, {
      windowStart,
      windowEnd,
      tz,
      now,
    });

    for (const occ of occurrences) {
      allOccurrences.push({
        rule_index: ruleIndex,
        starts_at: occ.start,
        ends_at: occ.end,
        label: rule.course ? `${rule.course} · ${rule.label}` : rule.label,
        location: rule.location || '',
      });
    }
  }

  allOccurrences.sort((a, b) => a.starts_at - b.starts_at);
  return allOccurrences.slice(0, count);
}

export const userOfficeHours = {
  id: 'user-office-hours',
  shape: 'timeline_event',
  role: 'office-hours',
  cadenceMs: 6 * HOUR_MS,
  needsSecret: false,
  windowDays: 60,
  tombstoneOnEmpty: true,

  async fetchRaw(ctx) {
    let body = '{"rules":[],"version":1}';
    if (ctx?.store?.getSetting) {
      const stored = await ctx.store.getSetting('OFFICE_HOURS_JSON');
      if (typeof stored === 'string' && stored.trim()) {
        body = stored;
      }
    }
    const bytes = new TextEncoder().encode(body).length;
    return {
      status: 200,
      contentType: 'application/json',
      body,
      bytes,
    };
  },

  plausible(raw) {
    if (!raw || typeof raw.body !== 'string') {
      return { ok: false, reason: 'missing body' };
    }
    try {
      const json = JSON.parse(raw.body);
      const parsed = OfficeHoursConfig.safeParse(json);
      if (!parsed.success) {
        return { ok: false, reason: 'stored office hours config is invalid' };
      }
      return { ok: true, reason: '' };
    } catch {
      return { ok: false, reason: 'stored office hours config is invalid' };
    }
  },

  parse(raw, ctx = {}) {
    const now = ctx.now ?? Date.now();
    const tz = appConfig.timezone || DEFAULT_TZ;
    const windowStart = now - 12 * HOUR_MS;
    const windowEnd = now + 60 * DAY_MS;

    const config = OfficeHoursConfig.parse(JSON.parse(raw.body));
    const rows = [];
    const dateFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    for (const rule of config.rules) {
      const occurrences = expandRuleOccurrences(rule, {
        windowStart,
        windowEnd,
        tz,
        now,
      });

      for (const occ of occurrences) {
        const isoDate = dateFmt.format(new Date(occ.start));
        rows.push({
          source_id: 'user-office-hours',
          external_id: `office-hours-${rule.id}#${isoDate}`,
          uid: `office-hours-${rule.id}`,
          observed_at: now,
          valid_until: now + DAY_MS,
          kind: 'office_hours',
          title: rule.course ? `${rule.course} · ${rule.label}` : rule.label,
          subtitle: rule.host || '',
          location: rule.location || '',
          all_day: false,
          starts_at: occ.start,
          ends_at: occ.end,
          url: '',
          description: rule.notes || '',
        });
      }
    }

    return {
      rows,
      meta: {
        rules_count: config.rules.length,
        occurrences_count: rows.length,
      },
    };
  },
};

export default userOfficeHours;
