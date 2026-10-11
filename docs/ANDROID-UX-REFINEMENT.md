# Android UX refinement

The dashboard helps a student decide what to do next, find a room or deadline, and choose somewhere to eat. The Android app should present that information with fewer repeated summaries and controls. Notifications should answer the same practical questions while the app is closed.

## Visual contract

- Surface: a daily student dashboard, calendar, dining menu, and settings, using native Material 3 Expressive.
- User job: quickly identify the next action, its timing, and its location without opening multiple screens.
- Reference family: Material You native utility app; existing dynamic color, outlined/filled icon selection, type roles, shapes, and motion scheme are authoritative.
- Design source: DESIGN.md and existing Android theme, with the Material 3 Expressive skill's navigation, button, list, color, and feedback references.
- Density: readable compact lists; restrained containment for important recommendations, no repeated card summaries or walls of buttons.
- Layout: Today, Calendar, Dining, Settings remain stable primary destinations; related calendar categories use a native secondary tab row. Keep navigation bar on phones and rail on wider windows.
- Create mode: configuration remains on dedicated Settings destinations; no persistent create forms in daily lists.
- Required states: initial loading, saved/offline data, user refresh, silent automatic refresh, ranking request/processing/failure/limit, empty calendars, source warning, accessibility expansion/selection, and notification expiry/dismissal.
- Forbidden tells: a refresh icon beside pull-to-refresh, automatic spinning on every poll, repeated section titles, a conspicuous reranking button as the dining card's main action, nested decorative panels, fixed accent colors replacing dynamic roles, generic permanent notification text.
- Verification: regression tests for refresh origin/cancellation/session fencing and notification reconciliation; Android compile/test if SDK tooling is available; real native visual inspection where a device or renderer is available. Report any unavailable checks explicitly.

## Shared frame, Today, and Settings

1. Keep one visible refresh interaction: pull-to-refresh on data screens. Supply an accessible custom refresh action for people who cannot use the gesture. Settings overview/configuration pages do not need dashboard refresh gestures.
2. Separate actual network activity from user-requested refresh progress. Background worker/resume/live-loop requests retain cached content without a pull indicator or live-region announcement. Explicit pulls and source updates show progress only for the request the user initiated. Always clear that state on completion, failure, cancellation, or session replacement.
3. Preserve current session fences and concurrent source-update protections. Explicit refresh requests must not be lost behind an automatic request, nor leave a spinner stuck.
4. Remove repeated headings and redundant Open labels in settings; use native navigation affordances and meaningful descriptions. Keep source-health diagnostics in Status. Status has one explicit source-update action; configuration screens do not duplicate it in the app bar or as a refresh gesture. Put runtime and freshness explanations behind disclosure after the source list.
5. On Today, omit duplicate Next-up and Due-soon rows already represented by recommendations. Recommendations show title, timing, course, uncertainty/change indicators, and actual event progress; expose body/details and action buttons on expansion instead of repeating a button set under every collapsed row. Preserve swipe and accessible actions.
6. Add a short-lived `Snapshot.foodRankingSubmitting` state for the dining agent's immediate request feedback, separate from dashboard refresh and server processing; set/clear it in the repository with the same session fence. Coalesce duplicate ranking taps.

## Dining and calendar

1. Rename Food to Dining consistently in navigation and the screen title.
2. Put saved-pick reranking and the external posted menu in a native contextual overflow menu. When no saved pick exists and generation is allowed, show one in-context Find dining pick action; avoid duplicating it in the menu. Preserve offline/stale saved picks, server limits, retryable errors, and cancellation.
3. Render the picked restaurant and one reason as the main information. Use a quieter Material surface and correct paired content roles. Keep long explanation/tips behind disclosure, rather than repeating outlet verdicts throughout the page.
4. Request submission and server processing are different states. Disable duplicate requests immediately, give concise progress feedback in the pick area, and never use the page's pull indicator for ranking.
5. Keep outlet/dish grouping, dietary icons, posted dishes, URLs, and source freshness intact. Use Material lists/card grouping and native disclosure for quieter hierarchy.
6. Use fixed native secondary tabs for All, Classes, Deadlines; retain the moving Now marker, readable past entries, date-only handling, and source warnings from the previous changes.

## Notifications

1. There is one finite activity tracker, not two competing persistent notices. It names the actual activity/course, room, start/end time, and remaining time. During an activity, a horizontal bar represents elapsed scheduled time, never invented assignment completion. Before it starts, show a countdown rather than fake progress.
2. Expanded tracker content names the next real commitment or deadline with its title and time. Keep this concise; no generic Next task placeholder or empty permanent notice. Stop when the activity ends, disappears, becomes stale, or is dismissed; respect dismissal across sync and reboot.
3. Use the native progress notification template where supported, with a conventional compatible progress notification on older Android. Use only verified AndroidX/platform APIs. Promotion is requested only for imminent/ongoing tracking, and availability remains controlled by Android/user settings.
4. Recalculate progress at useful bounded intervals without per-second wakeup alarms. Use system chronometer for the countdown, and event boundaries for timely transitions/expiry. Keep ordinary updates silent and the same stable notification ID/tag.
5. Reconcile all app notification categories against current evidence and actual active notifications, not just class/deadline reminder records. Remove ended, changed, removed, dismissed, superseded, orphaned, and legacy notices. Schedule-change notices expire at their actual relevance boundary, not a blanket 24-hour timeout. Cap/coalesce repeated schedule changes rather than flooding the shade.
6. Notification timeout, explicit expiry cleanup, startup/reboot reconciliation, successful refresh/action reconciliation, permission changes, and sign-out must agree. Do not resurrect notices dismissed by the user or let an old session's alarms restore them. Test these cases directly.
7. Completed deadline tasks stop their reminders using the exact calendar event identity, including account actions made on the web. The recommendation contract supplies `source_event_id` and diagnostic `suppressed_action`; never guess an identity from the title. A locally accepted Done action persists through a failed reload, while a newer authoritative Undo restores reminders. Calendar attendance and scheduled activity tracking remain distinct from task completion.

## Review refinements

- Preserve errors through quiet polls and keep each destination's saved filter, disclosure, and scroll state. Changing a calendar category returns that category to the top.
- Distinguish first loading from unavailable or empty content on Dining and Calendar. Older posted menus use their service date instead of claiming to be serving today.
- Acknowledged actions succeed independently of a subsequent feed read. Reconcile their notification effects immediately, retain local alert dismissal, and show any reload failure separately. Failed concurrent actions restore only their own row.
- Serialize source/health reads and fence results and busy state by request owner. Source cancellation removes its progress placeholder; a source update and failed content reload remain separate facts.
- Cap change digests without marking omitted notices as delivered. Only recurring room moves coalesce; separate task changes retain independent identities.
- Schedule cleanup at calendar freshness expiry as well as event expiry, so an offline device does not retain notices beyond their evidence.
- Permission checks explicitly handle revocation; boot reconciliation accepts only the manifest's expected system actions.

## Implementation ownership

- Shared frame/refresh/Today/Settings agent: UI shared files, AppRoot, MainViewModel, DashboardRepository and related refresh tests. Owns the `foodRankingSubmitting` integration field; coordinate its name with the dining agent.
- Dining/calendar agent: FoodScreen and its supporting presentation helpers/tests; CalendarScreen category tabs only (preserve existing marker/past-event implementation). Do not edit shared state files.
- Notifications agent: notify package and its tests, notification-related receiver/manifest changes if needed. Coordinate settings copy/API changes with the shared-frame agent.
- Parent: integration, build tooling, independent full review, documentation, final checks and fixes.

## Verification and review outcome — 2026-10-11

- Three implementation agents used GPT 6 Luna with extra-high reasoning, after the codebase/design review and scoped plan. The parent reviewed the combined implementation, and agents cross-reviewed shared state, Dining/Calendar, and notifications.
- The combined Android debug APK builds successfully. All 138 Android unit tests pass, including queued manual refresh, source/health serialization, cancellation/session fencing, conservative recommendation duplicate detection, and automatic refresh/calendar reuse.
- All 429 backend/web tests pass, and the web production build succeeds. The web warning and calendar presentation was visually inspected during its implementation.
- A focused harness exercising the actual notification controller against fake Android boundaries passes 31 lifecycle scenarios, including expiry, stale calendar evidence, capped change digests, dismissal, account fencing, acknowledged Done, explicit newer Undo, and campus incident replacement. This supplements the native Gradle unit tests; it does not substitute for a device test.
- Android lint reports zero errors and 11 warnings with only the upstream `RepeatOnLifecycleWrongUsage` detector disabled by an ignored local verification script. The unrestricted detector crashes in the pinned Lifecycle/Kotlin analysis combination while inspecting unchanged MainActivity code. The committed lint configuration has no suppression for that crash. Remaining warnings concern dependency updates, API-specific attributes, and optional KTX conveniences.
- DESIGN.md passes its official linter with zero errors/warnings; the combined diff passes whitespace checks.
- Native visual, touch, TalkBack, and actual notification-shade behavior still need device verification. No Android device is connected and no suitable native emulator is installed in this workspace environment. No native screenshot approval is claimed.
- Completion-aware deadline reminder cleanup relies on the additive `source_event_id` / `suppressed_action` metadata. Ship the backend and app changes together; older backend payloads remain readable but cannot identify those completed deadlines precisely.

The review fixed additional confirmed issues beyond the initial examples: acknowledged actions misreported after failed reads, concurrent action rollback restoring unrelated rows, source checks overwriting newer results, sticky cancellation progress, duplicate deadline titles with a Due suffix, notification evidence surviving freshness expiry, and new campus incidents being treated as quiet updates.

The follow-up [Cloudflare usage audit](CLOUDFLARE-USAGE.md) additionally fixed an exhaustive calendar receipt scan. Automatic Android reads now share a complete successful response younger than one minute, with a five-minute calendar cadence matching the web. Explicit refreshes and mutation/source reloads remain immediate, and timers continue to run locally.
