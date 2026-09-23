import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseFoodPage, toMenuItems } from '../sources/food/parse.mjs';
import * as foodSource from '../sources/food/source.mjs';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { runSource } from '../apps/relay/src/runner.mjs';
import { validateRows } from '#contract/canonical.mjs';

const FIXTURE = 'fixtures/food-2026-09-21.html';
const haveFixture = existsSync(FIXTURE);
const html = haveFixture ? readFileSync(FIXTURE, 'utf8') : '';
const loginHtml = readFileSync('fixtures/login-page.html', 'utf8');

/**
 * Guard, not a behaviour test: the parser module must stay dependency-free. A DOM parser here
 * costs 30.2 ms of CPU against a 10 ms budget, which is the difference between a $0 Cloudflare
 * deployment and a $5/month one (docs/MEASUREMENTS.md). If someone adds an import, this fails.
 */
test('the food parser has no imports at all (CPU budget guard)', () => {
  const raw = readFileSync('sources/food/parse.mjs', 'utf8');
  // strip comments first: the file explains *why* a DOM parser is banned, and naming it in prose
  // is not the same as importing it
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imports = src.match(/^\s*import\s.+$/gm) ?? [];
  assert.deepEqual(imports, [], `parse.mjs must have zero imports, found: ${imports.join(' | ')}`);
  for (const banned of ['cheerio', 'jsdom', 'parse5', 'linkedom', 'node-html-parser', 'htmlparser2', 'require(']) {
    assert.equal(src.includes(banned), false, `parse.mjs must not reference ${banned}`);
  }
  assert.equal(/DOMParser|document\.|window\./.test(src), false, 'parse.mjs must not touch a DOM API');
});

test('plausibility rejects a login page even though it is a 200 html page', () => {
  const verdict = foodSource.plausible({ status: 200, contentType: 'text/html; charset=UTF-8', body: loginHtml, bytes: loginHtml.length });
  assert.equal(verdict.ok, false);
});

test('plausibility accepts the real menu page', { skip: !haveFixture && 'no captured fixture' }, () => {
  const verdict = foodSource.plausible({ status: 200, contentType: 'text/html; charset=UTF-8', body: html, bytes: html.length });
  assert.equal(verdict.ok, true, verdict.reason);
});

test('parses outlets, each dish belongs to an outlet', { skip: !haveFixture && 'no captured fixture' }, () => {
  const parsed = parseFoodPage(html);
  assert.ok(parsed.outlets.length >= 1, 'expected at least one outlet');
  const total = parsed.outlets.reduce((n, o) => n + o.dishes.length, 0);
  assert.ok(total >= 1, 'expected at least one dish');
  for (const o of parsed.outlets) {
    assert.equal(typeof o.name, 'string');
    assert.ok(o.name.length > 0);
    for (const d of o.dishes) assert.ok(d.dish.length > 0);
  }
});

test('finds the residence dining halls by name', { skip: !haveFixture && 'no captured fixture' }, () => {
  const { outlets } = parseFoodPage(html);
  const names = outlets.map((o) => o.name);
  assert.ok(names.some((n) => n.includes('REVelation')), `REVelation missing from ${JSON.stringify(names)}`);
});

test('menu rows satisfy the canonical contract and have unique ids', { skip: !haveFixture && 'no captured fixture' }, () => {
  const parsed = parseFoodPage(html);
  const rows = toMenuItems(parsed, {
    sourceId: 'uw-food-daily-menu',
    serviceDate: '2026-09-21',
    observedAt: 1,
    validUntil: 2,
    baseUrl: foodSource.url,
  });
  validateRows('menu_item', rows);
  const ids = new Set(rows.map((r) => r.external_id));
  assert.equal(ids.size, rows.length, 'external_id must be unique per row');
  for (const r of rows) {
    assert.match(r.service_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.url === '' || r.url.startsWith('https://'));
  }
});

/**
 * Regression, in two halves, because the first fix alone was not enough.
 *
 * The identity used to be `outlet::dish`, so one dish on two dates was one row: polling tomorrow
 * rewrote today's rows. With the date in the key, the same poll still tombstoned today's rows,
 * because the sweep compared against every row the source owned. A menu poll covers one service
 * date, so it may only judge that date (sources/food/source.mjs declares `scopeColumn`).
 */
test('a poll for one date cannot delete another date, and still tombstones inside its own', async () => {
  let current = ['Soup', 'Stew', 'Pie'];
  const page = () =>
    '<div class="food_header_title">REV</div>' +
    current
      .map((d) => `<div class="food_title"><a class="food_link" href="/food-services/daily-menu/${d}">${d}</a></div><div class="food_diet">vegetarian</div>`)
      .join('');
  const source = {
    ...foodSource,
    async fetchRaw() {
      const body = page();
      return { status: 200, contentType: 'text/html; charset=UTF-8', body, bytes: body.length };
    },
  };
  const rowsOn = (store, date) => store.rows('menu_item', { where: 'service_date = ?', params: [date] });
  const t0 = Date.UTC(2026, 8, 21, 12);
  const store = new SqliteStore(':memory:');

  const day1 = await runSource(source, store, { now: t0, date: '2026-09-21' });
  assert.equal(day1.outcome, 'ok');
  assert.equal(day1.rows_written, 3);

  current = ['Soup', 'Stew']; // tomorrow's menu, and the pie is not on it
  const day2 = await runSource(source, store, { now: t0 + 86_400_000, date: '2026-09-22' });
  assert.equal(day2.outcome, 'ok');
  assert.equal(day2.tombstones, 0, 'a poll for another date has no business judging this one');
  assert.deepEqual(rowsOn(store, '2026-09-21').map((r) => r.dish).sort(), ['Pie', 'Soup', 'Stew']);
  assert.equal(rowsOn(store, '2026-09-22').length, 2);

  current = ['Soup']; // a dish really does leave the day being polled
  const again = await runSource(source, store, { now: t0 + 86_400_000 + 3600_000, date: '2026-09-22' });
  assert.equal(again.tombstones, 1);
  assert.deepEqual(rowsOn(store, '2026-09-22').map((r) => r.dish), ['Soup']);
  assert.equal(rowsOn(store, '2026-09-21').length, 3, 'the other date is still untouched');
});

test('a date with no menu is valid-empty, not a failure', () => {
  // the page's own words, live on a future date (fixtures/ has no capture of this state)
  const body = '<html><body><a href="/food-services/daily-menu">Daily menu</a><p>No daily menu found for the requested date.</p></body></html>';
  const verdict = foodSource.plausible({ status: 200, contentType: 'text/html; charset=UTF-8', body, bytes: body.length });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.empty, true, 'an off-term day must not count as a source failure');
  assert.equal(verdict.credential, undefined);
});

test('valid_until covers the service day rather than an arbitrary window', () => {
  const validUntil = foodSource.parse(
    { status: 200, contentType: 'text/html', body: '<div class="food_header_title">X</div><div class="food_link">D</div>', bytes: 1 },
    { now: Date.UTC(2026, 8, 21, 12, 0), date: '2026-09-21' },
  ).rows[0].valid_until;
  const asLocal = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).format(new Date(validUntil));
  assert.match(asLocal, /2026-09-22, 03/, `expected 03:00 the next day, got ${asLocal}`);
});

test('fetchRaw always includes date parameter for current Toronto date', async () => {
  const originalFetch = globalThis.fetch;
  const fetchedUrls = [];
  globalThis.fetch = async (target) => {
    fetchedUrls.push(String(target));
    return {
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => '<div class="food_header_title">REV</div><div class="food_link">Soup</div>',
    };
  };

  try {
    // 1. Without explicit date in ctx: defaults to today in Toronto based on now
    await foodSource.fetchRaw({ now: Date.UTC(2026, 8, 23, 14, 0) });
    assert.equal(fetchedUrls[0], 'https://uwaterloo.ca/food-services/daily-menu?date=2026-09-23');

    // 2. With explicit date in ctx
    await foodSource.fetchRaw({ date: '2026-09-24' });
    assert.equal(fetchedUrls[1], 'https://uwaterloo.ca/food-services/daily-menu?date=2026-09-24');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

