# v1 readiness — 2026-10-11

The README now describes the implemented web, native Android, Node relay and Cloudflare Worker targets. This is preparation for v1, not a release announcement. Package versions remain `0.1.0`; no release tag or signed distribution has been produced by this audit.

## Latest audit and fixes

| Area | Finding and result |
|---|---|
| Recommendation warnings | Replaced visible warning labels with icons beside timing. Web explanations open on hover, keyboard focus and tap; Android uses native Material tooltips and full accessible descriptions. Each platform retains its existing colors and components. |
| Web dining dates | Today/Tomorrow previously stayed fixed after campus midnight and used device-dependent date arithmetic. Menu query keys now follow Toronto dates using the existing local clock. Office-hours occurrences also display campus time. |
| Saved menus | Posted-menu responses now include the original observation time, cadence and age state. The web labels ageing or failed reads as saved information without a new timer, database query or AI call. |
| Concurrent task actions | Atomic compare-and-set merges preserve unrelated Done, dismiss, snooze and Undo actions submitted together. Bounded contention returns a retryable conflict. |
| Daily AI attempt caps | Food and alert counters use atomic claims. Automatic work defers after one contested claim, keeping a large poll plus remaining cron work below the 50-statement regression limit. Isolated/manual claims retain bounded retries. Jobs cannot consume the same remaining slot or rewind a newer UTC day; contention stops before inference. The shared estimated 7,000-neuron reservation remains in force. |
| Worker configuration | Each invocation gets one immutable binding/settings snapshot through `AsyncLocalStorage`. Overlapping requests cannot exchange feed configuration through mutable `process.env`. The existing settings read is reused. |
| Local credentials | Removed the build-time web token default. Local credentials saved by the app create/restrict `.env` to mode `0600` on POSIX; Windows file access remains governed by its ACL. |
| Android permission timing | Sign-in no longer immediately launches the notification permission prompt. Settings → Notifications owns the explicit enable action. Background reconciliation still runs when allowed. |
| Android expressive UI | Ranked Focus leads with a paired primary tonal container; secondary items stay compact, and the unrelated next commitment follows Focus. Saved dining picks use secondary emphasis with local request/job feedback. Main destinations fade out before switching and fade in afterward, preserving saved tab state and blocking hidden content interaction. Disclosures, list placement and container changes use the theme's effects/spatial springs; Settings uses native segmented items with press/focus shape feedback. No refresh or AI work was added. |
| Android audit follow-up | Empty Focus no longer contradicts a valid upcoming commitment. A saved dining pick remains visible when its menu is unavailable, and reranking is disabled until usable menu data exists. Navigation keeps keyboard focus during tab changes. The existing health-request race test now holds both responses explicitly instead of assuming the newer request cannot finish before its busy-state assertion. |
| Android composition redesign | Large flexible headers distinguish Today/Dining/Settings from the dense agenda and compact nested settings. Focus has a visible primary action and a connected secondary list. Calendar uses actual date tiles, a time column and segmented filters with a wrapping larger-text fallback. Dining outlets expand with saveable choices, keeping actual highlighted dishes and complete dietary/station details. Connections and permission controls use contained whole-row actions. Review restored non-completable lead dismissal, removed duplicate size animation, corrected paired colors, and gave explanation disclosures stable lazy-list keys. |
| Documentation | Replaced proposed infrastructure and “future Android app” claims with actual setup, authentication, polling, notification and offline behavior. Corrected the menu cadence to four hours. |

The review also checked notification expiry/cleanup, shared cache behavior, source polling and quota-sensitive reads. One deployment is one personal shared data space: every authorized Access identity can modify its data and connections. It is not a multi-user account boundary.

The next Android refinement adds predictive parent previews for nested settings and recommendation explanations, returns the other main tabs to Today, and leaves root back-to-home to Android. Completed gestures commit before settling; cancelled gestures preserve the current route, and preview pages cannot initiate source refreshes. Main navigation reopens Today/Settings at their overview while retaining list state. Secondary tasks have roomier insets; compact agenda rows place time above the title, align details with summaries and avoid duplicated locations. Settings removes its header tint/band while retaining errors in the status action and Status page. The setup guide now uses a native Material sheet with predictive dismissal.

## Checks completed

| Check | Result |
|---|---|
| Node/backend/shared/web-helper suite | 443 passed, none skipped, including concurrent actions/counters, overlapping Worker settings, local HTTP authentication, campus midnight/DST and posted-menu age. |
| Local D1 row budget | Calendar and recommendation reads stay below the regression's 1,000-row limit with a week of minute receipts; no data writes or AI calls on these reads. Included in the suite above. |
| Web production build | Type-check and build passed. Existing third-party annotation and bundle-size warnings remain. |
| Worker bundle | Dry run passed with the current D1, AI and assets bindings; no deployment. The suite also exercises the actual local Wrangler assets router. |
| Android | Debug APK built; all 141 unit tests passed, including cancelled/completed predictive gestures and button-back fallback. Unrestricted lint completed with 0 errors and 11 warnings using a single build worker. |
| Web visual/interaction check | Checked desktop and 390/375-pixel layouts using synthetic data. Icons sit beside timing; narrow screens have 44-pixel targets and no horizontal overflow. Tap/focus tooltips, Escape dismissal and separate recommendation expansion work. |
| Android design contract | Local checks found no broken design token references or insufficient text contrast in declared component pairs. Custom fallback text/container pairs exceed 4.5:1. The external document validator was blocked by automatic approval review because it would download and execute an unverified package; it was not run. |

Parallel lint analysis crashed in the pinned FIR/UAST tooling, first in `RepeatOnLifecycleWrongUsage` and later in `UnrememberedMutableState`. An earlier ignored local init script disabled only the first detector. The final single-worker verification uses no init script or rule suppression and completes unrestricted lint. Keep `--max-workers=1` in local checks for this pinned setup; the successful run does not establish that parallel analysis is reliable.

Native rendering remains unverified: this workspace has no connected phone, installed emulator/system image or layoutlib renderer. The [official Android tooling requirements](https://developer.android.com/studio/install) do not support this Windows ARM host; no speculative emulator packages were downloaded. Compilation and source review establish buildability and intended behavior, not the rendered appearance, touch behavior or TalkBack result on a phone.

## Before distributing v1

- [ ] Test a real Android device: tooltip tap/long-press, TalkBack, keyboard navigation, larger fonts, pull-to-refresh, quiet background updates and dining controls. Check predictive-back completion/cancellation from every nested page and main tab, a swipe during page entry, root back-to-home, three-button back, setup-sheet dismissal, rapid tab changes, restored scroll/disclosure state, RTL, animation scale set to zero, both themes and wallpaper-derived colors. Check the refined task/agenda insets against actual device text sizes. No device or emulator was attached during this audit. Check API 29/33 notification fallbacks and API 36+ system promotion separately.
- [ ] Exercise reminder and live-tracker cleanup on device through expiry while offline, room/time changes, cancellation, reboot, Unpin, permission/channel denial, disabled tracking and sign-out/sign-in. Unit tests do not establish system presentation or alarm delivery.
- [ ] Review the deployed Access policy for the intended owner and the Android OAuth flow. Use a separate Worker/D1 instance for another student's private feeds.
- [ ] Check real Cloudflare D1 row totals, AI totals and Worker CPU percentiles/errors. CPU has a per-invocation allowance, not a daily pool. Account authentication did not permit verification of live account usage in this local audit.
- [ ] Configure an Android release signing key and retention/backup plan. Current release configuration uses the debug key; do not distribute it as a signed v1 release.
- [ ] Confirm the licence and add its standalone file. Package metadata currently declares ISC.
- [ ] Select release versions, write release notes and produce reproducible build artifacts after the checks above.

## Known limits to carry into release notes

- A poll that already holds a lease can finish using its captured old feed after a connection is changed. Request-scoped configuration fixes cross-request leakage, but does not fence results against a newer feed configuration. Add a configuration-generation fence if immediate rotation guarantees are required; the setup flow still requires a successful sync after a change.
- Client caches belong to a trusted browser/device and the personal deployment. Clear browser site data when handing a profile to someone else.
- The web shell has no service worker for a cold offline start. Saved data can still appear after the shell loads and a request fails.
- Scanned syllabus PDFs need OCR/extracted text before import. Source cadence, upstream rate limits and Android notification permissions continue to affect availability.
- The [Cloudflare usage audit](CLOUDFLARE-USAGE.md) measures a local scenario of one continuously open browser plus one phone at about 4.23 million D1 reads/day. It is not a guarantee for arbitrary feed size, extra clients or other account workloads. These audit fixes add no automatic polling or AI generation.

See the [README](../README.md), [deployment guide](DEPLOYMENT.md), [notification guide](ANDROID-NOTIFICATIONS.md) and [usage audit](CLOUDFLARE-USAGE.md) for operating details.
