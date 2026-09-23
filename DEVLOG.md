# Development Log (DEVLOG)

**This file is a mirror.** The source of truth is the vault note
`Documents/Uni Dashboard/Dev Log.md` (LiveSync, both machines). Edit there, then copy down here, or
the two will disagree within a week, which is exactly what happened to the walk-time table: this
file claimed a measured number that was never measured.

Chronological record of architectural changes, technical decisions, benchmarks, and feature milestones.

---
## 2026-09-23 — Unified calendar, course guidance, and recommendation preview

The backend now serves one calendar for classes, LEARN deadlines and exams, office hours, custom events, and reviewed syllabus content. It deduplicates events, handles Toronto dates and recurring ICS changes, and keeps source freshness visible. The existing UI continues to work and has a unified calendar view.

Course imports now filter navigation and library clutter from pasted LEARN home pages while retaining useful announcements, calendar events, and resource links. Syllabus text, copied tables, and HTML can be previewed and reviewed before saving; optional Workers AI extraction requires explicit opt-in and source evidence. Scanned PDFs still need OCR.

The backend recommendation feed (`/v1/recommendations`) ranks current and upcoming classes, due work, quizzes, office hours, syllabus topics and readings, food, weather, focus windows, and conflicts. It distinguishes larger and smaller tasks, includes action links and evidence, and stores done/undo/snooze actions. A temporary development-only page at `/recommendations-preview.html` shows the feed with a Toronto date picker and 15-minute time slider. The local preview route recalculates priorities at the selected time while reporting actual source freshness; the production build excludes the preview page.

Backend reliability work includes background dining AI after a new menu arrives, short asynchronous alert summaries with dismissal, clearer outage details, weather caching, source backoff, a shared daily Workers AI budget, and bounded scheduled polling. The simulated day exposed a remaining relevance gap: some broad university administrative dates can still appear as personal tasks. Missing course syllabi also limit topic and quiz coverage.

Verification: 200/200 tests passed with `node --test --test-isolation=none`; the web production build and Worker bundle passed. The local preview and time slider were exercised against the running dev server. No Cloudflare deployment was made.

---
## 2026-09-23 — Office hours AI extraction, schedule management & date-filtered daily menu

133 tests, up from 116.

**Office hours from unstructured text (SPEC-office-hours shipped):**
Piazza posts, course announcements, and syllabi state office hours in natural language ("Mon & Wed 2:00-3:00pm in E7 3416, starting next week through Dec 5"). A student needs these as recurring timetable events, but manual entry across multiple courses has high friction, and blind AI insertion risks phantom events.
- **Contract & Architecture**: `packages/contract/src/office-hours.mjs` defines `OfficeHourRule` and `OfficeHoursConfig`. Registered a dedicated user source adapter (`sources/office-hours/source.mjs`, id `user-office-hours`, kind `office_hours`).
- **AI Structured Extraction**: `apps/relay/src/ai.mjs` extracts rules with schema validation and one-shot self-correction retry. Returns a 502 with the model's raw string if invalid.
- **Strict Storage Isolation**: AI generation is strictly draft-only. Only explicit user saving via `PUT /v1/office-hours` writes to `OFFICE_HOURS_JSON` in the store. Zero AI hallucinations reach the database unconfirmed.
- **Card Isolation**: Events carry `kind: 'office_hours'`, ensuring they never hijack the `next_commitment` hero countdown or pollute `due_soon` deadlines.
- **Settings Schedule Tab**: Added 4th tab to the customization sheet in `apps/web/src/components/schedule-tab.tsx`. Supports pasting text, model selection, live draft review with editable fields, concrete first-occurrence date previews across DST boundaries, inline edit/delete of saved rules, and non-blocking undo toast notifications.
- **Legacy SQLite Migration**: Added automatic `setting` table migration in `SqliteStore` to handle legacy `(key, value_json)` columns dynamically.

**Daily Menu date filter precision:**
- Waterloo Food Services supports direct server-side date filtering via `https://uwaterloo.ca/food-services/daily-menu?date=YYYY-MM-DD`.
- Updated `sources/food/source.mjs` to always pass today's Toronto service date (`todayInToronto(now)`). Avoids stale landing page cache or waiting for Drupal CMS morning rollover.
- Added external link icon in the Food Card header linking directly to Waterloo's filtered daily menu.
- Updated `tools/fetch-fixtures.mjs` to fetch date-parameterized fixtures.

**Deadlines card polish & density refinements:**
- Opens vs Due separation: urgent work receives distinct priority colouring while content opening dates are rendered muted.
- Filtered out administrative noise (NFA hold dates, tuition refund deadlines) and deduplicated out-of-scope group variations.
- Inline task descriptions clamped to 20 words max with click-to-expand. Empty descriptions omitted.
- Upcoming commitments and upcoming events separated into dedicated horizontal cards in both Detailed and Compact views, with a secondary preview for the following commitment.
- One-click dismissal with in-session undo toast for calendar items in compact view.

**Verification**:
- 133/133 tests pass in `node --test` (~750ms).
- `npm run web:typecheck` and `npm run web:build` pass with zero errors.
- Verified live poll against Waterloo Food Services (21 dishes loaded) and office hours persistence.

---


## 2026-09-22: the Cloudflare Worker port, and the free tier that shaped it

### What was added

| File | Role |
|---|---|
| `wrangler.toml` | Worker, `[assets]` from `apps/web/dist`, D1 binding `DB`, AI binding `AI`, cron `*/15 * * * *` |
| `apps/relay/src/worker.mjs` | `fetch` + `scheduled` handlers; the same routes as the Node relay |
| `apps/relay/src/d1-store.mjs` | D1 adapter, same storage contract as `SqliteStore` |
| `apps/relay/src/schema.mjs` | table shapes, DDL, row converters, shared by both adapters |

The relay was already written for two targets, so the port is an adapter plus an entrypoint, not a
rewrite. `cards.mjs` now goes through a `maybePromise` helper: with `SqliteStore` every card builder
returns its object synchronously exactly as before, and with `D1Store` the same code returns a
promise. The runner awaits its store calls, which is a no-op for the synchronous adapter.

### Four platform facts, each found by running it

1. **D1 `exec()` runs one statement per line.** The shared DDL wraps `CREATE TABLE` across lines, so
   it arrived truncated (`incomplete input: SQLITE_ERROR`). The schema is now prepared statement by
   statement and run as one `batch()`, and a test asserts `exec()` is never used for it.
2. **The Worker bundle must resolve no `node:` module.** It was resolving four: `node:sqlite` via the
   storage import, `node:crypto` and `node:fs` via the AI module (a cache key and a dev cache file),
   and `node:fs/promises` via the ICS fixture path. Fixed by moving the pure schema into
   `schema.mjs`, reaching optional Node builtins through `process.getBuiltinModule`, and building the
   fixture specifier at runtime so no bundler folds it back into a static import. The built bundle
   now contains zero `node:` specifiers, checked by grepping it.
3. **`env.AI` has no local emulation.** `wrangler dev` tries a remote proxy session for it, which
   needs credentials, so local development runs a config without the AI binding. The AI route then
   fails loudly with "credentials not configured", which is the honest behaviour and is now a test.
4. **The free tier caps D1 queries at 50 per invocation.** All four sources in one tick measured 54,
   over the ceiling. Three changes came out of that number: the cron polls two sources per tick and
   reports the rest as `deferred`; the schema is created behind a single `sqlite_master` probe
   instead of ten `CREATE` statements per fresh isolate; and rows are written in multi-row `VALUES`
   statements (21 dishes went from 21 queries to 3). Worst measured tick is now 38.

Two smaller ones on the read side: the run receipt log is pruned to 7 days, because unbounded growth
turns the latest-run-per-source query into a full table scan on every dashboard load, and a body
already in `raw_snapshot` is never gzipped twice.

### Also fixed on the way through

- `cards.mjs` passed database nulls straight into card payloads, so a row with no `url`, `subtitle`,
  `location` or `all_day` failed contract validation and took the whole bundle down with it. The D1
  end-to-end test is what surfaced it; the Node tests had always seeded those fields.
- The model picker offered `@cf/zhipu/glm-4.7-flash`. The live Workers AI catalogue has it under
  `@cf/zai-org/glm-4.7-flash`, so that entry would have failed on selection.

### Verified

99/99 tests under `TZ=America/Toronto` and `TZ=UTC`. The Worker was run locally against a real D1 and
the live feeds: `/healthz`, `/v1/dashboard`, `/v1/health/sources`, `/v1/poll`, `/v1/credentials`,
`/v1/ai/models`, the SPA fallback, the 404 route list, and the `scheduled` handler. The poll wrote 21
dishes from the live menu page and 1 notice from live `status.json`; both unconfigured token feeds
reported `skipped` and their cards rendered `degraded` rather than an empty schedule. The bundle
builds with all three bindings (`wrangler deploy --dry-run`).

Not verified: the AI route on a deployed Worker, which needs the account.

---

## 2026-09-22 (later): credentials from the app, stored in D1

The Worker shipped without a way to configure it: no `.env` file exists on Cloudflare, and the app's
sources panel POSTs to `/v1/credentials`, which returned 501 on purpose. Worker secrets in the
dashboard were the only path, which is fine for the owner and useless for the "one-click for other
people" target in DEPLOYMENT.md.

Now the panel works on the Worker. Values are rows in a `setting` table, applied to `process.env` at
the start of every request and every cron tick, which is where the adapters already read config. The
code changed in four places: the table, two adapter methods, `applySettings` in the Worker, and the
credentials route. Nothing downstream knows where the value came from.

Rules, because this route writes environment variables from an HTTP request:

- validated before storage: feed URLs must be `https` with no whitespace, tokens must be
  alphanumeric with `-` and `_`. A newline in a feed URL would have smuggled a second variable.
- never echoed back: the GET reports `configured` and the source (`saved in the app`, `Worker
  secret`, `not set`), and a test asserts the URL appears nowhere in the response.
- a value saved in the app beats a Worker secret, and `RELAY_TOKEN` can be one of them, so settings
  are applied *before* the token check. A token set from the UI gates the very next request.
- an empty string clears a setting, same as the local `.env` path.

**The bug that only a live run could find:** `D1Store.init()` probed for one known table (`job`) and
skipped the DDL when it existed. That is fine on a fresh database and wrong on every deployed one:
the new `setting` table never got created, and `/v1/credentials` returned 500 against the dev
database that already had the old schema. The probe now compares the full expected table list against
`sqlite_master`, so an existing database self-heals when a table is added. Three tests cover it:
fresh database runs the DDL, complete database pays nothing, database missing one table runs it again.

104 tests. Verified live on the local Worker: save two feed URLs, watch `uw-learn-ics` flip to
`ready`, confirm the URL never comes back out of the API, reject `http://` and a newline injection,
set `RELAY_TOKEN` from the API and watch the next unauthenticated request get 401, then clear
everything. The client needed no change: its panel already POSTs to that route.

---

## 2026-09-21: v0.2.0 - Antislop Cleansing, Dynamic Routing & Dashboard Refinement

### 1. Context & Motivation
Following the initial v0.1 relay engine build, the web dashboard underwent extensive design audits, user testing, and integration with live Waterloo feeds. Multiple issues were identified:
- Cluttered visual presentation with generic AI aesthetic patterns (uncontrolled glow, excessive glassmorphism blur, round pill buttons).
- Unbalanced desktop grid layout where a full-width outage card split Next Commitment and Upcoming Deadlines across separate lines.
- Freshness counters updating by the second, introducing visual noise.
- Walk times hardcoded from REV. (Superseded: the walk feature was removed entirely, see the correction below.)
- Expired deadlines from previous days/hours rendering in "Upcoming Deadlines".
- Need for credential and secret hygiene prior to integrating generative AI.

### 2. Antislop & Visual Craftsmanship Overhaul
- **Skill Engine Installed**: Integrated all 6 `anti-slop` skills (`antislop`, `antislop-ui`, `antislop-human`, `antislop-layoutmobile`, `antislop-copywriting`, `antislop-code`).
- **Contrast Compliance (WCAG AA)**:
  - Eliminated dimmed opacities (`opacity-60`, `opacity-70`).
  - Switched canvas to high-contrast dark grey palette: background `oklch(0.20 0.006 265)` (~`#18181b`), elevated cards `oklch(0.24 0.008 265)` (~`#23242a`).
  - Primary text (`#f4f4f5`) achieves 18:1 contrast; secondary text (`#a1a1aa`) achieves 7.72:1 contrast (verified via `contrast-check.py`).
- **Tone & Typography**:
  - Removed all em dashes (`—`) across UI copy and code comments.
  - Inter with tabular numbers (`tabular-nums`) across countdowns, timestamps, and row counts.
  - Border radius reduced to `--radius: 0.375rem` (6px) with crisp `rounded-md` / `rounded-lg` containers. Badges converted from pill shapes (`rounded-full`) to crisp rectangular tags (`rounded-md`).
- **Focus Rings**: Explicit visible keyboard navigation rings (`focus-visible:ring-2 focus-visible:ring-live`) on every interactive control.

### 3. Layout & Card Hierarchy
- **Primary Commitment Row**: Combined **Next Commitment** and **Upcoming Deadlines** side-by-side into a 2-column responsive layout (`grid grid-cols-1 lg:grid-cols-2`), ensuring they share a single horizontal line on desktop without staggered whitespace.
- **Compact Outage Box**: Replaced the previous 12-column heavy card banner with a slim, single-line alert banner (`px-3.5 py-2.5 rounded-md`) positioned cleanly above the cards grid.
- **Freshness in Minutes**: Changed `shortAge()` in `apps/web/src/lib/time.ts` to output `< 1m`, `1m`, `2m` instead of tracking seconds, calming the UI.

### 4. Dynamic Walking Route & Navigation
- **Origin Resolution**: Updated `nextCommitmentCard` in `apps/relay/src/cards.mjs` to check the student's class timetable for the latest prior class today. If present, the origin building is set to that class's location (e.g. `PSE 5353` -> `from_building = 'PSE'`, `from_source = 'Last class (PSE)'`). Defaults to home dorm (`REV`) if it is the first class of the day.
- **Pedestrian Routing Engine**:
  - Added building GPS coordinate mapping for 35+ Waterloo buildings in `apps/relay/src/config.mjs`.
  - Implemented `calculateWalkMinutes()`: queries OpenStreetMap's foot router (`routed-foot`) with an in-memory cache and 1.8s timeout, with automatic fallback to Haversine footpath geometry / static campus tables.
- **Google Maps Navigation Link**: Embedded direct walking directions (`nav_url`) into `NextCommitmentCard` via a clickable badge (`🧭 {walk_minutes} min walk ↗`).

### 5. Expired Deadlines Fix
- **Issue**: `dueSoonCard` in `apps/relay/src/cards.mjs` was querying `starts_at BETWEEN now - DAY AND horizon`. Sorting ascending placed expired assignments from yesterday at the top of the list and marked `Nearest: 13h 46m ago`.
- **Fix**: Updated query parameters to `starts_at BETWEEN now AND horizon` (`starts_at >= now`).
- **Client Defense**: Filtered `item.starts_at >= now` in `DueSoonCard` and `QuickGlanceHUD` to ensure zero past events can be displayed.

### 6. Secrets & Generative AI Security Architecture
- **Credential Storage**: Confirmed `.env`, `.env.*`, and `.env*.local` are git-ignored.
- **API Leak Prevention**: Sanitized `/v1/credentials` endpoint in `apps/relay/src/server.mjs` to return only boolean configuration status without echoing URL substrings or query parameters.
- **GenAI Proxy Design**: Created `.env.example` documenting that upcoming LLM keys (`GEMINI_API_KEY`, etc.) remain exclusively on the backend relay server (`process.env.GEMINI_API_KEY`). The web client communicates through backend proxy endpoints (e.g. `POST /v1/ai/...`), preventing browser bundle extraction.

### 7. Correction: the walk feature and the walk table are gone (2026-09-21)

Removed on the owner's call: he commutes by bus, so "leave by" was a number nobody acted on.

What also came out, and why it needed to: this log called the walk time "static" without saying
where the numbers came from, and the code comment called the table "written once by hand". Neither
was true. The table was written in the first build session from nothing, and it implies anything
from 3.5 to 6.8 km/h depending on the pair, which no pedestrian does over these routes. Checked
against the OSM foot router it was wrong in both directions: it ranked REV to MC (the closest of
the twelve pairs) worst, and REV to E7 (the farthest) as a mid-length walk.

Removed in one piece: the table, the building coordinate set, the OSM foot routing call, the
Haversine fallback, room-to-building parsing, the Google Maps nav link, and the walk_minutes,
leave_by, from_building, from_location, from_source and nav_url fields on the next commitment
card. What survives is what, where and when, plus the weather join on the class hour.

### 8. antislop moved out of the repo

The six antislop skills arrived committed in three places at once (`.agents/skills`,
`.claude/skills`, `agent/skills`) plus two agent entry files (`AGENTS.md`, `GEMINI.md`), all of it
tool-specific instruction files sitting in the project tree. Removed: 26 files, 6,313 lines. They
now live once, as Hermes skills (`~/.hermes/skills/creative/antislop*`), where they load when a
design task needs them instead of being duplicated per agent tool.

`DESIGN.md` stays in the repo on purpose: that is this project's direction, and the filter reads it.

### 9. Review pass: four fixes before the Worker port

Full note in the vault log. All four verified by running them: menu rows carried no date in their
identity, so a poll for a second day tombstoned the first day's 19 rows (fixed in the key and in the
tombstone scope); a page saying "no daily menu for this date" was reported as a source failure and
would have tripped the circuit on a closed week; the alert card read "all clear" five minutes after
the last status poll while status.json still said major; and no fetch was bounded, so one hung socket
stalled the whole poll loop. 61 tests to 66.

### 10. Verification & Test Metrics
- **Unit & Integration Tests**: 66/66 passing tests (`node --test`), under both
  `TZ=America/Toronto` and `TZ=UTC`. It was 63/63 in this commit; the count moved as fixes landed.
- **Typecheck**: `npm run web:typecheck` passed with 0 errors.
- **Bundle Build**: `npm run web:build` succeeded in 3.37s.
- **Runtime Sanity**: Verified `http://127.0.0.1:8787/v1/dashboard` returns live bundle with active origin `from: 'Last class (PSE)'`, `walk: 0`, and future deadlines starting today at 4:30 PM.

---

## 2026-09-22 (later still): the task detail panel, and two cards corrected by live data

**What the LEARN feed actually carries.** Read from the live feed: 179 events, 84 of them ahead of
today. 65 put the course in `LOCATION` ("ECE 198 - Fall 2026"), 63 carry the task's links inside
`DESCRIPTION` as text, and **zero** carry an iCalendar `URL` property. That last number is the whole
reason clicking a deadline did nothing: the adapter read `event.url`, which is always empty.

- `task-context.mjs` turns a description into course, links and body. Links are ranked, so the
  dropbox or quiz button comes before the generic "View event" one, and the body is the prose with
  the `Dropbox:` / `View event -` plumbing stripped out.
- `TimelineEvent` now declares `description`. Zod strips undeclared keys, which is how the field was
  disappearing at the write boundary while every parser test passed.
- Clicking a deadline row opens a full-width panel below the commitments row: course and links at the
  top, the feed's own instructions underneath. Only the key is stored, so a refetch that drops the
  task closes the panel instead of showing a deadline that no longer exists.

**Two corrections that only showed up in use**, both from the owner:

1. **Deadlines are one chronological list.** Grouping by course answered "what does this course want"
   when the question is "what is next". The server sends `items` in time order; the course chip stays
   on every row; the grouping survives only for counts and for older clients.
2. **The hero card belongs to the schedule feed.** It took the soonest of class or deadline, and
   LEARN carries 84 upcoming events against a handful of classes, so a term date or a quiz opening
   replaced the countdown to the next class. The schedule feed wins now, and a deadline takes the
   hero slot only when nothing is scheduled ahead.

**One bug found while wiring it:** the flat list was built from raw database rows while the grouped
list used enriched items, so a `null` url reached the contract and the whole bundle was rejected.
Both lists come from a single enrichment pass now.

116 tests. Verification limit, stated because it matters: the browser tool refuses localhost and
hermes-dedicated has no Chromium, so the panel was verified by payload, typecheck and build, and then
by the owner clicking it. Nobody has screenshotted it from this side.

---

## 2026-09-21: v0.3.0 - Zero-Fake-Data Enforcement, Cloudflare Workers AI Dining Advisor & Density View Architecture

### 1. Zero Fake Data & Stale Fallback Elimination
- Eliminated placeholder/mock data when source fetches fail. If a feed (Portal schedule, LEARN deadlines, Food services) fails and has no recent valid fetch in cache, cards transition explicitly to `failed` or `degraded` contract states instead of rendering misleading "nothing scheduled" or placeholder text.
- Contract schemas (`card-data.mjs`, `contract.ts`) updated with explicit error payloads and verified against strict contract rules.

### 2. Cloudflare Workers AI Dining Advisor
- Integrated Cloudflare Workers AI via REST proxy in `apps/relay/src/ai.mjs`, supporting multiple models (`@cf/google/gemma-4-26b-a4b-it`, `llama-3.3-70b`, `qwen`, `glm-4.7`, `deepseek-r1`).
- Enforced a strict 5-word maximum on dish recommendation reasons (`rankDailyMenu` clamps word count to 5 words max).
- Implemented robust multi-layer caching:
  - Backend persistent cache (`.ai-cache.json`) keyed by date, model, and normalized user taste profile.
  - Client-side `localStorage` cache with instant TTL checks to eliminate redundant LLM invocations on page refresh.
- Comprehensive test suite added in `test/ai-ranking.test.mjs`, expanding test coverage from 66 to 79 passing tests.

### 3. Food Customization Sheet UX Polish
- Reorganized taste tags in `customization-sheet.tsx`: removed category splitters and placed simple, actionable pills directly below the taste prompt textarea for frictionless selection (`[High Protein]`, `[Mild Spice]`, `[Quick Meal]`, `[Low Carb]`).

### 4. Information Density Architecture: Detailed vs. Compact View
- Added segmented view switcher (`[Detailed | Compact]`) in the header.
- Designed **Compact View** specifically around **reduced information density** (lowering cognitive load and visual noise rather than squishing elements into cramped grids):
  - **Next Commitment**: Omitted secondary lecture subtitles and weather advisory pill; displays solely Title, Countdown, Time, and Location.
  - **Upcoming Deadlines**: Collapsed multi-course grouped boxes into a single flat list of the top 3 imminent deadlines across all courses (`[CS 444] A2 Checkpoint · In 18h`) with a subtle count indicator for remaining items.
  - **Daily Food**: Replaced large 100px+ AI card with a 1-line top-pick summary banner; hid exploratory controls (dish search bar, Location Guide directory button); suppressed per-outlet AI verdict paragraphs; removed dish-level AI highlight pills to keep rows minimal; clamped dishes to top 3 per dining hall; hid secondary campus locations and verbose footer.
  - **Detailed View**: Preserved full exploratory depth with weather breakdowns, course-grouped deadlines, full AI advice and reasoning tips, global dish search, campus location guide, and complete menus.

### 5. Reactive State Synchronization Fix (`useSyncExternalStore`)
- **Bug**: `usePreferences()` previously used component-local `useState`, causing each card (`NextCommitmentCard`, `DueSoonCard`, `FoodCard`, `CardShell`) to hold an isolated state instance. Toggling density in the header only updated `App.tsx` (adjusting container margins/spacing) while the cards remained locked in whichever state was initialized from `localStorage`.
- **Fix**: Rebuilt `preferences-store.ts` with React 19's `useSyncExternalStore` and a module-level singleton store, ensuring instantaneous cross-component and cross-tab synchronization whenever view density or preferences change.

### 6. Verification & Test Metrics
- **Unit & Integration Tests**: 79/79 passing tests (`npm test` in ~280ms).
- **Web Build**: `npm run web:build` succeeds cleanly in ~3.0s.
- **Relay Runtime**: Running smoothly with real live Waterloo feeds (`uw-portal-ics`, `uw-learn-ics`, `uw-status`, `uw-food-daily-menu`).

