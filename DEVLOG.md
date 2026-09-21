# Development Log (DEVLOG)

Chronological record of architectural changes, technical decisions, benchmarks, and feature milestones.

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

### 9. Verification & Test Metrics
- **Unit & Integration Tests**: 63/63 passing tests (`node --test`).
- **Typecheck**: `npm run web:typecheck` passed with 0 errors.
- **Bundle Build**: `npm run web:build` succeeded in 3.37s.
- **Runtime Sanity**: Verified `http://127.0.0.1:8787/v1/dashboard` returns live bundle with active origin `from: 'Last class (PSE)'`, `walk: 0`, and future deadlines starting today at 4:30 PM.
