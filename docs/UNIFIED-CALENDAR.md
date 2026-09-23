# Unified calendar API

`GET /v1/calendar?start=2026-09-23&days=7` returns the same agenda on the Cloudflare Worker and the local relay. It uses the same authentication as `/v1/dashboard`.

Query parameters:

| Name | Meaning |
| --- | --- |
| `start` | First Waterloo calendar day, `YYYY-MM-DD`. Defaults to today in `America/Toronto`. |
| `days` | Number of days, 1–31. Defaults to 7. |
| `section`, `group` | Optional positive integers. LEARN group filtering applies when both are present, matching the current web preference. |

The response has `schema_version: 1`, `timezone`, `generated_at`, `start`, `end` (exclusive), `count` (unique events), `truncated`, and `days`. Every day has its date and time-ordered `events`. Empty days are included. Events have a stable `id`, source, `category` (`class`, `deadline`, `opens`, `exam`, `office_hours`, or `event`), title, course, room, description, primary URL and links, start/end epoch milliseconds, all-day flag, group scope, and freshness `state`. Multi-day events appear on each day they occupy, with `continues_from_previous` and `continues_next_day` flags. A LEARN event subscribed into the schedule feed is shown once when both copies have the same UID and start time; the LEARN copy wins because it carries the task links.

The backend owns source parsing, recurrence expansion, classification, LEARN enrichment, duplicate handling, filtering, ordering, and Waterloo day boundaries. Clients choose a range, render the returned days, and format the already normalized timestamps. The web app continues to fetch `/v1/dashboard` for its existing cards. Its dismissed-task preference remains local to that browser and only affects display. Calendar data is available for the source adapters' current expansion window (normally 60 days ahead); an empty future day beyond that window does not imply the original feeds are empty.

The `sources` array gives each timeline source's `ok`, `unconfigured`, `pending`, or `failed` status and its last run time. Clients should show an incomplete-calendar warning when any source needs attention.

The response also includes `courses`: the course codes found in the selected range, their event IDs and counts by type, a LEARN course home URL when an event supplies an org-unit ID, and saved resource links. This grouping is computed on the backend so Android can use the same data as the web app. A course outside the selected range does not appear in this array.

Course resource endpoints use the same authentication as the calendar:

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/courses/import` with `{ "text": "..." }` | Preview HTTPS links found in pasted page content, HTML, or a resource list. It does not save anything. |
| `PUT /v1/courses/{course}/resources` with `{ "resources": [...] }` | Replace the course's selected links after review. Each link has a title, HTTPS URL, and `learn`, `textbook`, or `resource` kind. |

LEARN content requires the student's authenticated session. The relay does not fetch private pages from a link; the user copies or exports content from their signed-in browser and chooses which discovered links to keep. An official Brightspace API import would require a registered OAuth app with `content:toc:read` access.

A pasted LEARN course home is filtered to useful course shortcuts and materials. Calendar event links,
individual announcements, course administration, site navigation, and generic campus widgets are
excluded. The ECE 198 example fixture retains Course Home, Content, Grades, Announcements, and the
WHMIS submission link.

The dining advisor uses `GET/PUT /v1/food/profile` to share one taste profile between clients and `GET /v1/food/recommendation?date=YYYY-MM-DD` to read the latest saved result. The scheduled Worker checks the current menu and profile and computes a new result when either changes. Clients read the stored result and display `pending`, `processing`, or `failed` while that work is underway.
