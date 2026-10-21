# Study spaces: live library occupancy

## What this is

A new below-the-fold section, **Study spaces**, that shows live occupancy for the Waterloo library locations that Waitz reports, plus each library's floors. It answers one daily question: **where is there room to study right now?**

The section names the open library floor with the most room, shows every library's open/closed state and occupancy, and lets a library expand to its floors. It uses no new AI calls, no push notifications, and no write path.

## Why this earns a place

The dashboard already answers what is next, what is due, and what is for lunch. It does not answer where to go when there is a gap in the timetable. The data exists, is keyless, and is already listed in `research/Live Data Sources.md`. The feature is also a direct test of the source-extension claim in the design: one adapter, one card, one renderer, and no changes to the scheduling, caching or auth machinery. The new source uses the existing registry, polling loop and age ladder.

## Non-goals

- No room booking. Waitz only reports occupancy.
- No historical trend or sparkline in this version. The `metric` shape exists, but it has no retention policy and no write path worth adding for one card.
- No native Android surface in this change. Android skips unknown card types by contract, so the bundle stays valid. A native surface is a follow-up.
- No claim that occupancy equals noise. The copy says "most room", not "quietest".

## Source

- URL: `https://waitz.io/live/waterloo`
- Access: public, keyless JSON
- Shape: `place_state`
- Suggested cadence: 5 minutes
- Captured fixture: `fixtures/waitz-live-2026-10-21.json`
- Source id: `uw-waitz`
- Source name in health UI: `Study spaces`

The response has a `data` array. Each entry is a library location with `id`, `name`, `isOpen`, `people`, `capacity`, `hourSummary`, and `subLocs`. Each sub-location is a floor with the same fields. `subLocs` can be `false` for a library with no floor breakdown, and a floor can have a blank name; skip those.

The adapter must be conservative:

- `plausible` fails on a non-200, non-JSON, missing `data`, an empty `data` array, or a data array with no usable location id and name.
- `parse` returns rows even when every location is closed. Closed is a fact, not an empty response.
- A blank or malformed location is skipped, not allowed to break the run.
- The source is not official. It must degrade to saved values with the normal age ladder.

## Canonical rows

Every row uses `shape: place_state`, `source_id: uw-waitz`.

| Field | Library | Floor |
|---|---|---|
| `external_id` / `place_id` | `waitz:<id>` | `waitz:<libraryId>:<floorId>` |
| `name` | library name | floor name |
| `parent_place_id` | `''` | `waitz:<libraryId>` |
| `is_open` | Waitz `isOpen` | Waitz `isOpen` |
| `people` | integer or null | integer or null |
| `capacity` | integer or null | integer or null |
| `summary` | Waitz `hourSummary` | Waitz `hourSummary` |
| `observed_at` | poll time | poll time |
| `valid_until` | poll time + 6 minutes | poll time + 6 minutes |

`summary` is an optional payload field on `PlaceState`. It is stored in `payload_json`, not as a new table column, so no database migration is needed. `PlaceState` must declare it or Zod will strip it.

## Card contract

New card type: `study_spaces`, priority `70`, source id `uw-waitz`.

```json
{
  "libraries": [
    {
      "id": "waitz:215",
      "name": "Dana Porter Library",
      "is_open": true,
      "people": 13,
      "capacity": 145,
      "percent": 9,
      "summary": "Open until 9:00pm",
      "floors": [
        {
          "id": "waitz:215:649",
          "name": "Main Floor Study Space",
          "is_open": true,
          "people": 13,
          "capacity": 145,
          "percent": 9,
          "summary": "Open until 9:00pm"
        }
      ]
    }
  ],
  "best": {
    "library_id": "waitz:215",
    "library_name": "Dana Porter Library",
    "space_id": "waitz:215:649",
    "space_name": "Main Floor Study Space",
    "percent": 9,
    "people": 13,
    "capacity": 145
  },
  "open_count": 1,
  "total_count": 3
}
```

Rules:

- `percent = round(people / capacity * 100)`, clamped to 0-100. Null when either value is missing or capacity is zero.
- `best` is the open floor with the lowest percent, then the largest capacity. Floors with capacity under 20 and the Adaptive Technology Centre are excluded from the pick, but remain visible in their library.
- `best` is null when no library is open, or when no open floor qualifies.
- Libraries sort open first, then by percent, then by name. Closed libraries sort by name because occupancy is not a useful ordering for a closed space. Floors sort open first, then by percent, then by name.
- `open_count` counts open libraries, not floors.
- If there are no rows, use the existing `sourceHealth` fallback and send `libraries: []` with an `error` when the latest run failed.
- The card envelope uses the same 5 minute cadence as the source, so the existing age ladder labels saved values correctly.
- Add `study_spaces` to `CARD_DATA_SCHEMAS`.

## Web section

Place the section after **Dining menu** and before **Courses**.

Heading: `Study spaces`. Right side: `N of M open · checked X ago`, or `Saved · checked X ago` when the card is stale or dead.

When there is a pick:

- A full-width strip leads with `Most room right now`, then `Library · Floor`, then `N people · P% of C`.
- The percent is the strip's focal number.

When every library is closed:

- The strip says `All library spaces are closed` and names the next opening from the library `summary` text.

When the source is unavailable with no saved rows:

- A state panel says `Study space data is unavailable right now.` and explains that Waitz did not answer the latest check.
- No fabricated counts, no zero placeholders.

When there are no rows at all:

- `No study-space checks yet. Use Refresh at the top to fetch live occupancy.`

Library cards:

- An open library is a native disclosure.
- Its summary shows name, Open, occupancy percent and people count, a thin occupancy bar, and the occupancy label: Quiet, Comfortable, Busy, or Very busy.
- Its details list the floors.
- A closed library is a short static card with Closed and its next opening. It does not show a stale 0 percent count or a disclosure.
- Use text as well as the bar. Never rely on color alone.

Footer:

- A disclosure `About occupancy` explains that Waitz reports people counts, capacity is venue-reported, and closed spaces may keep a stale count.
- Link to `https://waitz.io/live/waterloo` with an external-link icon.

Responsive rules:

- Desktop: three library cards in one row. The leading strip is the focal point.
- Tablet: two columns.
- Phone: one column. Disclosure summaries are at least 44px tall.

Accessibility:

- The section is a labelled landmark.
- Each disclosure summary has a full accessible name, e.g. `Dana Porter Library, open, 9 percent full, Quiet`.
- Occupancy bars are decorative and hidden from assistive technology; the text carries the value.
- Focus uses the dashboard's existing `:focus-visible` treatment.

## Tests

Backend:

- Parse the captured fixture: 3 libraries and 16 named floors. Musagetes has `subLocs: false`, and a separate synthetic case covers blank floors.
- Plausibility rejects HTML, a non-200, an empty `data` array, and a data array with no usable locations.
- Parse emits canonical rows that pass `validateRows('place_state')`.
- A closed library is still a row.
- Card build: best floor is the lowest occupied open floor; closed floors are ignored.
- Card build: all closed means `best: null` and `open_count: 0`.
- Card freshness follows the 5 minute cadence.
- Card failure with no rows reports an error and no invented values.

Web helpers:

- Occupancy labels at the boundaries.
- Percent formatting and clamping.
- Best-space summary fallback.

## Rollback

The work lives on branch `feature/study-spaces`, based on `main` at `1928af8`. Reverting the branch or its commits restores the previous dashboard. The new source and card are additive; no existing table, route or contract field is replaced.
