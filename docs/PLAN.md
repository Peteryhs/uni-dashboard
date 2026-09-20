---
type: plan
status: proposed
written: 2026-09-20
inputs: GOALS.md, PLAN_BRIEF.md, research/Live Data Sources.md
---

# Uni Dashboard — the plan

One system. A website and an Android app. A server that does all the thinking, and two
thin clients that do all the showing.

Confidence is marked inline where I am not certain. Version numbers are the latest I know
of; pin whatever is current on the day work starts.

---

## 1. Shape of the system

Five parts. Nothing else.

```
  outside world                 the system                        you
  ───────────────────────────────────────────────────────────────────────────
  Portal ICS  ┐
  LEARN ICS   │
  GRT RT/GTFS │      ┌───────────┐      ┌──────────┐      ┌─────────────┐
  Waitz       ├─────▶│ collector │─────▶│ Postgres │◀─────│     api     │
  Food HTML   │      └───────────┘      └──────────┘      └──────┬──────┘
  status.json │       schedules,         truth and             /v1/dashboard
  Open-Meteo  │       fetches,           history               /v1/stream
  UW Flow     │       parses,                                     │
  Warrior     ┘       normalises                          ┌───────┴───────┐
                                                          │               │
                                                       ┌──▼──┐       ┌────▼────┐
                                                       │ web │       │ android │
                                                       │ PWA │       │ +widget │
                                                       └─────┘       └─────────┘
```

**collector** — one long-running Node process. Owns every conversation with the outside
world: scheduling, TLS quirks, retries, backoff, circuit breaking, raw snapshot archiving,
parsing, and normalising into canonical rows. It holds the only copies of the two secret
token URLs. Nothing else in the system knows a source exists.

**Postgres 17** — owns truth and history. Canonical tables plus a raw snapshot archive.
History is not optional: it is what makes sparklines, staleness and offline parser repair
possible.

**api** — one Fastify service. Owns the client contract. Reads Postgres, computes derived
values (leave-by, next commitment, priority order), shapes cards, serves one bundle
endpoint plus an SSE stream, and fans out push. It never talks to a source.

**web** — React PWA. Owns the wide layout and the entire admin/debug surface.

**android** — Kotlin/Compose app with a Glance home-screen widget. Owns the glance that
needs no app open, and timely notifications.

Boundaries, named: source→collector is HTTP plus per-adapter parsing. collector→Postgres
is the canonical schema, enforced by Zod at the adapter boundary and by database
constraints. Postgres→api is SQL, and only api may read it. api→clients is the versioned
card contract over HTTPS. No client ever reaches a source. No source shape ever reaches a
client.

### Why this shape

Because the constraints force it, not because it is fashionable. Three facts from the
research decide it: the two most valuable feeds are secret URLs, most of these endpoints
will not send CORS headers, and GRT's TLS handshake fails on default stacks. A client
cannot hold a secret, cannot bypass CORS, and cannot fix a cipher list on a phone. So
there is a server. Once there is a server, everything else belongs behind it.

**Rejected alternative 1: clients fetch sources directly.** The obvious cheap answer, and
wrong. The token URLs would ship inside an APK and a JS bundle — an APK is a zip, so that
is a published credential. CORS blocks `uwaterloo.ca`, `warrior.uwaterloo.ca` and most of
Tier 2 outright (confidence: high for the Drupal pages, medium for Waitz — confirm with a
browser `fetch` from a non-UW origin). GRT ships protobuf, so you write and maintain two
decoders. Every device multiplies the poll rate against undocumented rate limits that
return 429. And you get no history, so no trends and no offline parser repair.

**Rejected alternative 2: one serverless function per source.** Sounds modular. In
practice each new source becomes an infrastructure change — a new deploy target, a new
schedule, a new secret binding — which is exactly the cost Peter said must stay low. There
is no shared contract, so ten sources drift into ten shapes. And Cloudflare Workers
specifically cannot fetch GRT, because they expose no TLS cipher control (see §2 and §9).

**Rejected alternative 3: a Next.js app that fetches live on request.** Then page load is
as slow as the slowest source, a UW outage renders a blank dashboard instead of a
40-second-old one, there is no history, and there is nothing for the Android app to talk
to except a server rendering HTML. Also: no SSR need exists here. One authenticated user,
no SEO.

Cost of my shape: a single box, a single point of failure, and one more process than
strictly necessary. Accepted — see §7.

---

## 2. The contract

### The canonical model (collector → Postgres)

Five shapes. Every source maps onto one or more of them, or it does not get built.

| Table | Holds | Key fields |
|---|---|---|
| `timeline_event` | anything with a time: classes, exams, deadlines, WUSA events, gym drop-in sessions, outlet open windows | `kind`, `title`, `subtitle`, `location_name`, `starts_at`, `ends_at`, `all_day`, `url` |
| `place_state` | anything with an open/busy state now: library floors, gym facilities, outlets, campus | `place_id`, `parent_place_id`, `is_open`, `people`, `capacity`, `occupancy_pct` |
| `departure` | one predicted or scheduled bus at one stop | `stop_id`, `route`, `headsign`, `scheduled_at`, `predicted_at`, `is_realtime`, `trip_id` |
| `menu_item` | one dish at one station at one outlet on one day | `outlet`, `station`, `dish`, `external_id`, `diet[]`, `allergens[]`, `service_date` |
| `notice` | status, alerts, incidents, credential problems | `severity`, `scope`, `title`, `body`, `starts_at`, `url` |

Plus `metric(name, place_id, at, value)` — a generic numeric series, so occupancy and
temperature history cost nothing extra.

Plus two infrastructure tables: `source_run(source_id, started_at, finished_at, outcome,
http_status, bytes, rows_written, error, body_sha256)` and `raw_snapshot(source_id,
fetched_at, sha256, content_type, body_gz)` deduplicated on `sha256`.

Every canonical row carries four columns that are not negotiable: `source_id`,
`external_id`, `observed_at`, `valid_until`.

### The client contract (api → clients)

One bundle, one stream.

```
GET /v1/dashboard
{
  "schema_version": 1,
  "min_client_version": 3,
  "generated_at": "2026-09-20T23:14:02Z",
  "cards": [
    { "id": "next_commitment", "type": "next_commitment", "priority": 100,
      "observed_at": "2026-09-20T23:12:41Z", "valid_until": "2026-09-20T23:27:41Z",
      "state": "live",
      "data": { "title": "ECE 150 LEC 001", "location": "E7 2317",
                "starts_at": "2026-09-20T23:56:00Z", "leave_by": "2026-09-20T23:38:00Z" } }
  ]
}
```

`GET /v1/stream` — SSE, card-shaped patches, web only, only while the tab is visible.
`POST /v1/devices` — register an FCM token.
`GET /v1/health/sources` — per-source last run, outcome, age, circuit state. Admin only.

Clients hold a registry `card.type → renderer`. An unknown type is skipped silently and
counted. Layout order is `priority`, computed server-side and time-aware, so both clients
reorder identically without a release.

### Where it is enforced

Zod schemas in a shared `contract` package are the single source of truth. Three
generations come out of them: TypeScript types for api and web directly, an OpenAPI 3.1
document via `zod-to-openapi`, and Kotlin data classes via `openapi-generator` into the
Android module. A contract change that breaks a client is therefore a compile error in CI,
not a runtime surprise in a lecture hall.

Two more gates. Golden JSON fixtures — one per card type, committed — are parsed in both
web and Android unit tests, so a field rename fails the Android build. And every adapter
validates its parsed output against the canonical Zod schema before a write, so a bad
parse fails loudly in the collector instead of quietly in the UI.

### When producer and consumer disagree

Rules, in order:

1. Additive only within a `schema_version`. New fields are optional. Clients ignore
   unknown fields and unknown card types.
2. Removing or retyping a field requires a `schema_version` bump, and the api serves both
   versions until the app is updated. Path-versioned, `/v1` and `/v2` side by side.
3. `min_client_version` in every bundle. If the client is below it, the client shows one
   banner — "app out of date, some cards hidden" — and renders what it does understand.
   One honest banner beats five broken cards.
4. A card the api cannot build is still sent, with `state: "empty"` or `"degraded"` and
   the last known `observed_at`. Absence is a state, not a missing key.

### The one thing that, if wrong, makes everything else painful

**Every value carries its own observation time and expiry, and the store never
overwrites history.**

Not the framework choice. Not the database. This. If `observed_at` and `valid_until` are
not on every canonical row and every card from the first commit, then: the staleness UI in
§5 cannot be built, because the client has nothing to compute age from; caching has no
basis for deciding what is safe to show offline; "looks alive" degrades into an animation
that lies, because you animate on fetch rather than on change; and retrofitting it means
touching every adapter, every query and both clients at once.

Second order, same idea: upsert on `(source_id, external_id)`, never truncate-and-reload.
A source that returns a partial page must not delete your timetable. Rows absent from the
latest run are tombstoned, and **only if that run passed its plausibility check** (§6).

---

## 3. Extensibility, in practice

### What a new source is

One file, one line, one fixture.

```ts
// collector/src/sources/waitz.ts
export const waitz: Source = {
  id: 'waitz',
  cadence: everyMinutes(2, { onlyWhen: anyLibraryOpen }),
  fetch: (ctx) => ctx.http.get('https://waitz.io/live/waterloo'),
  plausible: (raw) => raw.json.length > 0 && raw.json.every(l => 'capacity' in l),
  parse: (raw, at) => raw.json.flatMap(loc => [
    placeState({ place_id: `waitz:${loc.id}`, name: loc.name, ... , observed_at: at,
                 valid_until: at.plus({ minutes: 6 }) }),
    ...loc.subLocs.map(f => placeState({ parent_place_id: `waitz:${loc.id}`, ... })),
  ]),
};
```

Files touched: `collector/src/sources/waitz.ts` (new), `collector/src/sources/index.ts`
(one line in the registry), `collector/test/fixtures/waitz/2026-09-20.json` (real captured
bytes), `collector/test/sources/waitz.test.ts` (parse the fixture, assert rows). A
migration only if the source needs a canonical shape that does not exist. The api does not
change. The clients do not change. The contract does not change.

That is the whole claim: **a new source that maps to an existing shape is invisible to
everything downstream.** Adding Region of Waterloo road closures, or GO Transit, or a
second dining hall, is a half-day of parser work and a test.

### What a new feature is

A new card. Four files.

1. `contract/src/cards/gym.ts` — the Zod schema for its `data`. Generates everything else.
2. `api/src/cards/gym.ts` — one function: canonical rows in, card out, plus a priority
   rule.
3. `web/src/cards/GymCard.tsx` — a renderer, registered by type.
4. `android/.../cards/GymCard.kt` — the same, in Compose.

Two of the four are UI, which is the irreducible cost of having two clients. Nothing about
scheduling, transport, caching, staleness or offline is touched — a card inherits all of
that from the shell.

Reordering the dashboard, or making food outrank the library at 11:00, is a change to one
priority function on the server. No release on either client.

### Where this leaks — arguing against myself

**The `payload jsonb` escape hatch will be abused.** The five canonical shapes will not
fit something. Waitz is a two-level hierarchy; menus are a three-level tree; a road
closure is a geometry. The honest answer is `payload jsonb` for source-specific extras,
and the moment two cards read keys out of that jsonb, part of the contract is untyped and
the compile-time guarantee is gone. Mitigation is discipline, not architecture: anything a
card reads must be promoted to a typed column. Expect to promote three or four columns in
the first year.

**Server-driven priority buys less than it looks.** It reorders. It cannot make a card
that needs a genuinely new layout, and the first time a card needs a map or a chart you
ship client code anyway. Priority is worth keeping because time-of-day ordering is real
value, but do not grow it into a layout engine.

**The single collector process breaks at around 12–15 sources.** One slow scrape — the
289 KB food menu page, or a GRT timeout — blocks the loop. The fix is a per-source
concurrency-limited work queue rather than a shared loop, and it is cheap enough that I
would build it in phase 4 rather than wait for the pain. Postgres `SKIP LOCKED` on a
`job` table, no Redis.

**The single `/v1/dashboard` bundle breaks at around 20 card types.** Payload size and
query fan-out both grow. The fix then is `?cards=` selection plus per-card ETags. Not
before.

**The real wall is a source that needs a different runtime.** The day Peter wants
something session-gated, the adapter needs a headless browser, and a headless browser does
not belong in the collector process. That is where the "one file" story ends and you add a
second worker. I am fine with that wall because §11 rejects session-gated sources anyway.

---

## 4. Website and Android app from day one

Both are real. Neither is a wrapper. The app is not an afterthought — it is the primary
surface, because the moments this thing is useful are walking to class and standing on
Columbia in the rain, and both are phone moments.

### The native app is the right call, and here is the proof

The single highest-value interaction in this product is **a glance that opens nothing**.
The state of my uni life, readable in seconds, means readable on the home screen. On
Android that is an App Widget, built with Jetpack Glance. A PWA cannot provide a home
screen widget — no API exists (confidence: high). That alone decides it.

Two supporting reasons. Timely notification: "leave in 4 minutes" is worthless delivered
late, and a PWA's service-worker push on Android requires Chrome installed and awake, with
delivery that is best-effort (confidence: medium-high — the underlying transport is FCM
either way, but a web push cannot use an exact alarm to fire a local reminder, and a
native app can). And genuinely offline-first storage: Room with a WorkManager sync is
robust to the process being killed in a way that IndexedDB behind a service worker in a
backgrounded tab is not.

So: Kotlin 2.0, Compose, Glance widget, Room, WorkManager, Ktor client with
kotlinx-serialization, minSdk 28, targetSdk 35.

### How they stay in step

They share the contract, not the code. One generated model set per platform from one Zod
source. The same golden fixtures in both test suites. The same card-type registry
convention. The same server-computed priority order, so the two screens agree on what
matters without either one knowing why.

They deliberately do **not** share a UI toolkit. §11 rejects Kotlin Multiplaform, Flutter
and React Native for this project: the logic worth sharing is already on the server by
design, so a cross-platform toolkit would be sharing a few hundred lines of view code at
the price of a second build system and worse platform fit on both sides.

Drift control: `X-Client-Version` on every request, `min_client_version` in every response,
and a weekly CI job that runs the generated Kotlin models against the live api's OpenAPI
document.

### What each one gets that the other cannot

**Android only.** The home-screen widget — 2×2 showing next commitment and leave-by, 4×2
adding today's strip. Notifications, and only two of them in v1 (leave-now, credential
expired). True offline via Room, present on cold start with no network. Optionally a
quick-settings tile later.

**Web only.** The wide multi-panel layout at ≥1280 px, where three columns genuinely help
because glanceability on a desk means seeing everything at once. And the entire admin and
debug surface: per-source health, force a poll, view and diff raw snapshots, replay a
parser against an archived snapshot, paste a rotated token URL. That surface is the reason
the collector's archive exists, and putting it on web only means the Android app needs no
write paths at all in v1 — a real simplification.

---

## 5. Glanceability and looking alive

### The first screen

Phone portrait, above the fold, four things. Nothing else earns the space.

1. **Next commitment.** One hero line. "ECE 150 · E7 2317 · in 42 min". Class or deadline,
   whichever is sooner, since the question is "what is next", not "what class is next".
   When transit is involved, the leave-by time folds into this line.
2. **Leave-by.** "13 Laurelwood · 7 min · walk 5 · leave 18:22". One route, the best one.
   Not a departure board.
3. **Today's strip.** A horizontal 12-hour bar. Blocks for classes, ticks for deadlines, a
   needle at now. This is the only thing on the first screen that is a picture, and it
   earns it: shape is faster to read than a list.
4. **Alert slot.** Empty almost always. Occupied only when campus status is not normal, IT
   status is not operational, or a credential has expired. An empty slot renders as zero
   height, not as a green "all good" card. Green reassurance is noise.

Below the fold, in server-decided priority order: weather, library occupancy, today's
menu, gym, events. Priority is time-aware — food rises at 11:00, gym at 17:00, library at
19:00, transit on weekday mornings. That is information design doing work that decoration
cannot.

### Hierarchy and density

One hero number per card, maximum. Three-step type scale: hero 32/36, label 13 uppercase
tracked, body 15. Times under an hour are shown as minutes remaining, over an hour as
clock time, because "in 42 min" and "14:30 tomorrow" are the two useful framings and
nothing in between is. `font-variant-numeric: tabular-nums` everywhere a number ticks, so
counting down does not make the layout twitch.

Web: 12-column grid, one column under 640 px, two to 1024, three above 1280. Android:
single column, cards are full-bleed with 16 dp gutters.

No charts on the first screen. One exception anywhere: a 90-minute sparkline on library
occupancy, because "is it filling up" is a question a single number cannot answer.

### How the interface says "this data is 40 seconds old" without words

Each source declares its expected cadence. Age is measured against it, not against the
clock, so a four-minute-old menu is fresh and a four-minute-old bus prediction is not.

- **Heartbeat.** When a new observation lands, a 2-second highlight sweeps the card's 1 px
  top hairline. This fires on *change*, never on fetch, so a poll that returned identical
  bytes produces no motion. Motion therefore means information.
- **Value transitions.** 180 ms crossfade plus a 4 px rise, `cubic-bezier(.2,0,0,1)`. The
  eye is drawn to what changed.
- **The age ladder.** Within 1× cadence: hairline at full accent, numbers at full
  foreground. 1–3×: hairline fades toward 30%. Beyond 3×: numbers desaturate to the muted
  foreground, hairline goes amber and dashed, and all motion stops. Beyond 6× or a tripped
  circuit: muted numbers plus a small amber dot.
- **The exact number is available, never ambient.** Hover on web, long-press on Android,
  reveals "updated 40s ago · waitz". Precise ages on screen at all times are clutter; the
  ladder is the ambient channel.

One `setInterval(1000)` for the whole app drives ages through a CSS custom property. Not a
timer per card.

### Empty, stale, failed — three different things

- **Empty** is a fact: no classes today, no events this week, tomorrow's menu is not
  posted yet. Renders as quiet declarative text. Never as a spinner, never as an error.
  The research file is explicit that an empty future menu day is normal, so the food card's
  empty state is the common case, not an edge.
- **Stale** is the last known value plus the age ladder. Always show the data.
- **Failed** is the last known value plus a muted amber dot and a reason available on
  tap. Never a dialog, never a red screen, never a card that vanishes.

Skeletons appear only on genuine cold start — first launch, no cache. After that the app
always has something true to show, and a spinner drawn over stale data is a lie about not
having data.

### Dark mode and accessibility

Dark first, because this is used at night and in lecture halls. One OKLCH lightness ramp,
generated, so light mode is a reflection rather than a second design. One accent for live
data, amber for stale, red reserved exclusively for campus-closed and exam-within-the-hour
— if red appears for anything else it stops meaning anything.

4.5:1 contrast on all text including muted. State is never carried by colour alone: the
stale hairline is also dashed, the failed dot also has a shape. `prefers-reduced-motion`
and Android's animator-duration-scale of zero replace every animation with a literal age
string. Every card is a labelled landmark with a live region on the hero value, so a
screen reader announces changes once, not on every tick.

---

## 6. Freshness, failure and offline

### Cadence, per source

| Source | Cadence | Reasoning |
|---|---|---|
| Portal ICS | 15 min | changes on change; cheap; the backbone |
| LEARN ICS | 15 min | same |
| GRT `tripupdates/1` | 20 s when a watched departure is inside 45 min, else 5 min | 181 KB a poll. Blind 20 s polling is ~650 MB ingress a day. Gate it. |
| GRT `vehiclepositions/1` | only while a leave-by card is live | 8 KB, cheap, but only useful in the moment |
| GRT static GTFS | Mondays 03:00, skip if zip hash unchanged | 2.06 MB |
| Waitz | 2 min while any library is open | the value is the trend |
| LibCal hours | daily 04:00 | |
| Food daily menu | 07:15 and 14:30 | the research file measured exactly this posting behaviour |
| `status.uwaterloo.ca` | 60 s | tiny JSON, and it explains other failures |
| `uwaterloo.ca/campus-status` | 5 min, 60 s while not normal | 48 KB scrape |
| Open-Meteo | 15 min | matches its own model cadence |
| Warrior gym | 5 min while PAC open, 7 POSTs batched | 7 facility IDs, one request each |
| WUSA events | hourly | |
| UW Flow enrolment | 6 h, watched courses only | `updated_at` moves slowly |
| Open Data (schedules, exams, dates) | daily 04:30 | 429 with no published number. Cache hard. |

All cadences live in the source file, one line each, and are overridable by env for
debugging.

### Failure

Per source: exponential backoff with jitter, capped at 15 minutes. Five consecutive
failures trips a circuit breaker; the source goes `degraded`, its cards keep serving last
known values with age, and `/v1/health/sources` shows why. A tripped circuit retries at
the cap, so recovery is automatic.

**Semantic failure matters more than HTTP failure here**, and the research file hands us
two traps that must be code, not comments:

1. A 200 with `content-type: text/html` from an `.ics` or D2L path means *not
   authenticated*. A status-code-only check reads a login page as data. Every adapter
   therefore declares `plausible(raw)`, and the ICS adapters assert `text/calendar` plus a
   `BEGIN:VCALENDAR` prefix.
2. An empty future menu day is valid-empty. So `plausible` is per-source, and "zero rows"
   is a failure only where the adapter says it is.

The tombstone rule depends on this: rows missing from a run are soft-deleted **only** when
that run passed `plausible`. A login page can never delete your timetable.

### Token expiry

The two ICS feeds are the ones that matter and the ones that rotate. When either returns
401, or HTML, or a calendar with zero events where there were events yesterday, the
collector writes a `notice` with severity `credential`. That notice is one of only two
things allowed to send a push. It deep-links to the web admin page, which shows the
step-by-step re-copy instructions from the research file and a field to paste the new URL.
Expected recovery time: two minutes, once, whenever it happens.

Tokens live in the collector's environment or in a host secrets file. Never in Postgres in
plaintext, never in an api response, never in a log — the logger redacts on a prefix match
against known token substrings.

### Offline, which is the normal state

The design commitment: **everything on the first screen must be answerable from a bundle
fetched up to four hours ago.** That drives two decisions.

Recurrence is expanded server-side. The collector expands RRULEs into concrete
`timeline_event` rows for a rolling 60-day window, using the feed's own VTIMEZONE rather
than assuming America/Toronto (`ical.js` for this; it handles VTIMEZONE and
`RecurExpansion` properly — confidence: medium on ergonomics, high that hand-rolling
RRULE is a mistake). So the bundle carries today's and tomorrow's resolved events, and
"next class, in E7 2317, in 42 minutes" works in a basement with the radio off. The client
does arithmetic on cached data. It does not need the network to know what is next.

Scheduled departures ship in the bundle. For Peter's four stops, the next two hours of
*scheduled* GTFS times are included in every bundle. Offline, the leave-by card still
works, labelled "scheduled" rather than live, at lower confidence. Degraded transit beats
absent transit, and this is the difference between a dashboard and a website.

Android: Room is the source of truth for the UI. WorkManager periodic sync at 15 minutes —
Android's hard floor (confidence: high) — plus an expedited one-off sync when the widget is
tapped or the app is opened. The widget renders from Room, so it is never blank.

Web: Workbox service worker, app shell precached, stale-while-revalidate on the bundle
with the last good bundle in IndexedDB. Opening the PWA with no signal shows the last
state with the age ladder, not an error page.

What simply does not work offline, stated plainly: live bus predictions, live library
occupancy, gym counts, today's menu if it was never fetched. Those cards show their last
value and go stale. That is correct behaviour, not a gap.

---

## 7. Cost, honestly

At one user this is a zero-marginal-cost system if hardware already exists, and the
research file's mention of re-checks run on `hermes-dedicated` suggests it does.

| Item | Cost | Confidence |
|---|---|---|
| All UW sources, GRT, Waitz, status.json | $0, rate limits undocumented | high |
| UW Open Data v3 key | $0, free registration, 429 with no published number | high (from research) |
| Open-Meteo | $0 under a non-commercial free tier with a daily call cap around 10k | medium — confirm at open-meteo.com/en/pricing. We use ~96/day either way |
| FCM push | $0 at any plausible volume | high |
| Postgres on the same host | $0 | high |
| Hosting on existing hardware | $0 marginal | high |
| Hosting on a PaaS instead | roughly $3–6/mo for 256–512 MB plus a small volume | medium — Fly.io's free allowance ended in 2024 and pricing is now usage-based; confirm current rates |
| Cloudflare Tunnel or Tailscale for ingress | $0 for one user | high |
| Domain | ~$12/yr, optional | high |
| Google Play publishing | $25 one-time | high |
| GitHub Actions CI | $0 public, 2000 min/mo free on private | medium |

**The number that makes this cost money is storage of raw snapshots.** GRT tripupdates at
181 KB every 20 seconds is roughly 780 MB of raw bodies a day. Deduplicating on `sha256`,
gzipping, and keeping 14 days brings the whole archive to a few hundred megabytes.
Canonical rows are negligible — well under 50 MB a year. If you skip the dedup and keep
everything, you buy a disk within a month.

The second number is egress on a metered host, which only matters if you host the
collector somewhere that charges for ingress-heavy polling. On a box you own, it does not
apply.

**Where I trade money for reliability, said out loud:** one box, one Postgres, no
replication, no failover. If it dies, the dashboard is gone until you notice. I accept
that for a personal dashboard, and I would not accept it for anything with users. Nightly
`pg_dump` to a second location is $0 and is the one piece of insurance worth taking.
Managed Postgres free tiers are a false economy here — Supabase pauses free projects after
about a week of inactivity (confidence: medium) and any hosted database adds a network hop
to every card query for no benefit at this size.

The real cost of this project is not money. It is about 10 hours a week for five weeks.

---

## 8. Sequencing

Estimates assume part-time work, roughly 10–12 hours a week. Each phase ends in something
demonstrable.

**Phase 0 — answer the five unknowns. Half a day, no code.**
Do exactly the five signed-in checks at the end of the research file. Copy the Portal iCal
URL and the LEARN feed URL into a password manager. Open both in a private window with no
cookies and confirm ICS renders. Note which of the eight courses have due dates. Register
an Open Data key and call `/v3/ClassSchedules/1269/ECE/150`. This blocks phase 1's scope
and is the highest-value half-day in the plan, because if the LEARN feed is empty the
deadline card changes shape entirely.

**Phase 1 — the one true card. ~1 week.**
Monorepo, collector, Postgres, api, web PWA. Exactly two sources: Portal ICS and LEARN
ICS. Exactly two cards: next commitment and today's strip. Real observed_at plumbing, real
age ladder, dark mode.
*Smallest slice worth showing someone:* open a URL on your phone and see your actual next
class, actual room, counting down, with a hairline that says it was checked a minute ago.
That is already better than Obsidian, and it is one week in.

**Phase 2 — alive, and on the home screen. ~1 week.**
Android app, same two sources, plus the Glance widget, Room cache, WorkManager sync,
offline cold start. Contract generation into Kotlin, golden fixtures in both test suites.
*Demo:* turn off wifi and mobile data, look at your home screen, see the right answer.

**Phase 3 — leave now. ~1 week.**
GRT static GTFS plus tripupdates, the four stops from the research file, the leave-by
computation, scheduled-times-in-bundle offline fallback, and the first push notification.
Also the GRT TLS smoke test in CI.
*Demo:* a notification that says leave in four minutes, and it is right.

**Phase 4 — the campus around me. ~1 week.**
Waitz, Open-Meteo, status.json, campus-status, food menu. Four new sources, five new
cards. Plus the per-source work queue, because this is the point the shared loop starts to
hurt.
*This phase is the test of §3.* If four sources and five cards is not close to four days
of parser-and-renderer work with no architectural change, the design is wrong, and this is
where you find out while it is still cheap to change.

**Phase 5 — opportunistic, ongoing.**
WUSA events, gym occupancy, UW Flow enrolment watch on his courses, Open Data exam
schedules, and personal food ratings — which is the first write path in the system and
therefore the first genuinely new architecture since phase 1.

A note on the schedule risk, since it is the real one: the phases are ordered so that
stopping at the end of any of them leaves a working, useful thing. Phase 1 alone is
already a better system than what it replaces.

---

## 9. Risk register

**1. The token feeds are not what we hope.** Either the LEARN Subscribe dialog is gone,
or the feed carries due dates for two of eight courses.
*Early signal:* phase 0, checks 1 and 2. A fetch in a cookieless window returning
`text/html` instead of `text/calendar`, or a feed with suspiciously few VEVENTs.
*Mitigation:* `timeline_event` does not care where events come from. Classes fall back to
Open Data `ClassSchedules/1269/...` plus `ExamSchedules/1269`, which phase 0 also
verifies. Deadlines fall back to manual entry, which arrives in phase 5 as a write path
anyway. The research file already warns that instructors do not all populate the calendar,
so treat partial coverage as the expected case, not the failure case.

**2. A token leaks, or rotates silently.** The URL is the credential. Anyone holding it
reads my full schedule.
*Early signal:* rotation shows as a 401 or an HTML body from a feed that worked yesterday.
A leak has no signal at all, which is why prevention is the whole mitigation.
*Mitigation:* tokens only in the collector's secret store, redacted in logs, never
returned by the api, never committed — a pre-commit secret scan plus a CI check for
`portalapi2` and `feed.ics?token=` strings. The api itself is authenticated, so a leaked
bundle URL is not a leaked calendar. `POST /v2/calendar/revokeRegen` is the documented
rotation path; write the runbook in phase 1 while it is fresh.

**3. Scraper rot.** Food menu, campus status and the Schedule of Classes break on the next
Drupal redesign. The research file says this plainly, and it is right.
*Early signal:* one source's `plausible` check failing while every other source passes. A
sudden drop in `rows_written` with a 200 status.
*Mitigation:* the raw snapshot archive means you fix the parser against the real bytes
that broke it, offline, without waiting for the next poll. Cards degrade one at a time.
And nothing on the first screen depends on a scrape — that is deliberate. Every Tier 2
source feeds a below-the-fold card only.

**4. TLS and runtime mismatch on GRT, plus the single box behind it.** The research file
warns that the default TLS stack fails with `dh key too small` and returns HTTP 000. I
agree, and I think the warning understates it: Cloudflare Workers expose no cipher or
security-level control, so the documented workaround is simply unavailable there
(confidence: high), and Go's `crypto/tls` dropped finite-field DHE entirely, so a Go
fetcher cannot talk to GRT at all and has no knob to turn (confidence: medium-high —
confirm with a five-line Go program against `vehiclepositions/1`). **This is the reason the
collector is Node and not Go or a Worker**: Node lets you pass
`new https.Agent({ ciphers: 'DEFAULT@SECLEVEL=1' })` down to OpenSSL (confidence: medium —
verify on the exact Node build before phase 3, and note it may also need
`--openssl-legacy-provider` depending on how the distro compiled OpenSSL).
*Early signal:* HTTP 000 or a handshake error the first time the collector runs on any new
host or base image.
*Mitigation:* a CI job that fetches GRT from the exact shipping image. If the workaround
ever dies, shell out to `curl --ciphers DEFAULT@SECLEVEL=1` as an adapter-local transport —
ugly, isolated to one file, and it works. Separately, nightly `pg_dump` off-box covers the
single-point-of-failure half of this risk.

**5. The dashboard stops being trusted.** This is the one that actually kills it. Two
paths: the widget quietly shows six-hour-old data because Doze or an OEM battery manager
killed WorkManager, or a room is wrong once and Peter opens Portal to check — and then
keeps opening Portal.
*Early signal:* the widget's own age ladder showing amber when the phone has had signal.
A `/v1/health/sources` page with a source degraded for a day and nobody noticing. Honestly:
Peter checking another app.
*Mitigation:* the age ladder is the mitigation, because a widget that admits it is stale
stays trustworthy while a widget that lies does not. Beyond that: an expedited sync on
every widget tap and app open so the worst case is one tap; a battery-optimisation
exemption prompt once at first run; and a weekly self-check email or notice from the api
if any source has been degraded more than 24 hours. Trust is a feature, and stale-honesty
is how you ship it.

---

## 10. Decisions for the owner

Eight. Each has my recommendation and the consequence of the other answer.

**1. Where does this run?**
*Recommend:* the existing `hermes-dedicated` box, Docker Compose, Postgres alongside.
$0 marginal, no cold starts, full TLS control.
*If a PaaS instead:* add $3–6/mo, gain uptime and lose the need to maintain a host, and
re-run the GRT TLS smoke test on that runtime before committing to phase 3.

**2. Is that box reachable from the public internet, and is it on campus or off?**
*Recommend:* expose the api through a Cloudflare Tunnel, single-user auth in front.
On-campus hosting is a bonus, since `events.uwaterloo.ca` and `oculus` only answer from
inside.
*If it cannot be exposed:* the Android app syncs only on home wifi, which destroys the
widget's value, and the answer becomes a small paid PaaS for the api.

**3. API authentication.**
*Recommend:* one long random bearer token per device, stored in Android Keystore and
`localStorage`, revocable individually from the admin page. Simple, sufficient for one
user.
*If he wants passkeys or OIDC:* add a session layer and a login screen to both clients —
roughly three days, and worth it only if answer 4 changes.

**4. Will this ever have more than one user?**
*Recommend:* build single-user, but put a `user_id` column on personal rows from day one.
Free now, a painful migration later.
*If multi-user is actually coming:* per-user feed scheduling and encrypted per-user token
storage move into phase 1, and the collector's scheduler gets meaningfully more complex.

**5. Android distribution.**
*Recommend:* a signed APK, sideloaded, with a GitHub Release per build. No store, no fee,
no review latency.
*If Play instead:* $25 once, upload-key management, and a review wait on every change.
Only worth it if anyone else is ever going to install it.

**6. How much should it interrupt?**
*Recommend:* exactly two push types in v1 — leave-now and credential-expired — and a quiet
widget for everything else.
*If he wants more:* quiet hours, per-type toggles and a notification settings screen move
from phase 5 into phase 3.

**7. Personal food ratings?** The research is clear that no rating or nutrition data
exists, so the only possible source is Peter.
*Recommend:* yes, but phase 5, and understand that it converts the api from read-only to
read-write, which is a real architectural step and the first place auth has to be airtight.
*If no:* the api stays read-only forever and the system is materially simpler.

**8. Where does personal configuration live?** The eight courses, home stop 1097/1119, the
Ring Road stops, which libraries, which outlets.
*Recommend:* one committed `config/peter.yaml`, read by collector and api at boot. Editing
is a git commit and a restart.
*If he wants in-app settings:* that is the second write path plus a settings screen on both
clients, so budget about four days and plan it alongside decision 7.

---

## 11. What I reject, and why

**Quest.** No API, no ICS, SAML with mandatory Duo, and every reverse-engineered client is
archived and dead. The research file says do not build on Quest. Agreed, without
reservation.

**LEARN Valence with a session cookie.** It would add grades, submission status and the
content tree. It costs a live credential that expires without warning, and the downside is
a locked account during term. The ICS feed covers schedule and deadlines, which is the
actual need. Not worth it.

**Kotlin Multiplatform, Flutter, React Native.** The shared surface in this design is the
contract, not the code, because all the logic is deliberately server-side. Sharing a few
hundred lines of view code is not worth a second toolchain and a worse Glance widget.

**Next.js or any SSR.** One authenticated user, no SEO, no crawler. The api is already the
server. Vite plus React is less machinery and a better PWA story.

**GraphQL for our own api.** One product, two clients, one screen shape, no ad-hoc
querying. OpenAPI plus generated types gives compile-time safety with far less
infrastructure. (We happily *consume* UW Flow's GraphQL — that is their choice, not ours.)

**Kubernetes, Kafka, Redis, a message broker.** Postgres `LISTEN/NOTIFY` plus a `job` table
with `SKIP LOCKED` covers scheduling and fan-out at this size. Add Redis when there is a
measured reason.

**A plugin system or dynamically loaded sources.** A source is already one file and one
line. Anything more is a framework with an audience of one.

**A microservice, function or container per source.** Ten deploy targets, ten secret
bindings, no shared contract. This is the alternative that looks like good engineering and
makes the stated goal — cheap new sources — more expensive.

**A user-arrangeable widget grid in v1.** Server-computed time-aware priority is better
than manual arrangement, because the right order changes at 11:00 and again at 17:00 and a
human will not keep rearranging.

**WebSockets everywhere.** SSE on web while the tab is visible; polling plus FCM on
Android. A persistent socket from a phone costs battery to deliver data that changes every
few minutes.

**The Reddit r/uwaterloo card.** It works — 200 Atom with a browser User-Agent, per the
research file. It is also unbounded noise on a surface whose entire purpose is to be
readable in seconds, and it puts us in the business of spoofing a User-Agent against terms
that discourage it. Cut.

**Laundry, parking, shuttle, calories, grade distributions.** No data exists. The research
file settled these and I am not relitigating them.

**And the thing I would personally build that nothing here justifies: an LLM "here is your
day" summary card.** It is the first idea anyone has, it demos beautifully, and it is wrong
for this product. It costs money per day, it is non-deterministic, and it converts a
dashboard whose only real asset is being trusted at a glance into something that must be
double-checked. If it ever ships, it ships as a fourth-screen extra, never above the fold.

---

## Notes where I disagree with, or extend, the research file

The research is unusually good — real status codes, real byte counts, corrections marked.
Five places to adjust:

1. **Waitz is mis-tiered.** It sits in Tier 0 as keyless and live, which is true today.
   But `waitz.io/live/waterloo` is an undocumented endpoint of a commercial product with no
   stability promise, so it carries Tier 2 risk with Tier 0 convenience. Treat it as a
   liability: below the fold, plausibility-checked, expendable. Research is right on fact,
   optimistic on tier.

2. **The GRT TLS warning understates the blast radius.** It says a Worker has its own TLS
   stack and to test from your shipping runtime. Correct. It does not say that Workers
   expose no cipher control at all, or that Go cannot do this even in principle. Both facts
   eliminate whole runtimes, so they belong in a plan rather than a footnote. See risk 4
   for confidence levels.

3. **`status.uwaterloo.ca/api/v2/status.json` is an Atlassian Statuspage endpoint**
   (confidence: high, from the URL shape). That is good news the research does not draw out:
   it is a documented, stable schema with a `status.indicator` of
   none/minor/major/critical and a typed `components` array. It is the cheapest and most
   reliable source in the whole list, and it should be built in phase 4 first, because it
   explains other sources' failures.

4. **Do not build the Portal Bearer path.** The research documents
   `GET /v2/calendar/iCalURL` with a Bearer token and `POST /v2/calendar/revokeRegen`. The
   evidence is sound. But obtaining that Bearer token means a login flow, which is exactly
   the credential exposure we are avoiding. Copy the ICS URL by hand once, and re-copy it
   in two minutes if it ever rotates.

5. **The term code rule generalises**, and it is worth writing down since the system will
   need it every four months: `1` + years since 1900 + season digit, where 1 is Winter, 5
   is Spring, 9 is Fall. Fall 2026 is 1269, Winter 2027 is 1271, Spring 2027 is 1275. Put
   it in a function with a test, not in a constant (confidence: high).

One extension the research did not cost out: GRT `tripupdates/1` is 181 KB. At a naive 20
second poll that is roughly 650–780 MB of ingress a day. The feed is fine; blind polling is
not. §6 gates it on a departure actually being imminent.
