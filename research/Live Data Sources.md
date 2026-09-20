---
type: resource
tags: [uni, dashboard, data]
status: verified
verified: 2026-09-20
---
# Live campus data sources

Every endpoint on this page was hit with curl on Sun 20 Sep 2026. The status codes are
real, and the byte counts were measured. The work ran in three passes: research
off-campus, then two re-checks on hermes-dedicated. Items the re-check corrected are
marked CORRECTED.

The access tier tells you how much work a source needs and how fast it breaks:

- **keyless live**: no account, returns JSON or protobuf. Best.
- **keyed JSON**: one free key, structured data, rate limited.
- **scraped HTML**: works today, breaks when the page changes.
- **personal token feed**: your own data, no login to fetch, secret URL.
- **session-gated**: needs your WatIAM login. Use last, or not at all.

## Tier 0 - keyless, live, no account

| Source | What you get | Endpoint | Freshness | Check |
|---|---|---|---|---|
| Library occupancy (Waitz) | People count, percent busy, capacity, open or closed. Per building and per floor. | `https://waitz.io/live/waterloo` | minutes | 200, 28,216 B JSON |
| Library hours (LibCal) | Opening hours per library, weeks ahead | `https://libcal.uwaterloo.ca/api_hours_grid.php?format=json&iid=293&weeks=1` | daily | 200, 17,403 B JSON |
| Transit real time (GRT) | Vehicle positions, trip updates, service alerts | `https://webapps.regionofwaterloo.ca/api/grt-routes/api/vehiclepositions/1`, `/tripupdates/1`, `/alerts` | seconds | 200, 7,913 B protobuf. `/tripupdates/1` 200, 181,077 B |
| Transit static (GRT) | Routes, stops, trips, times (GTFS zip) | `https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/1` | weekly | 200, 2.06 MB zip, 8 files, feed dated 2026-09-16 |
| Weather | Current, hourly, daily forecast for campus | `https://api.open-meteo.com/v1/forecast?latitude=43.4723&longitude=-80.5449&current=temperature_2m` | 15 min | 200, 326 B JSON |
| Weather (official) | Environment Canada observations and forecasts | `https://api.weather.gc.ca/collections` | 10 min | 200. Waterloo station code still unknown |
| Course data (UW Flow) | Course name, description, prereqs, ratings, reviews, and **live section enrolment** | `POST https://uwflow.com/graphql` | live | 200. See the query shape below |
| Gym occupancy (Warrior) | Live people count and capacity per facility | `POST https://warrior.uwaterloo.ca/FacilityOccupancy/GetFacilityData` | per request | 200, 4,668 B HTML fragment. See the request shape below |
| IT status (IST) | Component status for LEARN, Quest, network | `https://status.uwaterloo.ca/api/v2/status.json` | 1 min | 200 JSON. Reported `major` on 20 Sep |
| Student events (WUSA) | Dated events with venue: fairs, club nights | `https://wusa.ca/wp-json/tribe/events/v1/events?per_page=5&start_date=2026-09-20` | live | 200 JSON, 27 upcoming |
| Campus chatter (Reddit) | Posts from r/uwaterloo | `https://www.reddit.com/r/uwaterloo/.rss` | live | 200 Atom, 37,872 B. **CORRECTED: needs a browser User-Agent.** Without one you get 403 |

### UW Flow query shape (CORRECTED)

The first pass reported `course(code:"ece150")`. That argument does not exist. UW Flow
runs Hasura, so you filter with `where`. This query returned real data on 20 Sep 2026:

```graphql
{ course(where: {code: {_eq: "ece150"}}) { id code name rating { liked comment_count } } }
# -> {"id":1888,"code":"ece150","name":"Fundamentals of Programming","rating":{"liked":0.739,"comment_count":72}}

{ course_section(where: {course_id: {_eq: 1888}, term_id: {_eq: 1269}}) {
    section_name enrollment_capacity enrollment_total updated_at } }
# -> LEC 001 cap 140, enrolled 149, updated 2026-09-20T11:30Z
```

Course codes are lowercase with no space. Section fields include `class_number`,
`enrollment_capacity`, `enrollment_total`, `meetings`, `exams`, `updated_at`. The
`course_section` table is the only free source of live enrolment against capacity.
Grades are not in the schema, so grade history stays behind the keyed Open Data API.

### Gym occupancy request shape (CORRECTED)

A plain GET returns 500. So does a POST with a made-up facility ID. The call needs all
three parts, and the seven facility IDs come from the page HTML:

```bash
curl -X POST \
  -H 'Referer: https://warrior.uwaterloo.ca/FacilityOccupancy' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'facilityId=b2d98ff8-e37a-42da-bf72-06b259ff1a2c&occupancyDisplayType=00000000-0000-0000-0000-000000004488' \
  https://warrior.uwaterloo.ca/FacilityOccupancy/GetFacilityData
# -> 200, 4,614 B HTML fragment with the percent busy
```

Facility IDs read from the page: CIF Fitness Centre, PAC 1st Floor Free Weights,
PAC 1st Floor Functional, PAC 2nd Floor Cardio, PAC 2nd Floor Weight Machines,
Warrior Zone, Esports and Gaming. `https://warrior.uwaterloo.ca/Facility/GetSchedule?facilityId=<guid>`
returns the drop-in schedule for a facility.

**GRT TLS trap:** the default curl, Node and Python TLS stack fails with `dh key too
small`, and you get HTTP 000. Add `--ciphers DEFAULT@SECLEVEL=1` in curl, or lower the
security level in the client. Test the feed from the runtime you plan to ship, because a
Cloudflare Worker has its own TLS stack.

## Tier 1 - the official API, free key

`https://openapi.data.uwaterloo.ca` (version 3) is alive in 2026. Each dataset needs an
`X-API-KEY` header. Get a free key from `POST /v3/Account/Register` with an email, a
project name and a URI, then confirm the email. The docs are at
`https://openapi.data.uwaterloo.ca/api-docs/index.html` (200). The spec is
`/swagger/v1/swagger.json` (200, 48 paths).

Verified on 20 Sep 2026: `/v3/Courses`, `/v3/ExamSchedules`, `/v3/FoodServices/outlets`,
`/v3/Locations` and `/v3/Wcms/latestevents/5` all return **401 asking for the key**, so
they exist. `/v3/Account/Register` returned 400 to an empty body, so the route is live.

Useful datasets: `ClassSchedules/{term}/{subject}/{catalogNumber}`, `ExamSchedules/{term}`,
`Courses/{subject}/{number}`, `FoodServices/outlets`, `ImportantDates`, `Locations`
(with GeoJSON), `Terms`, `Subjects`.

`/v3/HolidayDates/paidholidays/ics` is the one **public and keyless** endpoint: 200,
26,650 B of real ICS.

The old `api.uwaterloo.ca` and `open-data.uwaterloo.ca` do not resolve at all. They are
dead. The official docs repo `uWaterloo/api-documentation` is archived, but the API is not.

Rate limiting is per minute and returns 429. No number is published. Cache hard.

## Tier 2 - public HTML, no API

These work today and break on the next redesign. Treat each one as a liability.

| Source | Endpoint | What is in it | Check |
|---|---|---|---|
| Food daily menu | `https://uwaterloo.ca/food-services/daily-menu` | Menu for all outlets. Classes `food_title`, `food_item`, `food_diet`. 19 locations. | 200, 289,232 B |
| Food menu for a date | `https://uwaterloo.ca/food-services/daily-menu?date=YYYY-MM-DD` | Same view for another day. The heading changes to "Daily menu for 2026-09-21", so the filter is server side. | 200 |
| Food outlet page | `https://uwaterloo.ca/food-services/locations-and-hours/<slug>` | One outlet: name, building, hours, dated exceptions. 20 slugs, for example `brubakers`, `revelation`, `mudies`, `mls-diner`. Example: `revelation` returns "REVelation - Residence Dining Hall, Ron Eydt Village (REV)". | 200 |
| Food dish detail | `https://uwaterloo.ca/food-services/daily-menu/<dish-slug>-<code>` | Diet symbols, `Contains:` allergens, ingredient list. No calories or macros. | 200 |
| Campus events | `https://uwaterloo.ca/events` | Drupal event listings | 200, about 97 KB |
| Campus status | `https://uwaterloo.ca/campus-status` | Open or closed per campus, weather alerts, building info | 200, 48,437 B |
| Schedule of Classes | `https://classes.uwaterloo.ca/cgi-bin/cgiwrap/infocour/salook.pl?level=under&sess=1269&subject=ECE&cournum=150` | Sections, times, rooms, enrolment counts, instructor | 200, 16,012 B |
| Academic dates | `https://uwaterloo.ca/important-dates/undergraduate` | Add, drop, fee and exam dates per term | 200 |
| Special constable news | `https://uwaterloo.ca/special-constable-service/news` | Campus incident reports | 200 |

The events calendar blocks machines. `.ics` returns 404, `rss.xml` returns 403, and
`?_format=json` returns 406. The Drupal JSON API is disabled campus wide, so events,
police news and the food menu stay scraping targets. `events.uwaterloo.ca` resolves but
drops every connection from off campus.

### What a menu parser sees

Read on 20 Sep 2026. The page renders outlet, then station, then dish:

```
## Mudie's - Residence Dining Hall
### Mom's Counter
[Sweet Potato and Red Lentil Casserole](/food-services/daily-menu/sweet-potato-and-red-lentil-casserole-ht113)
[Yakisoba](/food-services/daily-menu/yakisoba-ht303)
### Station 57
[Build Your Own Fajita](https://drive.google.com/drive/folders/1Uf5LQV74djM5kWrBHa7r6MbSqgRB-FbN)
```

Three things to build for:

1. A station item can be an off-site link, not a dish. The Fajita entry above points at a
   Google Drive folder. The parser must keep internal `/food-services/daily-menu/...` links
   and drop the rest, or it invents dishes.
2. The dish code at the end of the slug (`ht113`) is stable. Use it as `external_id`, and
   the dedup rule then works across days.
3. A future date returns the outlet shells with no dishes. That is normal, not a parse
   failure. Today's view is populated; tomorrow's is not posted yet. So poll once in the
   morning and once in the afternoon, and treat an empty future day as empty.

Term code for the Schedule of Classes and Open Data: `1`, then two digits of the year,
then a season digit. Season 9 is Fall, 1 is Winter, 5 is Spring. Fall 2026 is **1269**.

## Tier 3 - personal token feeds

These two feeds are the core of the project. Both are official features, and both are
credentials. Any person who holds the URL can read everything you can read.

| Feed | How to get it | What it carries | Check |
|---|---|---|---|
| Portal iCal feed | Open `https://portal.uwaterloo.ca/#/calendar`, click the three-dot menu next to My calendars, click Export calendar, then copy the Portal iCal feed URL. API: `GET https://portalapi2.uwaterloo.ca/v2/calendar/iCalURL` with a Bearer token. `POST /v2/calendar/revokeRegen` rotates it. | Class schedule, exam schedule, important dates, as a subscribable ICS | 401 with `www-authenticate: Bearer`. A fake path returns 404, so the router discriminates and the route is real. The export dialog is in the production bundle `index-D2cXhEOp.js`, modified 2026-09-06 |
| LEARN calendar feed | In LEARN, open Calendar, then Settings, tick **Enable Calendar Feeds**, click Save, then click Subscribe and choose All Calendars and Tasks | Due dates, office hours and exam info that instructors entered | Route family `/d2l/le/calendar/feed/user/feed.ics?token=...` observed, but `.ics` is a catch-all on that host. You must read the real URL off the Subscribe dialog while you are signed in |

A May 2026 report said the Portal export was gone. It is not gone. The endpoint is live,
and it only needs a Bearer token. Test it again before you rely on it.

UW's own documentation warns that not every instructor adds due dates to the LEARN
calendar. Expect gaps until you see which of your 8 courses populate it.

## Tier 4 - session gated

| Surface | Reality |
|---|---|
| LEARN Valence API | `GET https://learn.uwaterloo.ca/d2l/api/versions/` returns **200 with no auth**: latest `lp` 1.63 and `le` 1.97. The data routes return 403 without a session. A student **cannot** register an OAuth app, because that lives in the admin-only Manage Extensibility tool. The only credential a student has is a session cookie. |
| Quest (PeopleSoft) | No ICS export and no API. Login redirects to `adfs.uwaterloo.ca` with SAML and mandatory Duo. Every reverse-engineered client has died. `hulloitskai/uwquest` is archived, and the README says Quest auth changes are the reason. **Do not build on Quest.** |
| WatCard balance | `https://secure.touchnet.net/C22566_oneweb/` redirects to the ADFS SAML login. `watcard.uwaterloo.ca/oneweb/*` returns 503. The only public WatCard endpoint is a write-only guest deposit form. |
| WaterlooWorks | 200 shell, then a login wall. No public API. |
| Final exam seating, study room booking | Both behind student SSO. `oculus.uwaterloo.ca` resolves but times out from off campus. |

Prior art that proves the cookie path works: `syed-zayd/uwaterloo-mcp` (MIT, commit
2026-09-19) signs in with WatIAM and Duo once in a headless browser, then reuses the
session cookie against `/d2l/api/`. Also `senesci/icalproxy` (2026-09-13) proxies a D2L
ICS feed, which confirms the feed is pollable.

Do not reuse the session cookie in the dashboard. The ICS feeds cover schedule and
deadlines, and a locked account is not worth a grades tile.

## LEARN in detail

LEARN is Brightspace (D2L), and it has three routes. Only the first one is safe.

### Route 1: the calendar feed. Use this.

D2L documents the feed as "scheduling information such as events and to-dos". So you get
instructor-entered calendar events, due dates, and to-do items, for one course or for all
of them at once.

Steps: open LEARN, open Calendar, click Settings, tick **Enable Calendar Feeds**, click
Save, click Subscribe, choose a course or All Calendars and Tasks, then copy the URL.

The token lives in the URL, so no login is needed to fetch it. That is why Google
Calendar and Apple Calendar can subscribe. UW's own help page documents the same flow.

Two limits. The feed holds only what instructors enter, and UW's knowledge base warns
that not all of them add due dates. External calendar apps can also lag by up to a day,
but the feed itself is fetched live by your fetcher.

**The URL shape cannot be confirmed from outside.** On 20 Sep 2026, both
`/d2l/le/calendar/feed/user/feed.ics` and a nonsense path `/d2l/le/calendar/zzz.ics`
returned 200 with `text/html`. The route is a catch-all that serves the login page, so a
200 from an `.ics` path proves nothing. Read the real URL off the Subscribe dialog.

### Route 2: the Valence API. Grey, and I recommend against it.

UW has the full API turned on. `GET https://learn.uwaterloo.ca/d2l/api/versions/` returns
200 with no auth at all, and lists `le` 1.97, `lp` 1.63, `ep` 2.5, `bas` 1.6 and the
customization products.

The data routes need a session. Measured on 20 Sep 2026, unauthenticated:

| Route | Result |
|---|---|
| `/d2l/api/lp/1.63/enrollments/myenrollments/?orgUnitTypeId=3` | 403 |
| `/d2l/api/le/1.97/{ou}/grades/values/myGradeValues/` | 403 |
| `/d2l/api/le/1.97/{ou}/dropbox/folders/` | 403 |
| `/d2l/api/le/1.97/{ou}/quizzes/` | 403 |
| `/d2l/api/le/1.97/{ou}/news/` | 403 |
| `/d2l/api/le/1.97/{ou}/calendar/events/myEvents/` | 403 |
| `/d2l/api/le/1.97/{ou}/classlist/` | 403 |
| `/d2l/api/le/1.97/{ou}/content/root/` | **200 `text/html`** |

The last row is the trap. `content/root` hands back the login page instead of a 403, so a
200 with an HTML content type means "not authenticated". A parser that only checks the
status code will read a login page as data.

A student cannot register an OAuth app, because that lives in the admin-only Manage
Extensibility tool. The only credential a student holds is a session cookie. Prior art
`syed-zayd/uwaterloo-mcp` (MIT, commit 2026-09-19) does exactly this: one WatIAM plus Duo
sign-in in a headless browser, then cookie reuse.

What that path would add on top of the feed: your course list with org unit IDs, the
content tree with files, your grade values, submission status, quiz attempts, and
announcements. Not worth it. A session cookie is a live credential, it expires without
warning, and a locked account costs more than a grades tile. The feeds cover schedule and
deadlines, which is the whole need.

### Route 3: nothing else exists

The Pulse mobile app is a Valence client, so it adds no new endpoints. Quest has no ICS
export. `students.uwaterloo.ca` does not resolve.

## Not found

Stop looking for these.

- **Laundry machine status.** No vendor portal exists for UW. The LaundryView catalogue
  holds 3,138 properties and contains no Waterloo entry (checked: 0 hits for Waterloo,
  Conestoga, Laurier, Guelph). `laundry.`, `laundryview.` and `mylaundry.uwaterloo.ca`
  do not resolve. REV laundry is WatCard operated with no telemetry.
- **Parking occupancy.** UW publishes lot locations and rates, but no live feed.
- **UW shuttle.** No shuttle page exists in any UW sitemap. GRT serves the campus.
- **Calories and macros.** Only diet symbols, `Contains:` allergens and free-text
  ingredients. No nutrition numbers anywhere.
- **Grade distributions.** UW Flow exposes ratings and enrolment, not grades.
- **Order-ahead backend.** No Boost, Grubhub, Nutrislice or Transact integration behind
  the menu pages.
- **Campus Discord.** No public read API.
- `students.uwaterloo.ca` does not resolve. There is no student mobile API.

## Transit detail for REV

Your residence stop is **1097 / 1119, "Columbia / U.W. - Ron Eydt Village"**
(43.4716, -80.5554). Routes **13 Laurelwood** and **31 Columbia** serve it. The
`tripupdates/1` feed contained 5 references to stop 1097 and 6 to stop 1119 on 20 Sep.

On-campus stops on the Ring Road loop: 2530 Ring Rd / Quantum Nano Centre, 2516
Environment 3, 2518 University Club, 2519 B.C. Matthews, all served by **route 30 Ring
Road**. Stop 1120 Columbia / Village 1 is served by routes 13 and 31.

## Other open data

| Source | Endpoint | Use |
|---|---|---|
| Region of Waterloo | `https://rowopendata-rmw.opendata.arcgis.com/api/v3/datasets?q=<term>` | Road closures, waste pickup, construction |
| City of Waterloo | `https://data.waterloo.ca/api/feed/dcat-us/1.1.json` | Municipal datasets |

## Policy

Nothing in UW's computing guidelines bans reading your own data. Two habits keep the
project clean: poll at human scale, because the Valence API returns 429, and never share
a session cookie or a token URL. The ICS feeds and the Open Data API are documented
features for users, so a build on those carries no policy risk at all.

## Unknowns that need you signed in

1. In LEARN, open Calendar, then Settings. Is **Enable Calendar Feeds** still there?
   Copy the Subscribe URL, then open it in a private window with no cookies. If ICS
   renders, the dashboard can poll it directly. This is the most valuable check on the list.
2. In that feed, do due dates appear for all 8 courses? Write down the gaps.
3. In Portal, open the calendar and click the three-dot menu. Is **Export calendar**
   still listed? Does the URL change after you log out and in?
4. Does the Portal feed include exam sittings with rooms?
5. Register an Open Data key, then call `/v3/ClassSchedules/1269/ECE/150` and
   `/v3/ExamSchedules/1269`. If the JSON is rich enough, Quest leaves the design.
