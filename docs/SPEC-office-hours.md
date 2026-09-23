# Spec: Office hours — paste, parse with AI, manage as entries

Status: ready to build
Depends on: nothing outstanding. `SPEC-deadlines.md` is shipped.

---

## 1. What this is

Paste the text a prof wrote about office hours. An AI turns it into structured recurrence rules.
You review and correct the result, then save it. Saved rules become real recurring events on the
dashboard, managed from Settings as a list you can view, edit and delete.

Example input:

```
Office hours: Mon & Wed 2:00-3:00pm in E7 3416, starting next week through Dec 5.
TA session Thursdays 10:30-11:20 in DC 2568 (no session during reading week).
```

Two entries, two different weekday sets, two locations, one with an end date.

## 2. Why AI belongs here

This is unstructured text to a validated schema, with the user present to confirm. That is the
opposite of the deadline-triage case rejected in `SPEC-deadlines.md`: nothing is silently omitted,
every field is visible and editable before it is persisted, and there is no hidden ground truth the
model is guessing at. The user is the source of truth.

**Hard rule: the model never writes to storage.** It returns a draft. A save is a separate,
explicit user action.

## 3. Model and output validation

Default to the existing `DEFAULT_AI_MODEL` (`@cf/google/gemma-4-26b-a4b-it`). It already produces
schema-conforming JSON for the food ranker, and this task is easier.

Cloudflare's `response_format: { type: 'json_schema', json_schema: {...} }` gives *constrained*
decoding, but only on a documented model list which does not currently include Gemma. So:

- Send `response_format: { type: 'json_schema', json_schema: <schema> }` always. Models that
  support it are constrained; models that do not will ignore the field and still follow the prompt.
- **Validate every response with the Zod schema.** This is the real guarantee, not the model.
- On validation failure, **retry once** with the validation error appended as a user message
  ("Your previous reply failed validation: <error>. Return only valid JSON matching the schema.").
- On second failure, return a 502 with the raw text included so the user can see what happened and
  hand-enter the entry instead. Never fabricate a fallback rule.
- Let the user pick a different model from the existing `POPULAR_MODELS` list in the parse UI, so a
  bad result is one dropdown away from a retry.

Cloudflare also documents that JSON mode can fail outright with a `JSON Mode couldn't be met`
error. Treat that as a normal failure path with a readable message.

## 4. Data model

### 4.1 New contract schema

New file `packages/contract/src/office-hours.mjs`, exported the same way `card-data.mjs` is.

```
OfficeHourRule = {
  id: string,                    // nanoid-style, generated server-side on save
  course: string,                // "ECE 198"; may be empty
  label: string,                 // "Prof office hours", "TA session"
  kind: 'office_hours' | 'tutorial' | 'help_session' | 'other',
  host: string,                  // "Prof. Smith"; may be empty
  location: string,              // "E7 3416"; may be empty
  byday: ('MO'|'TU'|'WE'|'TH'|'FR'|'SA'|'SU')[],   // min 1
  start_local: string,           // "14:00", 24h wall clock
  end_local: string,             // "15:00"
  starts_on: string | null,      // "2026-09-29" inclusive, null = immediately
  until: string | null,          // "2026-12-05" inclusive, null = +120 days
  notes: string,                 // "no session during reading week"
  confidence: number,            // 0-1, model's own confidence
  source_text: string,           // the pasted text this came from, for auditing
  created_at: number,
  updated_at: number,
}

OfficeHoursConfig = { rules: OfficeHourRule[], version: 1 }

OfficeHoursDraft = { rules: <OfficeHourRule without id/created_at/updated_at>[], warnings: string[] }
```

**`start_local` / `end_local` must stay wall-clock strings, never epochs.** `zonedToEpoch` in
`sources/ics/parse.mjs` resolves local time to epoch through a two-pass `Intl` offset convergence,
which is what makes DST correct. Storing epochs would silently shift every office hour by an hour
after the November clock change.

`warnings[]` is how the model reports what it could not determine ("no end date stated, defaulted
to end of term"). Surface these in the preview.

### 4.2 Storage

One JSON blob in the existing `setting` table under key `OFFICE_HOURS_JSON`, value is
`JSON.stringify(OfficeHoursConfig)`.

The `setting` table already exists in `schema.mjs` and is documented as "configuration the owner can
change from the app". No migration needed.

Two gates must be extended to allow the new key:

- `apps/relay/src/worker.mjs:41` — `WRITABLE_SETTINGS`. Existing validators are URL and token
  regexes; this one needs a different shape: parse as JSON, then `OfficeHoursConfig.safeParse`.
  Reject on failure. Do not accept arbitrary strings.
- `apps/relay/src/server.mjs` — the `/v1/credentials` handler near the `looksLikeIcsUrl` /
  `looksLikeToken` helpers. **Note the comment there**: values are written into `.env` line by
  line, so a newline in a value can inject a second variable. A JSON blob will contain characters
  that path cannot safely hold. Do not route `OFFICE_HOURS_JSON` through the `.env` writer — write
  it only via `store.setSetting`, which is already parameterised SQL.

---

## 5. Server

### 5.1 `apps/relay/src/ai.mjs` — generic structured call

Extract a reusable helper without touching `rankDailyMenu`'s behaviour:

```
runStructured({ systemMessage, userMessage, schema, jsonSchema, model, cfEnv, env,
                accountId, apiToken, cacheKey, ttlMs, now, force })
  -> validated object
```

It must reuse the existing machinery rather than duplicating it:

- Strategy 1 `env.AI.run(model, ...)` Worker binding, Strategy 2 the REST endpoint
  `https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/{model}`, same 90s
  `AbortSignal.timeout`.
- The existing `parseAiResponse` response-shape handling (`choices[0].message.content`, `.response`,
  raw string) and `extractJson` brace-matching. Factor the shape-unwrapping out of the
  food-specific `parseAiResponse` so both callers share it.
- `hashKey` / `cacheKey` for caching, and the `.ai-cache.json` disk mirror via `nodeBuiltin`.
- Same failure philosophy: throw with a readable message, never return fabricated data.

Then refactor `rankDailyMenu` to call it. Its observable behaviour must not change.

**Cache TTL for parsing: 1 hour, keyed on `hashKey(text + model)`.** Short because the user may be
iterating on the pasted text; long enough that an accidental double-click does not spend two calls.

### 5.2 Prompt

System message requirements, stated explicitly because they are where accuracy comes from:

- Today's date and the configured timezone (`config.timezone`) must be in the prompt. "starting
  next week" is unresolvable without it.
- Output weekdays as the two-letter iCalendar codes, and be told that `MW` means `['MO','WE']`,
  `TTh` means `['TU','TH']`, `MWF` means `['MO','WE','FR']`.
- Times as 24-hour `HH:MM`. `2-3pm` in an academic context means `14:00`-`15:00`, not `02:00`.
- A UW class-time convention worth stating: times like `10:30-11:20` are a standard 50-minute
  slot. Do not "correct" them to 11:30.
- Emit one rule per distinct weekday-set + time + location combination. `Mon & Wed 2-3` is **one**
  rule with two `byday` entries, not two rules. But a Mon 2-3 and a Thu 10-11 session are two
  rules.
- Put anything not representable in the schema into `notes`, and anything uncertain into
  `warnings`. Reading-week exclusions go in `notes` — the schema has no exception-date support in
  v1.
- Never invent a location, host, or end date. Empty string or null is correct when the text is
  silent.

Include the §1 example as a few-shot pair with its expected JSON output.

### 5.3 Endpoints

All three follow the existing `send()` / bearer-token pattern in `server.mjs`, and need the
equivalent handlers in `worker.mjs`.

**`POST /v1/ai/parse-office-hours`**
Body `{ text, course?, model?, force? }`.
Returns `200 { draft: OfficeHoursDraft, preview: PreviewOccurrence[], model }`.
`preview` is the first 6 generated occurrences across all draft rules, as
`{ rule_index, starts_at, ends_at, label, location }`, produced by the same expansion code the
source uses (§5.4) so the preview cannot disagree with what gets saved.
Errors: `400` invalid/empty body, `502` with `{ error, raw? }` on AI failure.
**This endpoint never writes to the store.**

**`GET /v1/office-hours`** → `200 OfficeHoursConfig`. Empty `{ rules: [], version: 1 }` when unset.

**`PUT /v1/office-hours`**
Body `OfficeHoursConfig`. Validates with Zod, assigns `id`/`created_at`/`updated_at` for any rule
missing them, persists via `store.setSetting`, then triggers an immediate poll of the office hours
source so the dashboard updates without waiting for the next cron tick.
Returns `200 { config, rows_written }`. `400` on validation failure with the Zod error.

This is the full CRUD surface: the client reads the whole config, mutates the array locally
(add/edit/delete), and PUTs it back. Simpler than per-rule routes and matches how the list is
edited in practice.

### 5.4 New source: `sources/office-hours/source.mjs`

Register as `userOfficeHours` in `sources/registry.mjs` — "one file, one line here", per that
file's own comment.

```
id: 'user-office-hours'
shape: 'timeline_event'
role: 'office-hours'
cadenceMs: 6 * 60 * 60 * 1000     // 6h; rules change rarely, the window still slides
needsSecret: false
windowDays: 60                     // matches the ICS sources
```

**Why a source and not a one-shot write at save time.** The expansion window slides forward. Rows
written once go stale as the term advances and would need their own refresh path. As a source it
inherits the entire existing machine: freshness envelope, `tombstoneMissing` (already scoped by
`source_id`, so it cannot touch the ICS feeds), run receipts, `sourceHealth`, `/v1/poll?source=`,
and the circuit breaker.

`fetchRaw(ctx)` reads `OFFICE_HOURS_JSON` from the store rather than making an HTTP request, and
returns `{ status: 200, contentType: 'application/json', body: <the raw json string>, bytes }`.
An unset setting returns `{ status: 200, ..., body: '{"rules":[],"version":1}' }` — an empty rule
set is a valid state, not a failure.

**One plumbing change required.** `runner.mjs` builds `const ctx = { now, date }` and calls
`source.fetchRaw(ctx)`. Add `store` to that object. Every existing source ignores extra ctx keys,
so this is additive and safe.

`plausible(raw)` — `ok` when the body parses as JSON and satisfies `OfficeHoursConfig`. Otherwise
`{ ok: false, reason: 'stored office hours config is invalid' }`. Not a credential failure.

`parse(raw, ctx)` — for each rule, build a synthetic event and expand it:

- Construct `{ uid: \`office-hours-${rule.id}\`, summary, location, rrule, start, end }` where
  `rrule` is `FREQ=WEEKLY;BYDAY=<joined>` plus `UNTIL=<from rule.until>` when set.
- Call the **existing** `expandRecurrence` from `sources/ics/parse.mjs`. It already supports
  `FREQ=WEEKLY` with `BYDAY`/`INTERVAL`/`COUNT`/`UNTIL`, and its header documents a BYDAY bug that
  was already fixed (a MWF class emitting 5 occurrences per term instead of 14). Do not write a
  second expander.
- Resolve wall-clock times through `zonedToEpoch` with `config.timezone`.
- Window: `now - 12h` to `now + 60 days`, same as the ICS sources.
- Row shape, matching the existing canonical row:
  `{ source_id: 'user-office-hours', external_id: \`office-hours-${rule.id}#${iso}\`,
     uid: \`office-hours-${rule.id}\`, observed_at: now, valid_until: now + 24h,
     kind: 'office_hours', title: <label, course-prefixed when course is set>,
     subtitle: host, location: rule.location, all_day: false,
     starts_at, ends_at, url: '', description: rule.notes }`

`until` defaults to `now + 120 days` when null, so a rule with no stated end still generates.

**Verify before relying on it:** `validateRows(source.shape, ...)` in `runner.mjs` calls into
`#contract/canonical.mjs`, which was not inspected for this spec. Check whether `kind` is a free
string or a closed enum there. If it is an enum, add `'office_hours'` to it. Also
`NextCommitmentData.kind` in `card-data.mjs` **is** a closed enum
(`['class','exam','deadline','event']`) and will reject `'office_hours'` — extend it.

### 5.5 Card integration

Office hours must **not** take the hero card. `nextCommitmentCard` is deliberately scoped to
`SCHEDULE_SOURCE = 'uw-portal-ics'`, with a comment explaining that LEARN's volume kept hijacking
the countdown to the next class. Office hours are optional attendance and would do the same thing.

Leave `nextCommitmentCard` alone in this change. Office hours become visible through
`/v1/dashboard`'s underlying rows and are rendered in Settings; a dedicated card or a badge on the
hero is a follow-up decision, not part of this spec.

---

## 6. Client

### 6.1 `apps/web/src/lib/api.ts`

Three functions following the existing `fetch('/v1/ai/rank-food')` + bearer-token pattern:
`parseOfficeHours(text, opts)`, `getOfficeHours()`, `putOfficeHours(config)`.

### 6.2 Settings: a fourth tab

`customization-sheet.tsx` currently has three tabs — `taste` (Taste AI), `preferences` (General),
`credentials` (Feeds) — in a `grid-cols-3` `TabsList` at line 164. Add a fourth, `schedule`
("Schedule"), and change the grid to `grid-cols-4`. Reuse the existing tab trigger styling
verbatim, including the `focus-visible:ring-live` treatment.

**Tab layout, top to bottom:**

**Add new** — a `Textarea` for the pasted text, an optional course `Input`, a model `select`
defaulting to `DEFAULT_AI_MODEL` (populate from the existing `GET /v1/ai/models`), and a
`Parse with AI` button.

**Preview state** — after parsing, an editable card per draft rule. Every field editable:
course, label, kind, host, location, weekday toggle buttons, start/end time inputs, starts-on and
until date inputs, notes. Show `confidence` as a small badge, and show any `warnings[]` as an amber
note above the cards. Below, the returned occurrence preview as a plain list ("Mon Sep 29,
2:00-3:00pm · E7 3416") so the user sees concrete dates before committing.

Buttons: `Save`, `Discard`, `Re-parse` (re-runs with `force: true`, optionally after switching
model).

**Saved entries** — the CRUD list. One row per rule showing course, label, a human recurrence
summary ("Mon, Wed · 2:00-3:00pm · E7 3416 · until Dec 5"), and per-row `Edit` and `Delete`.
`Edit` opens the same editable card as the preview. `Delete` asks for confirmation and must be
undoable in-session, matching the undo-toast pattern already used for dismissals in
`due-soon.tsx`.

All mutations follow the same cycle: mutate the local array, `PUT /v1/office-hours`, then refetch.

**Accessibility, not optional:** every input needs an associated `Label` with a real `htmlFor`,
weekday toggles must be `aria-pressed` buttons in a group with an accessible name, the parse button
needs a busy state (`aria-busy`, disabled, visible spinner) because the call can take many seconds,
and the result must be announced via an `aria-live="polite"` region. Errors render as text next to
the control, never as colour alone.

### 6.3 Where office hours are *not* shown

No changes to `due-soon.tsx`. Office hours are not deadlines and must not enter that card. It is
source-scoped to `uw-learn-ics`, so this is already true — do not widen that query.

---

## 7. Test fixtures

Add `fixtures/office-hours/*.txt` with real-world phrasings. The parse tests should assert on the
**expanded occurrences**, not on prose, so they stay meaningful.

```
1. "Office hours: Mon & Wed 2:00-3:00pm in E7 3416"
   -> 1 rule, byday ['MO','WE'], 14:00-15:00, location E7 3416

2. "My office hours are TTh 10:30-11:20 in DC 2568"
   -> 1 rule, byday ['TU','TH'], 10:30-11:20  (50-minute slot preserved)

3. "OH Fridays 1-2pm starting Oct 3 until the last day of class Dec 5"
   -> 1 rule, byday ['FR'], 13:00-14:00, starts_on 2026-10-03, until 2026-12-05

4. "Prof Smith: Mon 9-10am E7 3416. TA Jane: Thu 3-4pm online."
   -> 2 rules, distinct hosts, second has no physical location

5. "Office hours by appointment only, email me"
   -> 0 rules, warnings non-empty  (nothing recurring to represent)

6. "MWF 11:30-12:20, no class during reading week"
   -> 1 rule, byday ['MO','WE','FR'], reading-week text in notes
```

Case 5 is the important one: the honest answer is zero rules plus a warning, not an invented
weekly slot.

## 8. Acceptance criteria

1. Pasting example 1 produces one rule with `byday: ['MO','WE']` and `14:00`-`15:00`, and a preview
   listing real dates.
2. Pasting example 5 produces zero rules and a visible warning. Nothing is saved.
3. A parse never writes to the store. Verifiable: call the parse endpoint, then confirm
   `GET /v1/office-hours` is unchanged.
4. A malformed AI response triggers exactly one retry, then a 502 whose message is readable in the
   UI. No fabricated rule ever appears.
5. Saving a rule causes rows to appear in `timeline_event` under `source_id = 'user-office-hours'`
   on the next poll, and the PUT triggers that poll immediately.
6. Editing a rule's time updates existing rows rather than duplicating them — `external_id` is
   stable across edits because it derives from `rule.id`.
7. Deleting a rule tombstones its rows. No other source's rows are affected.
8. A rule spanning the November DST change generates occurrences at the same local wall-clock time
   on both sides of it.
9. An invalid `OFFICE_HOURS_JSON` in the store yields an `implausible`/`failed` run receipt and a
   readable state, and does **not** tombstone previously good rows.
10. Office hours do not appear in the deadlines card, and do not take the hero card.
11. `OFFICE_HOURS_JSON` is never written through the `.env` writer path.
12. The Schedule tab is fully keyboard navigable; every control has an accessible name; the parse
    button exposes a busy state.
13. `npm test` passes, including new tests for the rule-to-occurrence expansion and each fixture.
    `npm run web:build` and `npm run web:typecheck` pass.
14. The food AI path is behaviourally unchanged after the `runStructured` refactor — existing food
    tests still pass untouched.

## 9. Deliberately out of scope

- **Per-occurrence cancellations** (reading week, holidays). v1 puts them in `notes` as text. The
  dismissal mechanism from `SPEC-deadlines.md` is per-occurrence and localStorage-only, so reusing
  it here would put schedule truth in the browser. Needs a server-side exception-dates list; file
  separately.
- **A dedicated office hours card**, and any hero-card badge.
- **Term start/end as first-class config.** `until` defaults to +120 days when the text is silent.
  A real term-dates setting would serve this and the deadlines horizon both; worth doing once,
  later.
- **Importing office hours from a syllabus PDF.** Same parse path, different input handling.

## 10. Known-adjacent gaps, not part of this change

Two items from `SPEC-deadlines.md` that did not land, noted so they are not lost:

1. **AC10 is unmet.** Dismissal only ever writes `occurrence_id`; nothing in the client dismisses by
   `uid`, so hiding the nine `MATH 117 Tutorial N - Available` rows still takes nine clicks. Both
   `checkDismissed` and the restore path already honour `uid` — only the write side is missing.
2. **`dismissedTasks` is never pruned** in localStorage. Only the derived `uniqueHidden` is filtered
   against the current payload, so the stored array grows across terms.
