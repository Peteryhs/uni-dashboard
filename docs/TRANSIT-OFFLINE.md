# Transit and offline web use

## Saved commutes

Web Settings → Transit and Android Settings → Transit manage up to six directional commutes.
Search by stop name or stop number, select boarding and destination stops, and optionally restrict
the route. Trips must be direct, on the same bus or ION network, with permitted boarding and
alighting in the right order. Transfers, vehicle maps and location tracking are not included.

Walking defaults to five minutes before boarding and five minutes after arrival, with ten minutes
to arrive early. Edit those values for your actual journey and classroom. The dashboard shows
three boardable departures; **Going to campus** activates guidance for the next physical, timed
class or exam today. The target event is named before activation. Activation is shared across
devices, ends when that event starts or at Toronto midnight, and can be cancelled. The app assumes
you are leaving the saved origin; it does not detect your location.

Guidance selects the latest boardable direct trip that arrives with the configured buffers. Its
arrival may be scheduled even when boarding has a prediction; the interface labels that distinction.
Predictions expire locally after 90 seconds, and cached offline views use scheduled departure times
with no live leave instruction. Missing predictions are not interpolated. GRT's schedules and
estimates do not guarantee an actual arrival.

Data comes from [GRT's official static and realtime feeds](https://webapps.regionofwaterloo.ca/api/grt-routes/).
Contains information provided by the Regional Municipality of Waterloo under its
[Open Data Licence](https://www.grt.ca/about-grt/open-data/).

## Free Cloudflare architecture

The Worker entry point is `apps/relay/src/worker-entry.mjs`. It exports the existing HTTP/cron
worker and `TransitCoordinator`, a SQLite-backed Durable Object bound as `TRANSIT`. The additive
`transit-v1` class migration is in `wrangler.toml`. Keep this entry point and migration when deploying.
The object is internal: all HTTP requests still pass through the existing Access and write-origin
checks. There is no new public unprotected data route and no additional account credential.

One object owns public timetables, private commute preferences, activation and compact snapshots.
D1 remains responsible for the rest of the dashboard. The same engine uses the relay's SQLite
database locally. Transit tables are separate from canonical source receipts.

Static bus and ION archives are checked daily with ETags and content hashes. Only required ZIP
members are parsed. Stop times are grouped by stop; trips are grouped by route. Imports use a
staged generation and keep the previous selected generation when parsing fails. Successful
replacement removes superseded data. An invocation imports at most one successful archive.

Alarms run every minute and re-arm before network work. They fetch realtime data only for networks
with saved commutes and departures approaching within 90 minutes, and check service alerts every
five minutes. Per-provider exponential backoff prevents a failed bus feed from blocking ION.
The existing cron checks the alarm every fifteen minutes as a recovery mechanism. Reads never
fetch GRT, invoke AI, or write source receipts. Minute recommendation refreshes reuse their existing
calendar data when adding transit guidance, without another calendar/D1 scan.

Use **Update transit** in web Settings for initial/manual refresh. With automatic local polling off,
this explicit action prepares both timetables. Saved commutes can immediately show scheduled trips;
another explicit update fetches predictions. Set `RELAY_POLL_ENABLED=1` only when the local relay
is intended to poll sources automatically. Cloudflare alarms update independently of open clients.

On the inspected 2026-10-30 bus feed, a local import processed 271,919 stop-time records into 6,839
SQLite record writes. The largest stored value was 187,391 characters, and import wall time was
about 4.3 seconds. Node heap use after import was approximately 79 MB. These measurements are not
production Worker CPU or peak-memory measurements. Unchanged archives avoid rewriting the groups.
Two-generation replacement plus six minute snapshots, alarms and metadata is designed to stay
within the free storage operation budget for one personal instance. Account-wide usage, import CPU,
memory and error rates must still be checked in Cloudflare after deployment. No paid plan or
external scheduled job is required by the configuration.

## HTTP contract

| Route | Behavior |
|---|---|
| `GET /v1/transit/stops?q=...&origin=...` | Up to 30 matching stops; optional origin restricts to direct destinations |
| `GET /v1/transit/commutes` | Saved commute list |
| `POST /v1/transit/commutes` | Create a validated commute |
| `PUT /v1/transit/commutes/:id` | Edit a saved commute |
| `DELETE /v1/transit/commutes/:id` | Remove a commute and its snapshot |
| `POST /v1/transit/activation` | Activate `{ commute_id }` for the next eligible event; accepts existing calendar section/group query filters |
| `DELETE /v1/transit/activation` | Cancel activation |
| `POST /v1/transit/refresh` | Schedule an explicit update; returns 202 |
| `GET /v1/transit` | Standalone transit view, including current calendar target |

Commutes contain `name`, namespaced `origin`/`destination`, optional `route`, `walk_to_minutes`,
`walk_from_minutes` and `arrival_buffer_minutes` (0–120 each). The server supplies IDs and stop names.
The shared schemas live in `packages/contract/src/transit.mjs`. `/v1/recommendations` has an optional
`transit` field; its existing kinds and schema version remain compatible with older clients.
Transit failure leaves other recommendations available. MCP tool contracts are unchanged.

## Offline web launch

Visit the production-built web app online once and wait for **Ready for offline use**. After that,
the same browser/profile can open the app without a connection. Installation as an app is optional;
the manifest and icons support browsers that offer it. HTTPS or localhost is required.

The service worker caches the versioned shell, scripts, styles, icons and local Inter font. Online
navigation goes to the network first so an expired Cloudflare session can reach sign-in. Only a
network failure/timeout falls back to the shell. The installer rejects redirected responses and
unexpected HTML. API, health, MCP, OAuth, Access and discovery routes are never service-worker cached.
Application updates wait for the user to select **Update available · Reload**.

Saved dashboard, calendar, recommendations and transit use existing validated local caches. Posted
menus, current weather, dining ranking and syllabus reads have a bounded, validated cache too.
The calendar cache can supply its remaining days after campus midnight. Saved information retains
its observation date and freshness; expired transit predictions become scheduled times. Content
that has never been fetched is unavailable offline. Failed storage or corrupt caches fall back to
the ordinary online behavior rather than blocking startup.

Offline server changes are disabled and rejected at the client boundary, without a write queue.
Reconnection refetches active views. Browser caches belong to the trusted device/profile and are
readable without a renewed Access session while offline. Settings → About → **Clear saved data on
this device** clears application caches, local preferences and the local relay token, and removes
the service worker; it does not delete server data or revoke Cloudflare Access.

## Verification

- `npm test`: backend contracts, routing, transit scenarios and actual local Durable Object persistence.
- `npm run web:build` and `npm run worker:check`: production web/service worker and Cloudflare dry run.
- `npm --prefix apps/web run test:e2e`: synthetic local preview, commute editing, desktop/mobile
  layout, new-tab offline launch, read-only controls, reconnection and online login navigation.
- Android: build, unit tests (including cached transit/prediction expiry), and unrestricted lint.

The browser tests use synthetic in-memory data and never read the owner's `relay.db`. Android
device rendering and deployed Cloudflare resource usage remain separate checks. The optional
`tools/transit-android-check.init.gradle` gives concurrent builds separate output directories.
