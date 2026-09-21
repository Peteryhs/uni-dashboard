import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRow, validateRows, TimelineEvent } from '#contract/canonical.mjs';
import { ageState, ageDescriptor, buildBundle, renderableCards, validateBundle } from '#contract/cards.mjs';
import { validateCardData } from '#contract/card-data.mjs';

const base = { source_id: 's', external_id: 'e', observed_at: 1, valid_until: 2 };

test('canonical rows require the freshness envelope', () => {
  assert.throws(() => validateRow('timeline_event', { ...base, kind: 'class', title: 'x', starts_at: 1, ends_at: 2, observed_at: undefined }), /observed_at/);
});

test('canonical rejects an unknown kind', () => {
  assert.throws(
    () => validateRow('timeline_event', { ...base, kind: 'nap', title: 'x', starts_at: 1, ends_at: 2 }),
    /kind/,
  );
});

test('canonical accepts a minimal valid row and fills defaults', () => {
  const row = validateRow('timeline_event', { ...base, kind: 'class', title: 'ECE 150', starts_at: 10, ends_at: 20 });
  assert.equal(row.subtitle, '');
  assert.equal(row.all_day, false);
});

test('rows are validated individually so a bad row names itself', () => {
  assert.throws(
    () => validateRows('menu_item', [{ ...base, outlet: 'REV', dish: 'x', service_date: 'not-a-date' }]),
    /service_date/,
  );
});

test('age ladder is measured against the source cadence, not the clock', () => {
  const cadence = 60_000;
  const now = 1_000_000_000;
  assert.equal(ageState(now - 30_000, cadence, now), 'live');
  assert.equal(ageState(now - cadence, cadence, now), 'live');
  assert.equal(ageState(now - cadence * 2, cadence, now), 'ageing');
  assert.equal(ageState(now - cadence * 4, cadence, now), 'stale');
  assert.equal(ageState(now - cadence * 7, cadence, now), 'dead');
  assert.equal(ageState(null, cadence, now), 'empty');
});

test('the same age is fresh for a slow source and stale for a fast one', () => {
  const now = 1_000_000_000;
  const age = 4 * 60_000; // four minutes
  assert.equal(ageState(now - age, 12 * 60 * 60_000, now), 'live'); // menu: well inside its cadence
  assert.equal(ageState(now - age, 60_000, now), 'stale'); // live status: 4x its cadence
  assert.equal(ageState(now - age, 30_000, now), 'dead'); // anything faster than that is a lie at 4 min
});

test('stale states stop motion and go amber+dashed, live ones do not', () => {
  assert.deepEqual(ageDescriptor('live'), { hairline: 'accent', motion: true, muted: false, dash: false, dot: false });
  const stale = ageDescriptor('stale');
  assert.equal(stale.motion, false);
  assert.equal(stale.dash, true);
  assert.equal(stale.muted, true);
});

test('an unknown card type is skipped and counted, never fatal', () => {
  const bundle = buildBundle([
    { id: 'a', type: 'food', priority: 1, state: 'live', observed_at: 1, valid_until: 2, data: {} },
    { id: 'b', type: 'from_the_future', priority: 2, state: 'live', observed_at: 1, valid_until: 2, data: {} },
  ]);
  const { rendered, skipped } = renderableCards(bundle, ['food']);
  assert.equal(rendered.length, 1);
  assert.equal(skipped, 1);
});

test('cards are ordered by server-computed priority', () => {
  const bundle = buildBundle([
    { id: 'low', type: 'food', priority: 10, state: 'live', observed_at: 1, valid_until: 2, data: {} },
    { id: 'high', type: 'alert', priority: 99, state: 'live', observed_at: 1, valid_until: 2, data: {} },
  ]);
  assert.deepEqual(bundle.cards.map((c) => c.id), ['high', 'low']);
});

test('a malformed bundle is rejected loudly', () => {
  assert.throws(() => validateBundle({ schema_version: 1, cards: 'nope' }), /min_client_version|cards/);
});

test('card payload schemas catch the string-vs-number class of bug', () => {
  assert.throws(
    () => validateCardData('next_commitment', { title: 'x', starts_at: '1789997400000.0' }),
    /starts_at/,
  );
  const ok = validateCardData('next_commitment', { title: 'x', starts_at: 1789997400000 });
  assert.equal(typeof ok.starts_at, 'number');
});

test('food payload requires pinned entries to be marked pinned', () => {
  assert.throws(
    () =>
      validateCardData('food', {
        service_date: '2026-09-21',
        pinned: [{ outlet: 'REV', pinned: false, serving: true, dish_count: 1, dishes: [] }],
        others: [],
        others_count: 0,
        total_dishes: 1,
      }),
    /pinned/,
  );
});

test('TimelineEvent is exported for direct use by adapters', () => {
  assert.equal(typeof TimelineEvent.parse, 'function');
});
