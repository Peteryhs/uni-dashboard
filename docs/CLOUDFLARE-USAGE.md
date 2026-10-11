# Cloudflare usage audit — 2026-10-11

The Android/web presentation and notification changes keep clock updates on the device. A moving Now marker, past-event styling, countdown, progress tick, cleanup alarm, or notification reconciliation does not call the Worker or AI. Recommendation warnings and completion identity metadata are derived from facts already read by the backend.

## Current allowances and protections

| Resource | Workers Free allowance | Dashboard protection |
|---|---|---|
| D1 reads | 5,000,000 rows/day | Indexed latest-receipt lookups; bounded calendar/menu queries; minute automatic refresh reuse; five-minute calendar reads |
| D1 writes | 100,000 rows/day | Ordinary reads make no writes; source cadence/backoff/leases remain unchanged; ranking submissions cannot duplicate while in flight |
| Worker requests | 100,000/day | Local clocks and notification updates; unique 15-minute background job; foreground/background reads share a recent successful response |
| Worker CPU | 10 ms per invocation | GETs never poll feeds or run AI; indexed receipt lookups remove a retained-history scan. CPU is a per-invocation limit, not a daily pool |
| Workers AI | 10,000 neurons/day | All application AI paths reserve against the existing atomic 7,000-neuron UTC-day budget before each model attempt, including retries; unknown unbudgeted models fail closed |

Limits were rechecked against Cloudflare's [Worker limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/). These allowances are shared across the account. Additional deployments/clients can consume the same allowance.

## Fixes made during this audit

Calendar assembly called `lastRunPerSource()` without source IDs. The exhaustive query scanned a week of retained status receipts on every calendar and recommendation read, despite using only a handful of statements. It now requests just the calendar sources through the existing source/receipt index. No extra index or recurring write was added.

Android automatic reads reuse a complete successful snapshot younger than one minute, checking freshness after acquiring the refresh mutex. This merges overlapping sign-in, foreground, and background reads. Automatic calendar reads reuse a current-session calendar younger than five minutes, matching the web cadence, while dashboard/recommendations/health keep their minute cadence. The reused calendar's disk cache is not rewritten. Clock rollback, future timestamps, incomplete/error data, and invalidated sessions do not qualify. Explicit pulls, source updates, ranking, and action reloads continue to fetch immediately.

Acknowledged action/dismissal reloads already existed before the UX refactor; moving them after acknowledgement did not add traffic. Source polling and AI generation cadences were not increased.

## Row-level measurement

A temporary local D1 runtime measured actual `rows_read` / `rows_written` metadata with 80 Portal events, 80 LEARN events, 21 menu dishes, a saved dining profile, and 10,100 status receipts. The workload assumes one phone and one browser left on the dashboard for 24 hours, current source polling cadences, and cached cron housekeeping every minute. No live feed, production database, or real AI was used.

| Measurement | Result |
|---|---:|
| Calendar GET after the fix | 615 rows read, 10 statements, 0 rows written |
| Recommendation GET after the fix | 554 rows read, 14 statements, 0 rows written |
| Estimated phone reads/day | 2,040,480 |
| Estimated browser reads/day | 1,977,312 |
| Source polling plus cached housekeeping reads/day | 212,614 |
| Combined estimated reads/day | **4,230,406 / 5,000,000** |
| Steady source polling writes/day | **30,060 / 100,000** |

Rolling receipt retention adds approximately 8,000 written rows/day for this fixture because deleting old receipts also updates indexes. Changed AI/weather results, initial migrations, settings/actions, Status views, processing-job polling, and extra clients are additional. The stated scenario leaves about 770,000 read rows and over 60,000 write rows for those additions. These are local scenario estimates, not observed account totals or a guarantee for arbitrary feed size/traffic. A continuously open dashboard is more demanding than normal intermittent personal use.

Before the indexed receipt fix, the same initial scenario projected over 53 million read rows/day. The old statement-count tests did not detect that cost.

## Regression checks and verification limits

`test/cloudflare-row-budget.test.mjs` runs against local D1 with a week of minute receipts and asserts that calendar/guidance reads stay below 1,000 scanned rows, retain their statement budget, make no data writes, and call no AI. Existing Worker read tests now also assert no writes/AI. AI tests cover atomic concurrent reservations, exhaustion before inference, UTC-day reset, retry reservations, and free cache reads. Android tests cover overlapping automatic reads, explicit overrides, calendar cadence, errors, clock changes, and session replacement.

The full backend/web suite passes 429 tests, and the Worker dry-run build passes. The Android APK builds and all 138 unit tests pass; its remaining lint checks pass with the already documented upstream detector limitation. No production deployment was performed. Cloudflare account authentication could not retrieve account IDs, so actual account-wide D1/AI totals and edge CPU percentiles remain unverified. The appropriate live checks are D1 row usage, Workers CPU percentiles/errors, and the Workers AI usage dashboard; local request wall time is not evidence of edge CPU time.
