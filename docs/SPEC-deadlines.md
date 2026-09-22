# Spec: Deadlines card — Opens / Due / Ahead

Status: ready to build
Scope: `due_soon` card only. `next_commitment` is untouched.

---

## 1. Problem

The deadlines card windows on 7 days and truncates to 12 items. Measured against the live
LEARN feed in `relay.db` on 2026-09-22, that means:

- The card selects **13 items**, so the 12-item slice silently drops one.
- Everything that needs advance planning is invisible: `ECE190 midterm test` (29d),
  `ECE 190 Group Deliverable 1 Part 2` (36d), `COMMST Major Assignment 2` (62d).
- 9 of 68 upcoming rows are content *opening*, not work due (8 are `MATH 117 Tutorial N - Available`).
- 4 rows are wrong for this user: ECE 190 deliverables appear twice, once per group range,
  with two different dates.
- 3 rows are university admin dates from the portal feed (`Not Fees Arranged (NFA) holds applied`,
  tuition refund deadline), not coursework.

The card is not overloaded. It is too short, and its window hides the work that matters.

## 2. Goals

1. Show what is due now, in full.
2. Show when work *opens*, as a separate and visually secondary signal.
3. Show significant work for the rest of the term, grouped by week.
4. Let the user dismiss an irrelevant task, permanently.
5. Keep compact mode to a single glanceable answer.

## 3. Non-goals

- **No AI.** The discriminating signals are a title suffix, a bracket pattern, and a phrase list.
  All are exact and inspectable. Do not add a model to this path.
- **No cross-feed dedup.** Probed every LEARN×portal same-day title pair on the live data:
  zero matches. The overlap does not exist.
- **Do not treat `all_day` or absence-of-links as noise.** All 19 all-day rows are ECE 105, and
  every one is a real graded task (`Quiz #2`, `Assignment #2 due`, … `#11`). ECE 105 publishes a
  bare calendar with no times and no links. Filtering on either signal deletes a whole course.
- No changes to `next_commitment`, `food`, or `alert` payloads.

## 4. Verified data baseline

`uw-learn-ics`, upcoming, n=68:

| signal | coverage |
|---|---|
| course in `LOCATION` | 57/68 |
| ≥1 link in `DESCRIPTION` | 48/68 |
| prose body | 44/68 |
| `all_day` | 19/68 |
| ICS `URL` property | 0/68 |

Link kinds per event: `event` 48, `submit` 21, `quiz` 11, `module` 4. 20 events have no links.

Title suffix distribution: `- Due` 34, contains "due" 11, other 13, `- Available` 9,
`Availability Ends` 1.

Horizon: 0-3d **8**, 3-7d **3**, 7-14d **10**, 14-30d **10**, 30-60d **21**, 60d+ **16**.

---

## 5. Server changes

### 5.1 `sources/ics/source.mjs` — stable identity

`external_id` is already `${event.uid}#${iso}`. Expose the two parts separately on the parsed row
so the client can dismiss by series or by occurrence:

- `uid` — the bare UID, e.g. `6606-3800475@learn.uwaterloo.ca`
- keep `external_id` as-is

`uid` is not a `timeline_event` column; it will round-trip through `payload_json` the same way
`description` already does. No schema migration needed.

### 5.2 `apps/relay/src/task-context.mjs` — phase and group

Add two exported pure functions. Both are title-only, deterministic, unit-testable.

```
phaseOf(title) -> 'opens' | 'due'
```

- `/-\s*Available\s*$/i` → `'opens'`
- everything else → `'due'` (including `Availability Ends`, which is a last chance to act)

```
groupScope(title) -> { section: number|null, groups: [lo, hi]|null, base: string }
```

Parses `[Sec 002 Groups 1-20]`. `base` is the title with the bracket removed and whitespace
collapsed, used for display. Observed variants in the live feed:

```
Group Deliverable 1 (Part 1) submission [Sec 002 Groups 1-20] - Due
Group Deliverable 1 (Part 1) submission [Sec 002 Groups 21-40] - Due
Group Agreement Form submission [Sec 002 Groups 1-40] - Due
```

Return `{ section: null, groups: null, base: title }` when no bracket is present.

### 5.3 `apps/relay/src/cards.mjs` — `dueSoonCard` rewrite

**Source scope.** Query `source_id = 'uw-learn-ics'` instead of `kind IN ('deadline','exam')`.
This removes the three portal admin dates from coursework. Filter `starts_at >= now` with the same
`now - 5 * MIN` grace the hero card uses.

**Horizon.** Replace `now + 7 * DAY` with `now + 120 * DAY`. Ingest is already 60 days
(`windowDays = 60` in `source.mjs`) so 120 is a safe ceiling that needs no ingest change; the far
outliers in the data are two rows at 220d which will simply fall outside.

**Significance** — for the Ahead section only:

```
significant(item) =
     item.kind === 'exam'
  || /\b(group deliverable|major assignment|process task|project|midterm|final exam|report|presentation)\b/i.test(item.title)
```

Do not add a course-density term. Non-matching items are already excluded, which correctly keeps
ECE 105's weekly `Assignment #N due` out of Ahead while keeping `ECE190 midterm test` in.

**Payload.** Build three lists from the enriched rows:

- `due` — `phase === 'due'`, `starts_at` within 7 days. Full detail: `description`, `links`.
- `opens` — `phase === 'opens'`, within 7 days. Minimal: no `description`, no `links`.
- `ahead` — `phase === 'due'` and `significant`, beyond 3 days, grouped by ISO week.
  Minimal fields. Cap 24 items total.

Keep `count`, `nearest_at`, `window_days`, `items`, `courses` populated exactly as today for
bundle back-compat (contract rule: old clients must still render). `window_days` stays `7` and
describes the `due` list.

Raise the `items` slice from 12 to at least the length of `due`.

### 5.4 `packages/contract/src/card-data.mjs`

Extend `DueSoonItem` with, all optional so existing bundles still parse:

| field | type | notes |
|---|---|---|
| `uid` | `string?` | stable series id, for dismissal |
| `occurrence_id` | `string?` | full `external_id`, for single-occurrence dismissal |
| `phase` | `'due' \| 'opens'` optional | defaults to `'due'` |
| `all_day` | `boolean?` | drives the "no time" render path |
| `significant` | `boolean?` | |
| `group_scope` | `{ section: number \| null, groups: [number, number] \| null }?` | |

Extend `DueSoonData` with:

| field | type |
|---|---|
| `due` | `DueSoonItem[]` default `[]` |
| `opens` | `DueSoonItem[]` default `[]` |
| `ahead` | `{ week_start: number, label: string, items: DueSoonItem[] }[]` default `[]` |
| `next_major` | `{ title, course, starts_at } \| null` |

`label` is a display string like `"Week of Oct 6"`, computed server-side in `config.timezone`.
`next_major` is the soonest `significant` item beyond 3 days — this is what compact mode's footer
shows.

Mirror all of it in `apps/web/src/lib/contract.ts` (interfaces only, no runtime validation there).

---

## 6. Client changes

### 6.1 `apps/web/src/lib/preferences-store.ts`

Add to `UserPreferences`:

```ts
dismissedTasks: string[];      // uid or occurrence_id values
section: number | null;        // e.g. 2
groupNumber: number | null;    // e.g. 7
```

Defaults: `[]`, `null`, `null`. Bump `STORAGE_KEY` to `:v3` and keep the existing v2/v1 read
fallback chain so nothing is lost.

Hooks to expose: `dismissTask(id)`, `undismissTask(id)`, `isDismissed(id)`, `setSection`,
`setGroupNumber`.

**Auto-expire.** On read, drop dismissal entries whose task is no longer in the current payload.
Simplest correct version: prune in the card, not the store — when building the render list, keep
only dismissals that still match something. Do not let the array grow unbounded across terms.

### 6.2 Filtering, applied client-side

Two filters run in the card before render. Both are client-side deliberately: the server stays
free of per-user state, and the payload is small enough that this is not a performance concern.

**Dismissals.** Drop any item whose `uid` or `occurrence_id` is in `dismissedTasks`.

**Group scope.** When `section` and `groupNumber` are both set, drop any item where
`group_scope.groups` is non-null and `groupNumber` falls outside `[lo, hi]`, or where
`group_scope.section` is non-null and does not equal `section`. When either preference is unset,
show everything — never hide work because the user has not configured yet.

Recompute all counts after filtering. Never display a server count next to a filtered list.

### 6.3 `apps/web/src/components/cards/due-soon.tsx`

Replace `taskKey` with `occurrence_id` when present, falling back to `` `${title}@${starts_at}` ``
for old bundles. The current key breaks whenever a prof edits a title, which would resurrect a
dismissed task.

**Detailed mode** — three blocks, in this order:

1. **Due soon** — `due` items 0-3d. Full rows as today: course badge, cleaned title, link icon,
   day + time, amber styling under 24h, rose when overdue.
2. **Opens** — `opens` items 0-7d. Visually secondary: smaller text, dimmer, collapsed by default
   behind `Opens this week (2)`. No urgency styling, ever.
3. **Ahead** — `ahead` grouped by week. Week label as a small heading, then rows with course badge
   + title only. No times. Cap ~5 weeks visible with a `+N more` tail.

**Compact mode** — answers one question, "what do I touch today":

- The next **3** `due` items. Day + time, no course badge, no link icon.
- One footer line:
  `+5 due this week · 2 opens · next big: ECE190 midterm in 29d`
  built from filtered counts and `next_major`.

No Opens rows, no Ahead rows, no dismiss button in compact. The box is too small and the X would
be misclicked.

**All-day rendering.** ECE 105's tasks have no time. Render all-day items as the weekday plus a
muted `all day` marker, e.g. `Sat · all day`. Do not render them as a bare weekday next to
timed rows — it reads as missing data.

**Dismiss control.** An X button on each row, visible on hover/focus in detailed mode only. Must
be a real `<button>` with `aria-label="Hide {title}"`, and must not trigger the row's select
handler — the row is already a `<button>`, so restructure rather than nest. Clicking opens a
two-option affordance:

- `Hide this` → dismiss `occurrence_id`
- `Hide all "{base}"` → dismiss `uid`

The second option only appears when the item is part of a recurring series, i.e. more than one
visible item shares its `uid`. That is what kills the nine MATH 117 tutorial rows in one action.

Show an undo path: a small `N hidden · show` toggle in the card footer in detailed mode.

### 6.4 `apps/web/src/components/customization-sheet.tsx`

Add a **Courses** section with two number inputs, Section and Group, labelled to explain why they
exist ("LEARN publishes every group's deadline; tell us yours to hide the rest"). Also surface the
hidden-task list here with per-item restore.

---

## 7. Motivating examples from the live feed

These are real rows. Use them as fixtures.

**Should be hidden by group scope** (user in Sec 002, group 7):

```
Group Deliverable 1 (Part 1) submission [Sec 002 Groups 21-40] - Due   2026-10-08   ← hide
Group Deliverable 1 (Part 1) submission [Sec 002 Groups 1-20] - Due    2026-10-07   ← keep
```

**Should be dismissible** — LEARN publishes all streams to everyone, and no feed field says which
is the user's. The user is CE; none of these apply:

```
8 Stream MECH, SE - Mandatory Résumé Review Event    2026-09-22
8 Stream CIVE, SYDE - Mandatory Résumé Review Event  2026-09-23
8 Stream CHE, NANO - Mandatory Résumé Review Event   2026-09-24
```

**Should land in Opens, not Due:**

```
MATH 117  Tutorial 4 - Available              2026-09-28
MATH 117  Remaining Pre-MT Practice - Available  2026-10-05
ECE 198   Project Team Contract - Available   2026-09-23
```

**Should appear in Ahead and are invisible today:**

```
 29d  ECE190   ECE190 midterm test
 36d  ECE 190  Group Deliverable 1 (Part 2) submission
 37d  COMMST   Process Task: Progress Report & RADAR Analysis
 62d  COMMST   Major Assignment 2: Recommendation Report
```

**Should not appear in the deadlines card at all** (portal feed, admin not coursework):

```
Not Fees Arranged (NFA) holds applied          2026-09-23
Tuition and fee refund deadline - 100%         2026-09-29
Last day to select an examination centre...    2026-10-02
```

**Must keep working** — all-day, no links, no times, and entirely real:

```
ECE 105  Quiz #2           2026-09-25  all day
ECE 105  Assignment #2 due 2026-09-27  all day
```

---

## 8. Acceptance criteria

Against the 2026-09-22 `relay.db` snapshot, with section 2 / group 7 set and the three résumé
events dismissed:

1. `due` contains 8 items in 0-3d and 11 in 0-7d, minus dismissals. No `- Available` row appears
   in `due`.
2. `opens` contains exactly the 9 `- Available` rows within their window, rendered secondary and
   collapsed by default.
3. `ahead` includes `ECE190 midterm test`, all four `Group Deliverable` items, and all three
   `COMMST Major Assignment` items, grouped by week.
4. `ahead` excludes every `ECE 105 Assignment #N due` and `Quiz #N` row.
5. No `[Sec 002 Groups 21-40]` row is visible.
6. No portal admin date is visible in the card.
7. All 19 ECE 105 all-day rows still appear in `due`/`ahead` as appropriate, each showing
   `all day` rather than a bare weekday.
8. Compact mode renders exactly 3 rows plus one footer line, and the footer names the next
   significant item with a day count.
9. Dismissing a task persists across reload and across tabs.
10. `Hide all` on a MATH 117 tutorial removes all nine in one action.
11. An old cached bundle with no `due`/`opens`/`ahead` fields still renders via the existing
    `items`/`courses` path without throwing.
12. `npm run build` and the existing test suite pass. Contract validation via `validateCardData`
    must not reject the new payload.

## 9. Out of scope, worth filing separately

`timeline_event` contains rows dated `2012-04-09`. That points at the `expandRecurrence` catch
block in `sources/ics/source.mjs`, which falls back to emitting the original un-expanded `DTSTART`
when it meets an RRULE it cannot parse (it supports only `FREQ=DAILY|WEEKLY`). Harmless to the
cards because they filter `starts_at >= now`, but it means some recurring event is not generating
its occurrences at all. Worth a look; not part of this change.
