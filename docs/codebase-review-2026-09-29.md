# Codebase review — 29 September 2026

## Scope and checks

Reviewed the Node relay, Cloudflare Worker, source adapters, shared contracts, web client, Android client, and build/test configuration. Three subagents reviewed backend, web, and Android independently; the main agent checked the findings and reproduced the strongest backend cases using synthetic input and temporary or in-memory stores.

The initial review changed no application code. The follow-up implementation below was requested afterward. Probes and regression tests did not poll real feeds or modify the running relay's credentials or database.

- Backend and contract suite: **250 tests passed**.
- Web typecheck: **passed**. The production build also passed with the current UI changes.
- Web production dependency audit: **0 reported vulnerabilities**.
- Android tests/build: **not executed successfully**. The available JDK is 17 while the project requests 21; the cached Gradle installation could not load its native library on Windows ARM64. A Windows `gradlew.bat` wrapper is also missing. Android findings below are code-reviewed, not device-tested.

Priorities: **P1** = address first because of data loss, account isolation, or unauthenticated writes; **P2** = normal correctness fixes. This review does not establish that every possible defect or security issue has been found.

## Follow-up: P1 fixes

The prior UI work was committed first as `3da0dfd` (`Refine dashboard density and add consistent blur transitions`). Commit signing was disabled for that individual command after the configured 1Password signing service failed; no Git configuration was changed.

- **Polling:** every entry point claims a per-source lease. SQLite applies rows, tombstones, snapshots, and receipts in a transaction; D1 applies a batch with ownership predicates on the writes. Superseded results cannot replace newer data or reschedule a newer job. Exceptions release held leases. Existing databases gain the lease columns, including partial and concurrent migration cases. D1 parameter limits and unchanged-snapshot compression reuse are preserved.
- **Local relay:** foreign-origin writes are rejected using the Worker's existing guard. Non-loopback startup requires a token or an explicit development override. Open loopback listeners reject non-local Host headers. Vite preserves Host so ordinary proxied writes continue to work, and native clients without browser headers remain supported.
- **Android:** sign-out invalidates refresh generations, cancels active refresh work, and clears memory and disk before delayed cleanup. Writes, rollback paths, notification callbacks, and work scheduling are fenced by session ownership. Sign-in and sign-out transitions are serialized, and cleanup checks its generation. Cancellation propagates normally.
- **Office-hours editor:** saves require a successful initial configuration load. Stale requests are ignored, overlapping mutations are blocked, and the editor adopts the normalized server response. Failed loads retain drafts and offer retry. Browser testing also exposed an inaccessible Undo toast outside the settings dialog; it now stays inside the dialog's interaction scope.

Validation after the fixes:

- **278 backend/web regression tests passed**, including 15 polling tests, 6 local-auth tests, 7 office-hours editor tests, and the existing Worker query-budget gates.
- Web typecheck and production build passed. Worker bundle dry run passed; nothing was deployed.
- The actual built web app was tested against an isolated synthetic API: delayed load, failed load, retry, draft preservation, append, edit, delete, and Undo. Existing rules were retained. The settings layout was visually inspected at the browser's actual 1280×720 viewport; the browser's requested phone viewport override did not apply, so phone-size visual verification is not claimed.
- **Five Android `SessionRaceTest` tests passed** in a temporary JVM Gradle harness compiling the actual production `Models.kt`, `RelayApi.kt`, and `DashboardRepository.kt`. The harness used the project's pinned Kotlin 2.4.20, coroutines/serialization 1.11.0, OkHttp/MockWebServer 5.5.0, and JUnit 4.13.2 on Java 17. The modified `MainViewModel.kt` also typechecked with minimal Android/lifecycle/app stubs. This verifies production repository/API behavior with simulated network responses; it is not a device or APK test.
- Independently, the actual changed `DashboardRepository.kt` compiled with cached Kotlin 2.4.0/coroutines 1.10.2 on Java 17, and **six additional deterministic scenarios passed** against typed fake API/model boundaries: delayed refresh invalidation with no cache resurrection; stale/fresh callback delivery; cleanup racing a new session without deadlock; repeated invalidation; failed old action rollback; and cancellation propagation.
- The full Android app build remains unavailable because Java 21 and the Android SDK are absent and default Gradle cannot load its Windows ARM64 native library. Temporary harnesses used Java 17; project build requirements were unchanged.

The findings below describe the original reviewed state. P2 findings are outside this patch. Office-hours ordering is protected within an editor session; concurrent document replacement from separate devices still needs server revision checks.

## Address first

### 1. P1 — Concurrent polls can delete each other's calendar rows

**Locations:** [worker.mjs:128](C:/Users/peter/Work/uni-dashboard/apps/relay/src/worker.mjs:128), [runner.mjs:190](C:/Users/peter/Work/uni-dashboard/apps/relay/src/runner.mjs:190), [server.mjs:247](C:/Users/peter/Work/uni-dashboard/apps/relay/src/server.mjs:247).

Worker polling reads due jobs without atomically claiming them. Manual polling also bypasses the Node scheduler's in-process lock. Each runner separately upserts a snapshot and tombstones rows missing from that snapshot, so overlapping runs can interfere.

**Reproduced:** two simultaneous calls to the production Worker `pollDue` function for one synthetic due source both fetched and returned `ok`; after their upsert/tombstone operations interleaved, the in-memory store contained **zero live rows**.

**Fix:** use an atomic per-source lease for every polling entry point. Commit a snapshot consistently and reject results from superseded runs. Preserve the existing D1 query-budget tests when adding claims.

### 2. P1 — The local relay accepts unauthenticated foreign-origin writes

**Locations:** [server.mjs:134](C:/Users/peter/Work/uni-dashboard/apps/relay/src/server.mjs:134), [server.mjs:551](C:/Users/peter/Work/uni-dashboard/apps/relay/src/server.mjs:551), [worker.mjs:205](C:/Users/peter/Work/uni-dashboard/apps/relay/src/worker.mjs:205).

The Node server authenticates only when a token is configured. It lacks the Worker's cross-site write guard and allows startup on a non-loopback host without authentication. The header comment says `DEV_ALLOW_OPEN=1` is required, but startup does not enforce that rule.

**Reproduced:** a temporary Node listener with no token accepted a `text/plain` credential POST carrying a foreign `Origin` and `Sec-Fetch-Site: cross-site`, returning **200** and changing configuration. Browser-specific private-network restrictions were not tested; the server itself accepts the request.

**Fix:** share the cross-site write guard with the Worker. Require authentication for non-loopback binding, with any deliberate open mode made explicit. Keep native clients without an Origin header working.

### 3. P1 — Android sign-out can be undone by an in-flight refresh

**Locations:** [DashboardRepository.kt:52](C:/Users/peter/Work/uni-dashboard/apps/android/app/src/main/java/dev/peteryhs/unidash/data/DashboardRepository.kt:52), [DashboardRepository.kt:124](C:/Users/peter/Work/uni-dashboard/apps/android/app/src/main/java/dev/peteryhs/unidash/data/DashboardRepository.kt:124), [MainViewModel.kt:72](C:/Users/peter/Work/uni-dashboard/apps/android/app/src/main/java/dev/peteryhs/unidash/ui/MainViewModel.kt:72).

Refresh holds an API instance and later writes responses to disk and the shared snapshot. `clear()` does not acquire the refresh mutex or invalidate that work. A manual refresh can therefore complete after sign-out clears data, repopulating the old cache; its success callback can schedule notifications again. A later sign-in can briefly show the prior connection's data.

**Fix:** invalidate the session generation before clearing, cancel active work, and serialize cache clearing with refresh. Check the session again before committing a response and before scheduling notifications.

### 4. P1 — Saving office hours before the initial load finishes can erase saved rules

**Locations:** [schedule-tab.tsx:313](C:/Users/peter/Work/uni-dashboard/apps/web/src/components/schedule-tab.tsx:313), [schedule-tab.tsx:377](C:/Users/peter/Work/uni-dashboard/apps/web/src/components/schedule-tab.tsx:377), [schedule-tab.tsx:444](C:/Users/peter/Work/uni-dashboard/apps/web/src/components/schedule-tab.tsx:444), [schedule-tab.tsx:762](C:/Users/peter/Work/uni-dashboard/apps/web/src/components/schedule-tab.tsx:762).

The settings tab starts with an empty configuration and loads existing rules asynchronously. A completed background draft can appear independently of that request. Save merges the draft with the current local configuration and replaces the server document, but is not disabled while configuration is loading or after loading fails. A slow or failed GET can therefore cause existing rules to be replaced with just the draft. A late GET can also overwrite newer local state.

**Fix:** require a successful initial load before allowing saves, guard or abort stale loads, and use a server revision check when replacing the complete configuration.

## Other confirmed backend and client issues

### 5. P2 — Clearing local credentials does not survive a restart

**Location:** [server.mjs:442](C:/Users/peter/Work/uni-dashboard/apps/relay/src/server.mjs:442), [server.mjs:479](C:/Users/peter/Work/uni-dashboard/apps/relay/src/server.mjs:479).

Empty credential values delete the environment variable, but the persistence code only rewrites truthy values. The old `.env` entry remains and is loaded on restart.

**Reproduced:** a synthetic LEARN URL was cleared in memory, while its old line remained in a temporary `.env` file.

**Fix:** explicitly remove cleared managed keys and replace the file atomically. Return an error if persistence fails instead of reporting a durable save.

### 6. P2 — A rejected Worker credential batch can still partially save

**Location:** [worker.mjs:473](C:/Users/peter/Work/uni-dashboard/apps/relay/src/worker.mjs:473).

Each entry is validated and written before the next entry is validated. A valid account ID followed by an invalid API token changes the stored account ID even though the overall request returns 400.

**Reproduced:** the account value changed despite a failed batch response.

**Fix:** validate the entire payload first, then commit the validated batch atomically.

### 7. P2 — A newly saved feed may stay stale or empty for hours

**Location:** [worker.mjs:497](C:/Users/peter/Work/uni-dashboard/apps/relay/src/worker.mjs:497), [server.mjs:523](C:/Users/peter/Work/uni-dashboard/apps/relay/src/server.mjs:523).

Post-save polling only considers already-due jobs; changing a feed URL does not make its source due. An unconfigured feed is initially scheduled six hours ahead. A healthy feed can also have a future due time. The Worker may poll an unrelated due source instead.

**Reproduced:** saving a synthetic new Google Calendar URL returned 200 with `polled: []`, performed **zero fetches**, and left its schedule in the future.

**Fix:** identify which sources changed and explicitly schedule or queue those sources, respecting source backoff and the Worker query cap. Report whether the changed source was refreshed or queued.

### 8. P2 — Course-link saves can lose another course's changes

**Location:** [course-library.mjs:81](C:/Users/peter/Work/uni-dashboard/apps/relay/src/course-library.mjs:81).

All courses share one JSON setting. Each save reads the full library, changes one course, and writes the whole document. Two tabs or devices can read the same old document and overwrite each other's unrelated course changes.

**Reproduced:** simultaneous ECE 105 and ECE 150 saves both succeeded, but only ECE 150 remained stored.

**Fix:** store links per course, or use the existing compare-and-set support with retries.

### 9. P2 — Office-hours AI caching can return the wrong course or date context

**Location:** [ai.mjs:349](C:/Users/peter/Work/uni-dashboard/apps/relay/src/ai.mjs:349), [ai.mjs:938](C:/Users/peter/Work/uni-dashboard/apps/relay/src/ai.mjs:938).

The cache key includes text and model, while the prompt and transformed result also depend on course, timezone, and current date.

**Reproduced:** identical text was parsed for ECE 198 and then MATH 135 using a fake AI binding. The second result still said **ECE 198**, and only one AI call occurred. Relative-date input can similarly reuse the first request's date context.

**Fix:** include all contextual inputs in the key, including the campus date, or bypass caching when that context is variable.

### 10. P2 — Office-hours validation accepts impossible times

**Location:** [office-hours.mjs:23](C:/Users/peter/Work/uni-dashboard/packages/contract/src/office-hours.mjs:23), [source.mjs:36](C:/Users/peter/Work/uni-dashboard/sources/office-hours/source.mjs:36).

The schema validates the shape `HH:MM`, but not hour/minute bounds. Date fields likewise check format rather than calendar validity. Expansion silently normalizes invalid input, and a reversed time interval becomes a one-hour session.

**Reproduced:** `99:99` passed schema validation and expanded into a different real date/time.

**Fix:** validate real times and dates, date-range ordering, and duration. Reject reversed intervals unless overnight sessions are deliberately supported.

### 11. P2 — Dining-specific AI attempt limits are not atomic

**Location:** [food-recommendation.mjs:156](C:/Users/peter/Work/uni-dashboard/apps/relay/src/food-recommendation.mjs:156).

The daily attempt counter uses read/check/write. Concurrent claims can bypass the separate automatic/manual limits and lose increments.

**Reproduced:** at automatic count 11, two concurrent claims were both granted, while the stored count ended at 12.

The separate shared neuron-budget reservation is atomic and limits the overall risk. This issue does **not** imply unlimited AI spend, but duplicate dining attempts can consume budget intended for other features.

**Fix:** make the attempt claim an atomic conditional update or compare-and-set retry.

### 12. P2 — Web settings do not promptly refresh the dashboard

**Location:** [schedule-tab.tsx:449](C:/Users/peter/Work/uni-dashboard/apps/web/src/components/schedule-tab.tsx:449), [customization-sheet.tsx:839](C:/Users/peter/Work/uni-dashboard/apps/web/src/components/customization-sheet.tsx:839), [App.tsx:709](C:/Users/peter/Work/uni-dashboard/apps/web/src/App.tsx:709).

Office-hours mutations update only local settings state. Credential saves poll the relay but do not invalidate dashboard, calendar, and recommendation queries. Course saves already have the required invalidation callback. Closing settings can leave the main dashboard showing old data until a timer or manual refresh runs.

**Fix:** pass one shared data-saved callback through all settings mutations and invalidate the affected queries after the mutation succeeds.

### 13. P2 — CFE is displayed as manageable but rejected by course APIs

**Location:** [cards.mjs:385](C:/Users/peter/Work/uni-dashboard/apps/relay/src/cards.mjs:385), [course-library.mjs:3](C:/Users/peter/Work/uni-dashboard/apps/relay/src/course-library.mjs:3), [course-settings-tab.tsx:93](C:/Users/peter/Work/uni-dashboard/apps/web/src/components/course-settings-tab.tsx:93).

The backend emits the synthetic administrative course `CFE`, includes it in the course catalog, and the web UI exposes resource and syllabus management. The APIs require a course code containing digits and reject CFE.

**Reproduced:** CFE normalization, resource saving, and syllabus loading each reject with `invalid course code`.

**Fix:** decide whether administrative courses support management, then enforce the same decision in the catalog, UI, and API. If supported, use consistent bounded identifiers rather than weakening validation indiscriminately.

### 14. P2 — Android consumes an alert even when notification permission is denied

**Location:** [Notifier.kt:55](C:/Users/peter/Work/uni-dashboard/apps/android/app/src/main/java/dev/peteryhs/unidash/notify/Notifier.kt:55), [Notifier.kt:96](C:/Users/peter/Work/uni-dashboard/apps/android/app/src/main/java/dev/peteryhs/unidash/notify/Notifier.kt:96), [Notifier.kt:106](C:/Users/peter/Work/uni-dashboard/apps/android/app/src/main/java/dev/peteryhs/unidash/notify/Notifier.kt:106).

Posting returns immediately without permission, but the caller still records the alert key as shown. Granting permission later does not replay that active alert. Connection warnings use the same pattern.

**Fix:** return a posting outcome, mark a notification delivered only after posting succeeds, and reconsider pending notices when permission is granted.

## Improvements worth doing after the fixes

1. **Add automated client and build gates.** No repository CI workflow was found. Run backend tests, web typecheck/build, Worker dry run, Android unit tests, and Android compilation. Add targeted regression tests for polling overlap, configuration-load/save races, sign-out during refresh, and permission-denied alerts.
2. **Validate all boundaries consistently.** Web menu, dining recommendation, and some AI/configuration responses rely on TypeScript casts. Persisted preferences are also shallowly trusted: a stored `favoriteOutlets: null` reaches code that expects an array. Normalize preferences and use shared runtime schemas for response payloads. Relevant files: [preferences-store.ts:72](C:/Users/peter/Work/uni-dashboard/apps/web/src/lib/preferences-store.ts:72), [api.ts:335](C:/Users/peter/Work/uni-dashboard/apps/web/src/lib/api.ts:335).
3. **Keep contracts synchronized.** Kotlin models and the web TypeScript bridge are maintained separately from the runtime contract. Expand shared fixture coverage or generate client types, particularly for freshness states, optional fields, and schema-version changes.
4. **Make Android unavailable states explicit.** Android generally distinguishes stale/dead from live, but failed/degraded feed states are handled unevenly. For example, Today special-cases degraded next commitments but renders failed ones through the ordinary card path. Define a consistent unavailable state and a deliberate policy for reminders based on old cached events. Relevant files: [TodayScreen.kt:104](C:/Users/peter/Work/uni-dashboard/apps/android/app/src/main/java/dev/peteryhs/unidash/ui/today/TodayScreen.kt:104), [NotificationPlanner.kt:35](C:/Users/peter/Work/uni-dashboard/apps/android/app/src/main/java/dev/peteryhs/unidash/notify/NotificationPlanner.kt:35).
5. **Finish release/build preparation.** Android release builds intentionally use the debug signing configuration for sideloading; introduce a separate protected release key before distributing builds. Add the Windows Gradle wrapper and document the required JDK/SDK. Pin the supported Node runtime and make the date-based benchmark script portable across shells. Relevant file: [build.gradle.kts:25](C:/Users/peter/Work/uni-dashboard/apps/android/app/build.gradle.kts:25).
6. **Version database migrations and refresh documentation.** D1 initialization checks object names rather than schema versions/columns. Add explicit migrations before future schema changes. README still describes Android as future work despite the app being present; update setup, deployment, and current feature coverage. Relevant files: [d1-store.mjs:50](C:/Users/peter/Work/uni-dashboard/apps/relay/src/d1-store.mjs:50), [README.md:85](C:/Users/peter/Work/uni-dashboard/README.md:85).

## Suggested implementation order

1. Polling leases and snapshot consistency; Node write protection.
2. Android session invalidation; web office-hours load/save protection.
3. Credential persistence/atomicity/source scheduling and concurrent course saves.
4. Office-hours cache/validation; client invalidation and CFE consistency.
5. Notification delivery tracking, dining attempt claims, and CI/contract gates.
