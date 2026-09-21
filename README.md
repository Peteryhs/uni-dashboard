# Uni Dashboard

A live dashboard for Waterloo student life: one web app and one Android app, fed by real
campus data, readable at a glance.

Status: the v1 relay works end to end and is covered by tests. Not deployed yet.

## What runs today

| Source | Data | State |
|---|---|---|
| `uw-food-daily-menu` | today's dishes per outlet | live, no auth, no CORS |
| `uw-status` | campus and IT status | live, no auth, CORS `*` |
| `open-meteo` | hourly weather for the walk | live, no auth, CORS `*` |
| `uw-portal-ics` | class timetable and exams | needs the Portal iCal token URL |
| `uw-learn-ics` | deadlines and due dates | needs the LEARN feed token URL |

The two token feeds are written and tested against fixtures, and they stay blocked until the
owner copies the URLs out of Portal and LEARN. Everything else is real data.

## Quickstart

```bash
npm install
npm test                                          # 61 tests
node apps/relay/src/cli.mjs sources               # readiness, and which env var is missing
node apps/relay/src/cli.mjs poll                  # fetch, parse, validate, store
node apps/relay/src/cli.mjs bundle                # the four-card payload a client renders
node apps/relay/src/cli.mjs health                 # per-source last run, age, circuit state
node apps/relay/src/cli.mjs serve                  # http://127.0.0.1:8787/v1/dashboard
node tools/inspect-db.mjs                         # what is actually stored, per shape
node tools/menu-parse-bench.mjs                   # the CPU budget check
```

Set `PORTAL_ICS_URL` and `LEARN_ICS_URL` for the real feeds. Without them those two sources
report `skipped` and say which variable to set.

## The dashboard

```bash
npm run web:install     # once
npm run dash            # build the client, then serve it and the API on one origin
                        # -> http://127.0.0.1:8787/
```

For UI work, run the relay and the Vite dev server side by side:

```bash
npm run serve           # terminal 1: relay on 8787
npm run web:dev         # terminal 2: http://127.0.0.1:5173, proxies /v1 to 8787
```

One origin serves both the app shell and `/v1`, which is what Workers static assets gives for
free, so there is no CORS path anywhere and no dev-only workaround to remove at deploy time.

The client is Vite + React + Tailwind v4 + shadcn/ui. It imports the age ladder and the
skip-unknown-card rule from `packages/contract` rather than restating them, so the web and Android
clients cannot drift from the server.

Two visible design rules:

- **Amber means stale, and nothing else.** The accent is cool cyan on purpose. If the brand colour
  were also warm, "this number is old" and "this is the theme" would look identical.
- **The alert slot renders zero height when nothing is wrong.** A permanent "all normal" tile trains
  the eye to skip exactly the region where a real outage would appear.

## Layout

```
packages/contract/   the schema source of truth: canonical rows, card envelope, age ladder,
                     per-card payload schemas
sources/food/        marker scanner, zero imports, no DOM
sources/ics/         RFC 5545 reader with weekly recurrence expansion, one adapter two roles
sources/status/      Statuspage JSON
apps/relay/          runner, SQLite store (D1 dialect), job scheduler, card builders, server, cli
apps/relay/src/static.mjs   serves the built client; deleted when Workers static assets take over
apps/web/            Vite + React + Tailwind v4 + shadcn/ui client
  src/lib/contract.ts       typed bridge to packages/contract
  src/components/freshness.tsx   the age ladder, rendered
  src/components/cards/          one renderer per card type, plus the degrade chain
fixtures/            captured real bytes plus labelled synthetic samples
test/                61 tests
tools/               fixture capture, db inspection, the parse benchmark
```

## Load-bearing rules

- **The food parser must not import a DOM.** Measured 0.55 ms versus 41.3 ms for cheerio; Workers
  Free allows 10 ms per invocation. `test/food-parser.test.mjs` fails if an import appears.
- **Every row and every card carries `observed_at` and `valid_until`.** Without them there is no
  honest staleness and no offline decision.
- **Tombstones only after a run that was plausible and not valid-empty.** A login page must never
  delete a timetable.
- **Dialect-neutral storage.** Epoch milliseconds, no `jsonb`, no timestamptz, a `job` table instead
  of `LISTEN/NOTIFY`, so the same code runs on SQLite/D1 and Postgres.

## Docs

- `GOALS.md` core needs and constraints
- `PLAN_BRIEF.md` what the planning pass had to answer
- `BUILD_SPEC.md` v1 scope, the four signed-in checks, and the verify list
- `docs/PLAN.md` the architecture plan
- `docs/DEPLOYMENT.md` targets, Cloudflare limits, self-hosting, pins
- `docs/MEASUREMENTS.md` measured numbers with method

## Next

1. Point the two ICS sources at the real feeds. Until then the schedule and deadline cards render
   fixture data, and the UI says so: both show an amber dashed hairline and the sources panel names
   the missing variable.
2. Make the client a PWA (`vite-plugin-pwa`). The last-good bundle already survives in
   localStorage, but a cold start with the relay down cannot even load the shell yet, because the
   relay is what serves it. A service worker is what closes that gap.
3. Move this code into a Worker: static assets, cron trigger, D1 binding, tested with `wrangler dev`.
4. Android (Kotlin/Compose) once the web side has proved the contract.
