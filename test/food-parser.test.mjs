import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseFoodPage, toMenuItems } from '../sources/food/parse.mjs';
import * as foodSource from '../sources/food/source.mjs';
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
