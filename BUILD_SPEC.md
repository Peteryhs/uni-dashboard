# V1 spec: the three-card slice

Scope for the first buildable version. Written after the Sept 20 scoping pass. If the plan
in `PLAN.md` and this file disagree, this file wins for v1 and the difference is deliberate.

## What v1 is

Three cards, four sources, two of which need a server. No push notifications. Dark first.
Offline-first. Pins for outlets.

| Card | Data | Where it is fetched |
|---|---|---|
| 1. Next class, with the walk | Portal iCal | relay (secret + no CORS) |
| 2. What is due | LEARN iCal | relay (secret + no CORS) |
| 3. Food at your pinned outlets | Food services page | relay (no CORS) |
| Alert slot, usually invisible | Campus + IT status | client (`status.json` is CORS `*`) |
| Weather, per class hour | Open-Meteo | client (CORS `*`) |

Note what that means: **weather costs the server nothing**, because the client can fetch
Open-Meteo itself. Same for the alert slot. Only the three sources that cannot be reached
from a browser need the relay.

## Explicitly not in v1

Transit (owner uses a transit app, and GRT fails the TLS handshake for browser clients
anyway), gym occupancy, WUSA events, library occupancy, UW Flow enrolment, personal food
ratings, push notifications, home screen widget, multi-user, admin UI for editing secrets,
Reddit, laundry, parking, grades, WatCard balance.

Each of those stays possible. None of them is v1.

## Before any code: four checks only the owner can do

These gate the whole build. Half a day, no code.

1. Sign in to Portal, open the calendar, find the iCal export URL. Copy it into a password
   manager. Open it in a cookieless private window and confirm it renders `BEGIN:VCALENDAR`.
2. Sign in to LEARN, Calendar, Settings, enable calendar feeds, subscribe to all calendars
   and tasks, copy the feed URL. Then count: how many of your courses actually have due
   dates in the feed. If it is two of six, card 2 changes shape.
3. Open the food page signed out and list which outlets are within your walking radius.
   That becomes the default pin set.
4. Confirm the Open Data API key is not needed for v1. (It is not, but confirm you are not
   relying on it.)

If checks 1 or 2 fail, stop and say so. The whole design assumes those two feeds work.

## Architecture constraints carried from `DEPLOYMENT.md`

These are not preferences, they are what keeps both deployment targets open:

- **No Node-only APIs in shared code.** Web-standard `fetch`, streams, text codecs.
- **One storage interface, two adapters.** Postgres and D1/SQLite. No `jsonb`, no
  `timestamptz`, no Postgres-specific upsert in shared code. Timestamps as epoch ms.
- **No `LISTEN/NOTIFY`, no `SKIP LOCKED`.** A plain `jobs` table with a cron-driven claim.
- **Parser CPU budget: under 5 ms for the 289 KB food page.** Single-pass scan, never a DOM
  tree. This is the line between a $0 deployment for other people and a $5/month one.
- **Secrets behind one interface.** Worker secrets or a `0600` env file. The relay is the
  only reader.
- **Auth: one bearer token per device**, sent as a header, never a query parameter.

## Data contract for v1

Four shapes. Nothing else gets built until one of these is genuinely insufficient.

```
timeline_event   id, source_id, external_id, kind (class|exam|deadline),
                 title, subtitle, location, starts_at, ends_at, all_day,
                 observed_at, valid_until
menu_item        id, source_id, external_id, outlet, station, dish, service_date,
                 diet[], allergens[], observed_at, valid_until
metric           name, place_id, at, value          (sparkline history, unused in v1)
source_run       source_id, started_at, finished_at, outcome, http_status,
                 bytes, rows_written, error, body_sha256
```

Rules that must exist from the first commit:

- Every row carries `observed_at` and `valid_until`. The card contract sends both to
  clients. Without them there is no honest staleness and no offline decision.
- Upsert on `(source_id, external_id)`, never truncate and reload.
- Rows missing from a run are tombstoned **only if that run passed its plausibility check**.
  Both ICS adapters must assert `text/calendar` plus a `BEGIN:VCALENDAR` prefix, because a
  200 with `text/html` means "not authenticated" on those paths.
- An empty future menu day is valid-empty, not a failure.

## Reading the data

Three readings, in the order they were ranked by value:

1. **Next class.** Soonest of class or deadline, one hero line: course, room, time until,
   and the walk time folded in. Room numbers come from the feed; walk times come from a
   small table the owner writes once (building to building, minutes). No transit data.
2. **What is due.** Count plus nearest, seven day window, grouped by course. Never a wall of
   text.
3. **Food.** Pinned outlets first, always rendered, showing open or closed with the next open
   time. Unpinned outlets only when open, collapsed to one line. Dishes as a short list, not
   a paragraph.

Below the fold: weather for the next class hour, and the alert slot if campus or IT status is
not normal.

## Freshness

Each source declares its expected cadence. Age is measured against cadence, not the clock, so
a four-minute-old menu is fresh and a four-minute-old live value is not.

The age ladder, and it is the whole honesty mechanism:

- Within 1x cadence: full accent hairline, full foreground numbers.
- 1x to 3x: hairline fades to 30 percent.
- Beyond 3x: numbers muted, hairline amber and dashed, all motion stops.
- Beyond 6x or a tripped circuit breaker: muted numbers plus an amber dot.

Motion fires on change, never on fetch. A poll that returned identical bytes produces no
movement, so movement means information.

## Verify, and actually run these

1. Parse a captured fixture of the real food page and assert row counts against the outlet
   and dish counts visible on the page.
2. Measure parser CPU. Already done for the first draft: a marker scanner runs at 0.468 ms
   CPU on the 289 KB page, a DOM parser at 30.2 ms (see `docs/MEASUREMENTS.md`). Re-run the
   benchmark against whatever parser actually ships, and fail the check if it needs a DOM.
   This is the number that decides the deployment target, and it currently says Free is fine.
3. Contract check: every card in the bundle has `observed_at` and `valid_until`, and an
   unknown card type is skipped and counted rather than crashing a client.
4. Staleness: with the relay stopped, the client still renders the last bundle, with the age
   ladder visible, and no spinner.
5. Empty: request a date with no menu and confirm the food card shows a declarative empty
   state, not an error and not a spinner.
6. Pins: pin an outlet that is closed and confirm it still renders with its next open time.
7. Plausibility: feed an ICS adapter the login page HTML and confirm the run fails loudly and
   tombstones nothing.

## Sequencing

**Slice 1: food only.** The riskiest parse and the owner's top want, so the CPU budget gets
measured first and the biggest unknown dies early. Deliverable: a page that shows pinned
outlets with today's dishes, correct open and closed states, and a measured parse time.

**Slice 2: next class plus weather.** The two token feeds, the walk-time table, the hero
line, and the offline bundle. This is the slice that replaces what the owner uses today.

**Slice 3: tasks, pins UI, and the polish pass.** The due-date card, editing pins from the
UI, the age ladder, dark mode, and the alert slot.

Stop after any slice and you have something worth opening.

## Open decisions

1. **Deployment target.** Resolved by measurement, not by taste: marker scanner at 0.47 ms
   CPU means Workers Free (10 ms) is viable for v1, so Cloudflare is the primary target at
   $0. Revisit only if the parser has to grow a DOM, or if a source is added that cannot
   fit the budget. See `docs/MEASUREMENTS.md`.
2. **Pins UI in v1 or from the config file.** Config file is an evening; the UI is a write
   path plus a settings screen on two clients.
