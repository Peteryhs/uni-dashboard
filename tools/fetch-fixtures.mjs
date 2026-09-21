#!/usr/bin/env node
/**
 * Capture live fixtures. Fixtures are real network bytes, not hand-written samples, so a parser
 * change can be tested offline against exactly what the source served on a given day.
 *
 *   node tools/fetch-fixtures.mjs
 *
 * Portal and LEARN feeds need tokens we do not have yet, so this script uses a public ICS feed as
 * a stand-in to prove the fetch+parse path end to end, and writes synthetic fixtures (clearly
 * named) that mirror the shapes UW produces.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const dir = 'fixtures';
mkdirSync(dir, { recursive: true });

async function grab(label, url, file, { ua = UA } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': ua, accept: '*/*' }, redirect: 'follow' });
    const body = await res.text();
    writeFileSync(join(dir, file), body);
    console.log(
      `${label.padEnd(22)} ${res.status} ${String(body.length).padStart(8)} bytes ${Date.now() - started}ms -> fixtures/${file} (${res.headers.get('content-type') ?? '-'})`,
    );
    return { ok: res.ok, body };
  } catch (e) {
    console.log(`${label.padEnd(22)} FAILED ${e.message}`);
    return { ok: false, body: '' };
  }
}

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

await grab('food daily menu', 'https://uwaterloo.ca/food-services/daily-menu', `food-${today}.html`);
await grab('campus status json', 'https://status.uwaterloo.ca/api/v2/status.json', `status-${today}.json`);

// Public feed stand-in for the two secret ICS feeds, to prove the ICS path with real bytes.
const standins = [
  ['public ics (canada holidays)', 'https://www.officeholidays.com/ics/canada', 'public-standin.ics'],
  ['public ics (google holiday)', 'https://calendar.google.com/calendar/ical/en.canadian%23holiday%40group.v.calendar.google.com/public/basic.ics', 'public-standin-google.ics'],
];
for (const [label, url, file] of standins) {
  const r = await grab(label, url, file);
  if (r.ok && r.body.includes('BEGIN:VCALENDAR')) break;
}
