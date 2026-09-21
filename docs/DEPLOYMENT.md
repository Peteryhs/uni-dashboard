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
