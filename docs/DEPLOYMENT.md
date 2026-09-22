# Deployment: what runs where

Measured against Cloudflare's own docs on 2026-09-20. Re-check before designing around
any number here, platform limits move.

## Short answer to "do we need a server"

Yes, at minimum one relay, for three reasons:

1. The two ICS feeds are secrets **and** send no CORS headers.
2. The food menu page sends no CORS headers.
3. A joined card (next class + weather + what is open) cannot be computed where the data
   cannot be fetched.

A genuinely serverless build can only cover weather, occupancy, status, and deadlines
(and deadlines only by subscribing the phone's calendar app straight to the ICS feed,
which is free and needs no code).

## Target 1: containers (homelab / a VPS)

`collector` + `api` + `postgres` + `web`, one `compose.yaml`. Runs on podman or Docker.
Postgres holds canonical rows, history and the raw snapshot archive.

## Target 2: Cloudflare (one-click for other people)

| Piece | Product |
|---|---|
| api + relay + static web | one Worker (static assets served from the same Worker) |
| canonical rows | D1 (SQLite) |
| last-good bundle | KV |
| polling | Cron Triggers |
| the two token URLs | Worker secrets |
| login | Cloudflare Access (free plan, per-user identity) |

### What is actually built now (2026-09-22)

The Worker port exists and was run locally against a real D1 and the live campus feeds. What ships:

| File | Role |
|---|---|
| `wrangler.toml` | Worker name, `[assets]`, D1 binding `DB`, AI binding `AI`, cron `*/15 * * * *` |
| `apps/relay/src/worker.mjs` | `fetch` + `scheduled` handlers; the same routes as the Node relay |
| `apps/relay/src/d1-store.mjs` | D1 adapter, same storage contract as `SqliteStore` |
| `apps/relay/src/schema.mjs` | table shapes, DDL, row converters, imported by both adapters |

```
npm run web:build                          # client into apps/web/dist, which [assets] uploads
npx wrangler d1 create uni-dashboard       # once, then paste the id into wrangler.toml
npx wrangler secret put PORTAL_ICS_URL     # also LEARN_ICS_URL and RELAY_TOKEN
npm run deploy                             # build the client, then wrangler deploy
```

Two platform differences worth knowing, both found by running it rather than reading about it:

- **D1 `exec()` runs one statement per line.** The shared DDL wraps `CREATE TABLE` across lines, so
  it arrived truncated (`incomplete input: SQLITE_ERROR`). D1Store prepares each statement and runs
  them as one `batch()`. A test asserts `exec()` is never used for the schema.
- **`env.AI` has no local emulation.** `wrangler dev` wants a remote proxy session for it, which
  needs credentials. Deployed, the binding is what makes the dining advisor free of API keys; the
  local dev config simply omits it and the AI route fails loudly, which is the intended behaviour
  when there is no model to call.

The Worker bundle resolves no `node:` module at all (checked by grepping the built bundle). That was
not free: `ai.mjs` reached for `node:fs` to write a dev cache file and `node:crypto` to hash a cache
key, `store.mjs` needed `node:sqlite`, and the ICS adapter's fixture path imported `node:fs/promises`.
Node builtins now arrive through `process.getBuiltinModule` where they are optional, the pure schema
moved to `schema.mjs`, and the fixture import builds its specifier at runtime so no bundler folds it
back into a static import.

Verified locally on 2026-09-22 against a local D1 and the live feeds: `/healthz`, `/v1/dashboard`,
`/v1/health/sources`, `/v1/poll`, `/v1/credentials`, `/v1/ai/models`, the SPA fallback, the 404
route list, and the `scheduled` handler. The poll wrote 21 dishes from the live menu page and 1
notice from live `status.json`; both unconfigured token feeds reported `skipped` and the two cards
that depend on them rendered `degraded` instead of pretending nothing was scheduled.

Not yet verified: the AI route on the deployed Worker, because that needs the account. It is the one
piece that requires the `AI` binding to exist in the real account.

### The free tier, and what it constrains in code

Checked against Cloudflare's own pricing pages on 2026-09-22. Nothing here can produce a charge: on
Workers Free the account has no payment method and over-limit usage fails instead of billing.

| Resource | Free allowance | What this build uses |
|---|---|---|
| Worker requests | 100,000/day | a handful a day, one per dashboard load |
| Static asset requests | free and unlimited | the whole client, so the SPA does not count |
| CPU per invocation | 10 ms | the food parse measured 0.47 ms; nothing else is heavy |
| Cron triggers | 5 per account | 1, every 15 minutes |
| D1 rows read | 5 million/day | about 10 per dashboard load |
| D1 rows written | 100,000/day | about 11,000/day with both ICS feeds live |
| D1 storage | 5 GB total | megabytes; snapshots dedupe on body hash |
| D1 queries per invocation | **50** | 38 measured for the worst tick, see below |
| Workers AI | 10,000 neurons/day | about 16 per dining recommendation, cached 12 hours |
| Workers Builds | 3,000 minutes/month | about 2 minutes per push |

The 50-query ceiling is the one that shaped the code, and three decisions exist only because of it:

- **The cron polls two sources per invocation**, not all four. All four measured **54 queries**, over
  the ceiling; the two most expensive (both ICS feeds, ~80 rows each) measure **38**. The rest stay
  due for the next tick, 15 minutes later, and `pollDue` returns their ids as `deferred` so the
  deferral is visible instead of silent.
- **The schema is created behind a probe.** A cron tick gets a fresh isolate, so running ten
  `CREATE TABLE` statements every time would spend a fifth of the budget before any work. One
  `sqlite_master` lookup replaces it.
- **Rows are written in multi-row `VALUES` statements.** A statement per row cost 21 queries for one
  day of menus; eight rows per statement costs 3.

Two more, from the rows-read side: the run receipt log is pruned to 7 days (unbounded growth turns
the latest-run-per-source query into a full table scan on every dashboard load), and a body already
in `raw_snapshot` is never gzipped again (compression is CPU, and the menu page is 290 KB).

Measurements come from `test/worker.test.mjs`, which counts prepared statements against a mocked D1
binding and fails if a tick or a dashboard load crosses 50.

Verified limits, Workers Free vs Paid:

| Limit | Free | Paid ($5/mo) |
|---|---|---|
| Requests | 100,000/day | 10M/month included |
| CPU per HTTP request | **10 ms** | 5 min max, 30 s default |
| CPU per Cron Trigger | **10 ms** | 30 s (<1h interval), 15 min (>=1h) |
| Cron Triggers per account | **5** | 250 |
| Subrequests per request | 50 | 10,000 |
| Simultaneous outgoing connections | 6 | 6 |
| Memory | 128 MB | 128 MB |
| Static asset files per version | 20,000 | 100,000 |
| D1 databases / max size | 10 / 500 MB | 50,000 / 10 GB |
| D1 queries per invocation | 50 | 1,000 |
| D1 Time Travel (point-in-time restore) | 7 days | 30 days |

Cloudflare's own note is the thing to design against: "heavier workloads that handle
authentication, server-side rendering, or **parse large payloads** typically use 10-20 ms".
The food page is 289 KB of HTML. That lands on or over the Free ceiling of 10 ms.

**Consequence, now measured rather than guessed (2026-09-21, Node 24 on the laptop):**

| strategy | CPU per run | vs Free's 10 ms |
|---|---|---|
| marker scanner (indexOf + slice, no DOM) | **0.47 ms** | 20x headroom, fits |
| DOM parser (cheerio/parse5) | **30.2 ms** | 3x over, fails Free |

The same run found 19 dishes, 3 outlets and 19 diet blocks, so the cheap parser is not
cheating by parsing less. So the food card is $0 on Workers Free **as long as the parser stays
a marker scanner**. A DOM parser breaks the free tier and would need Workers Paid. That is a
one-line architectural rule with a 60x cost difference, so write it down and test for it
(no DOM dependency in the parser module; see `docs/MEASUREMENTS.md`).

## Design constraints, so that both targets stay possible

Dual-target is cheap now and expensive later. Concretely:

- **No Node-only APIs in shared code.** Web-standard `fetch`, streams, and text codecs only.
- **One storage interface, two adapters.** Postgres on containers, D1/SQLite on Workers.
  Keep dialect features out of the canonical layer: no `jsonb`, no `timestamptz`, no
  Postgres-specific upsert syntax in shared code. Timestamps as ISO strings or epoch ms.
- **Scheduling cannot depend on Postgres-only features.** The earlier plan used `LISTEN/NOTIFY`
  plus `SKIP LOCKED`. Those do not exist on D1. Use a plain `jobs` table plus a cron-driven
  worker that claims due rows; that works on both.
- **Parser CPU budget.** Single-pass scan, not a DOM tree. Target under 5 ms for the food
  page. That is the difference between a $0 deployment for other people and a $5 one.
- **Secrets behind one interface.** Worker secrets on Cloudflare, `0600` env file or a podman
  secret on containers. The collector is the only reader either way.
- **Auth is per-device bearer tokens on both targets.** Cloudflare Access is optional sugar
  in front, never a dependency of the app.

## How someone else hosts their own copy

1. **Cloudflare, one click.** Their own Worker, their own D1, their own two token URLs
   pasted into the setup page. $0 if the parser stays under the CPU budget, $5/month
   otherwise. No server, no Docker, no DNS.
2. **Containers, one command.** `compose.yaml` on a VPS or homelab box.
3. **Same repo, one contract.** Shared schemas and parsers, two thin entrypoints.

Rules for other users, non-negotiable: their credentials never touch my deployment, each
deployment is a separate Worker (or a separate compose stack) with its own storage, and the
setup URL carries only that user's credentials.

## Pinned places

A pinned outlet or place always renders, even when closed, showing the next open time.
"Why is REV closed" is information. Unpinned outlets appear only when open, collapsed
under one line. Pinning REV and CMH gives a two-row food card that is readable in a second,
which is the whole point of the card.
