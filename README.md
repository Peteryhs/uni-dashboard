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
node tools/menu-parse-bench.mjs                   # the CPU budget check
```

Set `PORTAL_ICS_URL` and `LEARN_ICS_URL` for the real feeds. Without them those two sources
report `skipped` and say which variable to set.

## Layout

```
packages/contract/   the schema source of truth: canonical rows, card envelope, age ladder,
                     per-card payload schemas
sources/food/        marker scanner, zero imports, no DOM
sources/ics/         RFC 5545 reader with weekly recurrence expansion, one adapter two roles
sources/status/      Statuspage JSON
apps/relay/          runner, SQLite store (D1 dialect), job scheduler, card builders, server, cli
fixtures/            captured real bytes plus labelled synthetic samples
test/                61 tests
tools/               fixture capture and the parse benchmark
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

1. Point the two ICS sources at the real feeds.
2. Move this code into a Worker: static assets, cron trigger, D1 binding.
3. Build the food card as a real dark-first page.
