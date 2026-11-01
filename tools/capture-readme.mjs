/** Refresh public README screenshots using the real UI and an isolated, synthetic data set.
 * Run `npm run web:build`, then `node tools/capture-readme.mjs`.
 * Requires the web dev dependencies and Playwright Chromium (or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH).
 * No source polling, AI calls, real database, or deployed account is used.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { createServer } from '../apps/relay/src/server.mjs';
import { TransitStore } from '../apps/relay/src/transit-store.mjs';
import { TransitEngine } from '../apps/relay/src/transit.mjs';
import { scheduledJourneys } from '../apps/relay/src/transit-gtfs.mjs';
import { seedTransit, commuteDraft, transitZip } from '../test/helpers/transit-fixture.mjs';
import { serviceEpoch, transitDate } from '#contract/transit.mjs';

const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium } = requireWeb('@playwright/test');
const output = fileURLToPath(new URL('../docs/images/', import.meta.url));
await mkdir(output, { recursive: true });
const now = Date.now(), date = transitDate(now), day = 86_400_000;
// Public placeholders make source readiness independent of any ignored local .env file.
process.env.PORTAL_ICS_URL = 'https://example.invalid/sample-schedule.ics';
process.env.LEARN_ICS_URL = 'https://example.invalid/sample-deadlines.ics';
process.env.GOOGLE_CALENDAR_ICS_URL = 'https://example.invalid/sample-calendar.ics';
process.env.CLOUDFLARE_ACCOUNT_ID = '';
process.env.CLOUDFLARE_API_TOKEN = '';
// Keep the sample near the current time without altering Node/Playwright's timers.
const base = serviceEpoch(date, 0), seconds = Math.floor((now - base) / 1000);
const at = (sampleDay, time) => {
  const [hour, minute] = time.split(':').map(Number);
  return now + (Number(sampleDay) - 23) * day + (hour * 60 + minute - 11 * 60 - 40) * 60_000;
};
const store = new SqliteStore(':memory:');
const sources = [
  ['uw-portal-ics', 'timeline_event', 21_600_000],
  ['google-calendar-ics', 'timeline_event', 21_600_000],
  ['uw-learn-ics', 'timeline_event', 900_000],
  ['uw-food-daily-menu', 'menu_item', 3_600_000],
  ['uw-status', 'notice', 60_000],
  ['uw-waitz', 'place_state', 300_000],
  ['user-office-hours', 'timeline_event', 21_600_000],
].map(([id, shape, cadenceMs]) => ({ id, shape, cadenceMs, needsSecret: false }));
for (const source of sources) store.insertRun({ source_id: source.id, started_at: now, finished_at: now, outcome: 'ok' });
const event = (id, title, dateNumber, start, end, location, extra = {}) => ({
  source_id: 'uw-portal-ics', external_id: id, kind: 'class', title, location,
  starts_at: at(dateNumber, start), ends_at: at(dateNumber, end), all_day: false,
  observed_at: now, valid_until: now + day, ...extra,
});
store.upsertRows('timeline_event', [
  event('lecture', 'ECE 150 LEC 001', '23', '13:00', '14:20', 'E7 2317'),
  event('tutorial', 'MATH 117 TUT 101', '23', '14:30', '15:20', 'MC 4021'),
  event('office', 'ECE 198 office hours', '23', '15:30', '16:30', 'E7 2409', { kind: 'office_hours', source_id: 'user-office-hours', course: 'ECE 198' }),
  event('quiz', 'ECE 150 - Quiz 2 - Due', '23', '23:59', '23:59', '', { kind: 'deadline', source_id: 'uw-learn-ics', url: 'https://learn.uwaterloo.ca/', starts_at: serviceEpoch(date, 23 * 3600 + 59 * 60), ends_at: serviceEpoch(date, 23 * 3600 + 59 * 60) }),
  event('assignment', 'MATH 117 - Assignment 2 - Due', '24', '18:00', '18:00', '', { kind: 'deadline', source_id: 'uw-learn-ics' }),
  event('tomorrow', 'ECE 105 LEC 001', '24', '10:30', '11:20', 'RCH 101'),
  event('lab', 'ECE 198 LAB 101', '25', '09:30', '12:20', 'E7 1401'),
]);
const dishes = [
  ['The Market', 'Hot dish', 'Roasted vegetable grain bowl', ['vegan']],
  ['The Market', 'Hot dish', 'Butter chicken with basmati rice', ['halal']],
  ['The Market', 'Grill', 'Grilled lemon chicken', ['halal']],
  ['The Market', 'Soup', 'Tomato and red lentil soup', ['vegan']],
  ['REVelation', 'Hot dish', 'General Tso tofu', ['vegan']],
  ['REVelation', 'Hot dish', 'Jerk chicken with rice and peas', ['halal']],
  ['REVelation', 'Grill', 'Black bean burger', ['vegetarian']],
  ['REVelation', 'Soup', 'Roasted butternut squash soup', ['vegan']],
];
store.upsertRows('menu_item', dishes.map(([outlet, station, dish, diet], i) => ({
  source_id: 'uw-food-daily-menu', external_id: `dish-${i}`, outlet: `${outlet} - Residence Dining Hall`, station, dish, diet,
  allergens: [], service_date: date, observed_at: now, valid_until: now + day,
  url: 'https://uwaterloo.ca/food-services/menus',
})));
store.setSetting('FOOD_AI_RECOMMENDATION_JSON', JSON.stringify({
  status: 'ready', service_date: date, updated_at: now, recommendation: {
    service_date: date, generated_at: now, headline: 'The Market',
    top_outlet: 'The Market - Residence Dining Hall',
    ranked_outlets: [
      { outlet: 'The Market - Residence Dining Hall', rank: 1, match_score: 92, verdict: 'A filling lunch with plenty of plant-based options.', highlights: [{ dish: 'Roasted vegetable grain bowl', why: 'Vegetables and grains for a filling lunch.' }] },
      { outlet: 'REVelation - Residence Dining Hall', rank: 2, match_score: 84, verdict: 'A good alternative if you are closer to REV.', highlights: [] },
    ], tip: '',
  },
}));
store.setSetting('WEATHER_FORECAST_JSON', JSON.stringify({ observed_at: now, attempted_at: now, forecast: [
  { at: now, temp_c: 18, feels_c: 17, precip_prob: 10, wind_kmh: 12 },
] }));
store.upsertRows('place_state', [
  ['dp', 'Dana Porter Library', null, 228, 800], ['dp6', 'Floor 6', 'dp', 24, 160],
  ['dp7', 'Floor 7', 'dp', 48, 160], ['dc', 'Davis Centre Library', null, 280, 600],
  ['dc1', 'Main floor', 'dc', 182, 380],
].map(([place_id, name, parent_place_id, people, capacity]) => ({
  source_id: 'uw-waitz', external_id: place_id, place_id, name, parent_place_id, people, capacity,
  is_open: true, observed_at: now, valid_until: now + 300_000,
})));
const transit = new TransitStore((sql, ...args) => store.db.prepare(sql).all(...args));
const gtfsTime = minutes => {
  const total = seconds + minutes * 60;
  return [Math.floor(total / 3600), Math.floor(total % 3600 / 60), total % 60].map(n => String(n).padStart(2, '0')).join(':');
};
seedTransit(transit, now, transitZip({ 'stop_times.txt': `trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,${gtfsTime(20)},${gtfsTime(20)},1,1\nT1,${gtfsTime(35)},${gtfsTime(35)},2,2\nT2,${gtfsTime(40)},${gtfsTime(40)},1,1\nT2,${gtfsTime(55)},${gtfsTime(55)},2,2\n` }));
const engine = new TransitEngine(transit), commute = engine.save(commuteDraft);
transit.put(`journey:${commute.id}`, { ...scheduledJourneys(transit, commute, now), generation: 'fixture', date, alerts: [], alerts_at: now });
transit.put('status', { updated_at: now, error: null });
const { server } = createServer({ store, sources, token: '', automaticPolling: false, log() {} });
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5, timezoneId: 'America/Toronto', reducedMotion: 'reduce' });
  // Screenshots cannot accidentally navigate to a live feed or trigger inference.
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(() => {
    // Windows may report no internet even though this isolated localhost server is reachable.
    Object.defineProperty(Navigator.prototype, 'onLine', { get: () => true });
    localStorage.setItem('unidash.setup-guide.v1', JSON.stringify({ seen: true, step: 4, finished: true }));
    localStorage.setItem('uni-dashboard:preferences:v3', JSON.stringify({ favoriteOutlets: [] }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('.hero-main').waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Crop at section boundaries so previews contain neither cut-off headings nor empty gutters.
  const overview = async name => {
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    const header = await page.locator('.day-context').boundingBox();
    const recommendations = await page.locator('.dashboard-recommendations').boundingBox();
    const padding = Math.min(24, header.x);
    const top = Math.max(0, header.y - padding);
    await page.screenshot({ path: `${output}/${name}.png`, animations: 'disabled', clip: {
      x: header.x - padding, y: top, width: header.width + padding * 2,
      height: recommendations.y + recommendations.height + padding - top,
    } });
  };
  await overview('dashboard');
  for (const [id, name] of [['calendar', 'calendar'], ['menu', 'dining'], ['study', 'study-spaces'], ['transit', 'transit']]) {
    const section = page.locator(`#${id}`);
    await section.scrollIntoViewIfNeeded();
    // The recommended outlet is the useful close-up; the whole menu can be very tall.
    const subject = name === 'dining' ? section.locator('.menu-outlet--best') : section;
    await subject.screenshot({ path: `${output}/${name}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile preview overflows horizontally');
  await overview('mobile');
  const calendar = page.locator('#calendar');
  await calendar.evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const calendarBounds = await calendar.boundingBox();
  const firstDay = await calendar.locator('.calendar-day').first().boundingBox();
  await page.screenshot({ path: `${output}/calendar-mobile.png`, animations: 'disabled', clip: {
    x: calendarBounds.x, y: calendarBounds.y, width: calendarBounds.width,
    height: firstDay.y + firstDay.height - calendarBounds.y + 1,
  } });
  // Also render the SVG so its typography and placement can be inspected locally.
  await page.setViewportSize({ width: 1280, height: 320 });
  await page.setContent(await readFile(`${output}/banner.svg`, 'utf8'));
  await page.addStyleTag({ content: 'body { margin: 0; }' });
  await page.screenshot({ path: `${output}/banner.png`, animations: 'disabled' });
  // Give section headings the same breathing room as the overview, without changing app layout.
  for (const name of ['calendar', 'calendar-mobile', 'study-spaces', 'transit']) {
    const png = await readFile(`${output}/${name}.png`);
    const scale = 1.5;
    const width = png.readUInt32BE(16) / scale;
    const height = png.readUInt32BE(20) / scale;
    const padding = name === 'calendar-mobile' ? 16 : 24;
    await page.setViewportSize({ width: Math.ceil(width + padding * 2), height: Math.ceil(height + padding * 2) });
    await page.setContent(`<!doctype html><html><head><style>
      html, body { margin: 0; background: #1d1f23; }
      #frame { width: max-content; padding: ${padding}px; }
      img { display: block; width: ${width}px; height: auto; }
      </style></head><body><div id="frame"><img src="data:image/png;base64,${png.toString('base64')}" alt="" /></div></body></html>`);
    await page.locator('img').evaluate(img => img.decode());
    await page.locator('#frame').screenshot({ path: `${output}/${name}.png`, animations: 'disabled' });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('README images captured with synthetic data; desktop and mobile checks passed.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  store.db.close();
}
