# Measurements

Real numbers, with the method, so a later session does not re-derive or contradict them.
Everything here was run, not estimated.

## Food page parse cost (2026-09-21)

**Question:** can the 289 KB UW food menu page be parsed inside Cloudflare Workers Free's
10 ms CPU budget per invocation?

**Method:** Node 24.5.0 on the laptop (V8, the same engine Workers use), 289,232 byte page
fetched live, 500 iterations for the scanner and 30 for the DOM parser, CPU measured with
`process.cpuUsage()` across the loop and divided per run, after a 30-iteration warmup.

**Result:**

| strategy | CPU per run | wall per run | vs Free 10 ms |
|---|---|---|---|
| marker scanner (`indexOf` + slice, no DOM, no regex on the hot path) | **0.468 ms** | 0.463 ms | fits, 20x headroom |
| cheerio (parse5 DOM) | **30.2 ms** | 11.5 ms | 3x over, fails |

Correctness of the cheap parser in the same run: **19 dishes, 3 outlets, 19 diet blocks**,
matching the page's actual `food_item` / `food_header_title` / `food_diet` counts. It found
the real dish names (Sweet Potato and Red Lentil Casserole, Yakisoba, ...) and the real
outlets (Mudie's, REVelation, The Market, all Residence Dining Hall).

Page structure that makes the cheap path possible, for reference:

```
<div class="food_item">
  <div class="food_title"><a class="food_link" href="/food-services/daily-menu/yakisoba-ht303">Yakisoba</a></div>
  <div class="food_diet"> ...inline svg icon... </div>
</div>
```
Outlet names are in `food_header_title`. Most of the 289 KB is inline SVG icons in the diet
blocks, which a marker scanner can skip rather than parse.

**Caveats, stated plainly:** the laptop is a Snapdragon X Elite ARM CPU; Cloudflare's fleet
may be faster or slower by up to roughly 2x. At 0.47 ms that margin does not matter, but the
deployed number should still be read off Workers metrics (`wrangler tail`, CPU time per
invocation) once it exists. The DOM comparison is 64.5x the scanner's CPU, so the ordering is
not close.

**Rule this creates:** the food parser module must not import a DOM parser. Add a test that
fails if a DOM dependency appears in the parser's import graph, and re-run this benchmark on
any page-markup change. A DOM parser silently converts a $0 deployment into a $5/month one.

## Cloudflare limits used for sizing (verified from Cloudflare docs, 2026-09-20)

| Limit | Free | Paid |
|---|---|---|
| CPU per HTTP request / per cron run | 10 ms | 5 min max (30 s default); cron 30 s |
| Requests | 100,000/day | 10M/month included |
| Cron triggers per account | 5 | 250 |
| Subrequests per invocation | 50 | 10,000 |
| Simultaneous outgoing connections | 6 | 6 |
| Static asset requests | free and unlimited | free and unlimited |
| D1 rows read / written per day | 5,000,000 / 100,000 | 25B / 50M per month included |
| D1 storage | 5 GB | 5 GB included + $0.75/GB-mo |

Sizing for v1: 3 cron triggers (two ICS feeds at 15 min, food twice a day), 3 subrequests per
run against a limit of 50, dozens of client requests per day against 100,000, and a few hundred
D1 rows written per day against 100,000. Every one of those has at least 100x headroom.
