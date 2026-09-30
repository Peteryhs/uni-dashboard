# Meaningful schedule changes

The personalization engine now considers room changes, unusual rooms, changed times and deadlines, explicit cancellations, removed sessions, and online tutorial work. Alerts appear in the existing daily recommendations and calendar details. Upcoming changes outrank routine suggestions; stale evidence is quieter and labelled as cached. Recommendation snoozes use the existing account-wide action store.

## Evidence and attendance

- A change compares the last saved occurrence with a successfully parsed replacement. The first sync establishes the baseline. Formatting-only room edits, past occurrences and failed refreshes do not create changes.
- `STATUS:CANCELLED` and `EXDATE` establish cancellation. Missing events are labelled **removed from calendar**, with a request to confirm the course instructions. Partial feeds cannot establish removals.
- A changed occurrence ID can match the same UID when there is exactly one matching occurrence on the same campus date, or one old and one new occurrence of a one-off event. Titles alone never establish a changed time.
- An unusual room needs at least three other matching sessions, with the usual room accounting for at least 75% of all occurrences including the exception. Recurring UID is preferred; an exact lecture/tutorial/lab title is the fallback. Different session types and sections stay separate. This is a warning to check, not proof that the calendar is wrong.
- Tutorial assignments on Crowdmark/online receive an instruction link. A title such as “Tutorial Assignment 3” alone does not prove a cancellation. Explicit tutorial cancellation/replacement wording confirms replacement work; only an explicit date in that wording, matching the course's tutorial, marks that classroom occurrence **replaced**. Undated nearby work gives a **check before attending** warning.
- A replaced tutorial remains visible in the calendar, labelled Replaced, but does not block a study window, become a class recommendation, count as a class to attend, or receive a class alarm. The next-commitment card also skips it. Its assignment remains in the normal task engine.
- Opening entries with a stated future due time remain cached even when their opening date falls outside the normal feed window. Changes to that instruction-derived deadline are tracked too. Removing the due wording requests confirmation rather than inventing a new deadline.

## Storage and clients

`calendar_change` is a bounded 14-day journal, added automatically by both SQLite and D1 schema initialization. It is written and pruned within the poll's existing lease-guarded transaction/batch, alongside the rows and receipt. A superseded poll cannot publish alerts. D1 uses one JSON-backed insert for a batch of changes rather than a query per changed occurrence. Reads return at most 1,000 journal entries and 100 visible alerts.

`/v1/calendar` adds `alerts` and each event's `attendance` (`scheduled`, `check_instructions`, `replaced`). Defaults preserve compatibility with older cached responses. Recommendations use the new `change` kind. No AI or upstream network request happens while reading either endpoint.

Android has a separate **Schedule changes** notification channel. Fresh changes affecting the next 48 hours are deduplicated by stable IDs; a whole recurring series moving in one poll is coalesced. Room and tutorial warnings are carried into the class reminder. Disabled notifications are not recorded as delivered, and a user-disabled channel stays disabled. Replaced or stale events do not schedule precise attendance alarms.

## Limits

Only connected calendar feeds and their supplied descriptions are evidence. Private announcements or Crowdmark content that is absent from those feeds cannot be detected. Updates arrive on the existing polling cadence (including the six-hour Google schedule cadence); this is not instant monitoring. No extra credentials or Workers AI calls are required. Production needs the updated Worker deployed and the Android app rebuilt.
