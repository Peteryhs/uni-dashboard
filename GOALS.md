# Uni Dashboard — the brief

## Core needs (Peter's words)

- A website and an Android app. Both.
- Easily able to integrate new things later — new data, new features — without rework.
- Dynamic and nice looking. Not a static page, not a table dump.
- Information at a glance: the state of my uni life readable in seconds.

## Why (context, not a spec)

The Obsidian "Uni" database is a good record and a bad live system:

1. Not live. The schedule is typed by hand, so it goes stale the day a room changes.
2. It does not reach me. Nothing lands on my phone or my calendar.
3. It holds only what I typed. No menus, no transit, no library crowding.

## Candidate data (available, not mandatory)

Verified live on 2026-09-20 in `research/Live Data Sources.md`. Availability is not the
same as worth shipping — you decide what earns a place.

| Candidate | Source | Freshness |
|---|---|---|
| Next class, today's timetable | UW Portal iCal feed (per-user token URL) | on change |
| Deadlines and due dates | LEARN (Brightspace/D2L) iCal feed (per-user token URL) | on change |
| Transit to and from residence, "leave now" | GRT GTFS-RT, stops near REV | seconds |
| Food: which outlet is open, today's menu | UW Food Services daily menu page | daily |
| Library crowding by floor | Waitz occupancy | minutes |
| Weather | Open-Meteo | 15 min |
| Gym capacity | Warrior athletics occupancy | per request |
| Campus and IT status | UW campus status, status.uwaterloo.ca | 1 min |
| Events and club fairs | WUSA events REST | live |
| Course enrolment vs capacity | UW Flow GraphQL | live |

## Constraints found by research

- No nutrition data and no food ratings data exist for campus outlets. Only dish names,
  diet symbols and allergen lists. So anything rating-based can only come from me.
- The two most valuable feeds are personal token URLs. They are secrets.
- The research file lists sources that are dead or gated. Read it before assuming a feed
  exists.

## What is deliberately absent

No architecture has been handed over. The previous planning pass is not included on
purpose. Do not ask for it; produce your own plan from the research and the needs above.
