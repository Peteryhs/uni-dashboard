/**
 * MCP tool surface: read-only queries over the data this dashboard already collected and ranked.
 *
 * Three rules shape this file:
 *   - Every tool delegates to the builder the /v1 route uses. An agent must never be able to
 *     describe a deadline, a menu or a ranking the web app would contradict.
 *   - No tool polls a source, starts an AI job, or writes a row. A tool call therefore spends D1
 *     reads only; that keeps it inside a Worker's per-invocation query and CPU budget, and it makes
 *     the endpoint safe to hand to an unattended client.
 *   - Inputs are zod schemas, and the same schema generates the MCP `inputSchema`. One declaration
 *     means a documented argument and a validated argument cannot drift apart.
 */
import { z } from 'zod';
import { buildDashboard, alertCard } from '../cards.mjs';
import { calendarOptions, buildCalendar } from '../calendar.mjs';
import { buildRecommendations } from '../recommendations.mjs';
import { getCachedWeather } from '../weather-cache.mjs';
import { getFoodRecommendation } from '../food-recommendation.mjs';
import { studySpacesCard } from '../study-spaces.mjs';
import { buildHealth } from '../health.mjs';
import { buildMenuView } from '../guidance-api.mjs';
import { SOURCES } from '#sources/registry.mjs';
import { config } from '../config.mjs';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');
const LIMIT = z.number().int().min(1).max(100);
const SECTION = z.number().int().min(1).max(999);
const GROUP = z.number().int().min(1).max(999);

const RECOMMENDATION_KINDS = ['class', 'task', 'learning', 'office_hours', 'focus', 'conflict', 'food', 'weather', 'change'];

/** Campus day, so "today's menu" is the Waterloo day rather than the Worker's UTC date. */
const CAMPUS_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * z.toJSONSchema emits the draft-2020-12 dialect marker and, in input mode, omits `required` for
 * fields that have a default. MCP clients run the schema through a range of validators, so the
 * marker is dropped: the remaining object is plain, portable JSON Schema.
 */
function inputSchema(schema) {
  const { $schema, ...portable } = z.toJSONSchema(schema, { io: 'input' });
  return portable;
}

/** Wrong tool arguments are a protocol error, not a tool result: the client should not retry. */
export class ToolInputError extends Error {}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Escape LIKE metacharacters so a search for "100%" cannot become "anything". */
function likePattern(query) {
  return `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

const TOOLS = [
  {
    name: 'get_dashboard',
    title: 'Dashboard overview',
    description:
      'The same ranked card bundle the web dashboard renders: alerts, next commitment, due-soon work, ' +
      'dining and study spaces, ordered by server-computed priority. Each card carries its own ' +
      'freshness envelope (observed_at, valid_until, state). Start here for "what needs attention".',
    schema: z.object({}),
    annotations: READ_ONLY,
    async handler(_args, { store, now }) {
      return buildDashboard(store, { now });
    },
  },
  {
    name: 'list_recommendations',
    title: 'Ranked recommendations',
    description:
      'Ranked, explainable recommendations (tasks, classes, conflicts, food and schedule changes) ' +
      'with the reason and evidence behind each item and its place in the ranking. Optionally filter ' +
      'to one section/group or one kind. Read-only: this never runs the ranking job or changes an action.',
    schema: z.object({
      section: SECTION.optional().describe('Tutorial section number, when the timetable is sectioned'),
      group: GROUP.optional().describe('Tutorial group number, when the timetable is grouped'),
      kind: z.enum(RECOMMENDATION_KINDS).optional().describe('Keep only items of this kind'),
      include_diagnostics: z.boolean().default(false).describe('Include the server ranking trace'),
      limit: LIMIT.default(20).describe('Maximum items to return, highest priority first'),
    }),
    annotations: READ_ONLY,
    async handler(args, { store, now }) {
      const weather = await getCachedWeather(store, { now });
      const feed = await buildRecommendations(store, {
        now,
        section: args.section ?? null,
        group: args.group ?? null,
        weather,
      });
      const filtered = args.kind ? feed.items.filter((item) => item.kind === args.kind) : feed.items;
      const tasks = args.kind
        ? { large: [], small: [] }
        : {
            large: feed.tasks.large.slice(0, args.limit),
            small: feed.tasks.small.slice(0, args.limit),
          };
      return {
        generated_at: feed.generated_at,
        timezone: feed.timezone,
        refresh_after_ms: feed.refresh_after_ms,
        headline: feed.headline,
        total_items: filtered.length,
        items: filtered.slice(0, args.limit),
        tasks,
        warnings: feed.warnings,
        ...(args.include_diagnostics && feed.diagnostics ? { diagnostics: feed.diagnostics } : {}),
      };
    },
  },
  {
    name: 'get_calendar',
    title: 'Unified calendar',
    description:
      'Classes, exams, LEARN deadlines, reviewed syllabus dates and office hours for a date window, ' +
      'grouped by day and time-ordered. Times are epoch milliseconds; dates are America/Toronto.',
    schema: z.object({
      start: DATE.optional().describe('First day (YYYY-MM-DD). Defaults to today in Toronto'),
      days: z.number().int().min(1).max(31).default(7).describe('Number of days, 1-31'),
      section: SECTION.optional().describe('Filter to a tutorial section'),
      group: GROUP.optional().describe('Filter to a tutorial group'),
      include_syllabus: z.boolean().default(true).describe('Include reviewed syllabus entries'),
    }),
    annotations: READ_ONLY,
    async handler(args, { store, now }) {
      const search = new URLSearchParams();
      if (args.start) search.set('start', args.start);
      search.set('days', String(args.days));
      if (args.section != null) search.set('section', String(args.section));
      if (args.group != null) search.set('group', String(args.group));
      let options;
      try {
        options = calendarOptions(search, now);
      } catch (error) {
        throw new ToolInputError(error.message);
      }
      return buildCalendar(store, { ...options, now, includeSyllabus: args.include_syllabus });
    },
  },
  {
    name: 'get_menu',
    title: 'Posted dining menu',
    description:
      'Dishes posted for a service date, with outlet, station, dietary tags and allergens. Falls back ' +
      'to the most recent earlier posting when nothing is posted for the requested date (the response ' +
      'says which date it actually describes). A posted menu does not prove an outlet is open.',
    schema: z.object({
      date: DATE.optional().describe('Service date (YYYY-MM-DD). Defaults to today in Toronto'),
    }),
    annotations: READ_ONLY,
    async handler(args, { store, now }) {
      return buildMenuView(store, { date: args.date ?? null, now });
    },
  },
  {
    name: 'get_food_recommendation',
    title: 'Saved dining ranking',
    description:
      'The personalized dining ranking already saved for a date, including the ranking status. Read-only: ' +
      'it never runs the AI ranking job. status "pending" means no ranking exists yet for that date.',
    schema: z.object({
      date: DATE.optional().describe('Service date (YYYY-MM-DD). Defaults to the saved current ranking'),
    }),
    annotations: READ_ONLY,
    async handler(args, { store }) {
      return getFoodRecommendation(store, args.date ?? '');
    },
  },
  {
    name: 'get_study_spaces',
    title: 'Live study-space occupancy',
    description:
      'Live library and floor occupancy from the Waitz feed, including the floor with the most room, ' +
      'per-library open state and counts. Carries its freshness state; "dead" means stop trusting the numbers.',
    schema: z.object({}),
    annotations: READ_ONLY,
    async handler(_args, { store, now }) {
      return studySpacesCard(store, { now });
    },
  },
  {
    name: 'get_service_status',
    title: 'Campus service status',
    description:
      'UW service incidents and notices as the alert card shows them, plus the stored notice rows. ' +
      'Severities are info, minor, major, critical and credential.',
    schema: z.object({
      include_all_severities: z.boolean().default(false).describe('Include info-level notices the alert card hides'),
    }),
    annotations: READ_ONLY,
    async handler(args, { store, now }) {
      const card = await alertCard(store, { now });
      const stored = (await store.rows('notice', { limit: 50 }))
        .filter((row) => row.source_id === 'uw-status')
        .filter((row) => args.include_all_severities || config.alertSeverities.includes(row.severity));
      return {
        card,
        notices: stored.map((row) => ({
          severity: row.severity,
          scope: row.scope ?? '',
          title: row.title ?? '',
          body: row.body ?? '',
          url: row.url ?? '',
          observed_at: row.observed_at,
          valid_until: row.valid_until,
        })),
      };
    },
  },
  {
    name: 'get_weather',
    title: 'Cached weather',
    description:
      'Cached hourly forecast for Waterloo with the current-hour temperature. The dashboard never calls ' +
      'the weather provider on a read, so this is the same saved snapshot the app shows.',
    schema: z.object({
      hours: z.number().int().min(1).max(48).default(12).describe('Forecast hours to return'),
    }),
    annotations: READ_ONLY,
    async handler(args, { store, now }) {
      const weather = await getCachedWeather(store, { now });
      const hours = (weather?.forecast || []).filter((row) => row.at >= now - 3_600_000).slice(0, args.hours);
      const current = (weather?.forecast || []).filter((row) => row.at <= now).at(-1) ?? hours[0] ?? null;
      return {
        state: weather?.state ?? 'unavailable',
        observed_at: weather?.observed_at ?? null,
        current_temp_c: Number.isFinite(current?.temp_c) ? Math.round(current.temp_c) : null,
        forecast: hours,
      };
    },
  },
  {
    name: 'get_source_health',
    title: 'Collection health',
    description:
      'Per-source collection status: readiness, last successful update, freshness, failure condition, ' +
      'next scheduled attempt and the health summary. Use it before trusting an empty result.',
    schema: z.object({}),
    annotations: READ_ONLY,
    async handler(_args, { store, now, runtime }) {
      return buildHealth(store, { sources: SOURCES, now, runtime });
    },
  },
  {
    name: 'search_stored_items',
    title: 'Search stored items',
    description:
      'Text search over rows already stored: upcoming/recent calendar events, the posted menu for today ' +
      'or the most recent earlier posting, and service notices. Case-insensitive substring match on the ' +
      'human-readable fields. This searches the database directly, not the ranked layer; use ' +
      'list_recommendations for priority ordering.',
    schema: z.object({
      query: z.string().trim().min(2).max(120).describe('Substring to look for, at least 2 characters'),
      kinds: z
        .array(z.enum(['events', 'menu', 'notices']))
        .min(1)
        .default(['events', 'menu', 'notices'])
        .describe('Which stored shapes to search'),
      limit: LIMIT.default(20).describe('Maximum rows per kind'),
    }),
    annotations: READ_ONLY,
    async handler(args, { store, now }) {
      const like = likePattern(args.query);
      const result = { query: args.query, kinds: args.kinds, events: [], menu: [], notices: [] };
      if (args.kinds.includes('events')) {
        const rows = await store.rows('timeline_event', {
          where: `(title LIKE ? ESCAPE '\\' OR subtitle LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR kind LIKE ? ESCAPE '\\') AND starts_at >= ?`,
          params: [like, like, like, like, now - 14 * 86_400_000],
          orderBy: 'starts_at',
          limit: args.limit,
        });
        result.events = rows.map((row) => ({
          source_id: row.source_id,
          kind: row.kind,
          title: row.title,
          subtitle: row.subtitle ?? '',
          location: row.location ?? '',
          all_day: row.all_day,
          starts_at: row.starts_at,
          ends_at: row.ends_at,
          url: row.url ?? '',
          observed_at: row.observed_at,
          valid_until: row.valid_until,
        }));
      }
      if (args.kinds.includes('menu')) {
        // The food source pre-posts tomorrow's menu, so "latest" must mean latest on or before the
        // campus day. A plain MAX(service_date) returns tomorrow and makes today's dish unsearchable.
        const today = CAMPUS_DATE.format(new Date(now));
        const rows = await store.rows('menu_item', {
          where: `(dish LIKE ? ESCAPE '\\' OR outlet LIKE ? ESCAPE '\\' OR station LIKE ? ESCAPE '\\') AND service_date = (SELECT MAX(service_date) FROM menu_item WHERE deleted=0 AND service_date <= ?)`,
          params: [like, like, like, today],
          limit: args.limit,
        });
        result.menu = rows.map((row) => ({
          outlet: row.outlet,
          station: row.station,
          dish: row.dish,
          diet: row.diet ?? [],
          allergens: row.allergens ?? [],
          service_date: row.service_date,
          url: row.url ?? '',
          observed_at: row.observed_at,
        }));
      }
      if (args.kinds.includes('notices')) {
        const rows = await store.rows('notice', {
          where: `(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR scope LIKE ? ESCAPE '\\')`,
          params: [like, like, like],
          limit: args.limit,
        });
        result.notices = rows.map((row) => ({
          source_id: row.source_id,
          severity: row.severity,
          scope: row.scope ?? '',
          title: row.title ?? '',
          body: row.body ?? '',
          url: row.url ?? '',
          observed_at: row.observed_at,
        }));
      }
      return result;
    },
  },
];

/**
 * The wire-facing tool list.
 *
 * Generated lazily and memoised per isolate: `zod → JSON Schema` costs a few milliseconds, which is
 * a real fraction of a Workers Free invocation's 10 ms CPU budget, and only `tools/list` needs the
 * schemas. A `tools/call` never pays for them. `annotations` are advisory hints; MCP clients may
 * show a read-only badge and skip a confirmation prompt, but the guarantee comes from this file
 * having no write path.
 */
let wireTools = null;

export function mcpTools() {
  if (!wireTools) {
    wireTools = TOOLS.map(({ name, title, description, schema, annotations }) => ({
      name,
      title,
      description,
      inputSchema: inputSchema(schema),
      annotations,
    }));
  }
  return wireTools;
}

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

/**
 * Validate and run one tool. Throws ToolInputError for a bad name or bad arguments (the protocol
 * layer turns that into -32602) and lets every other error surface as a tool execution error so the
 * model can read the message instead of the connection dying.
 */
export async function callTool(name, args, ctx) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new ToolInputError(`Unknown tool "${name}". Available tools: ${TOOL_NAMES.join(', ')}`);
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    throw new ToolInputError(`Invalid arguments for ${name}: ${where}${issue.message}`);
  }
  return tool.handler(parsed.data, ctx);
}
