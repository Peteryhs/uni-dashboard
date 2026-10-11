import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarEventPassed, calendarNowIndex } from '#contract/calendar-progress.mjs';

const at = (time, day = '2026-10-16') => Date.parse(`${day}T${time}:00-04:00`);
const event = (start, end = start, extra = {}) => ({ starts_at: at(start), ends_at: at(end), all_day: false, ...extra });

test('Now advances after ended events and stays before ongoing or future events', () => {
  const events = [event('00:00', '00:00', { all_day: true }), event('09:00', '10:00'), event('11:00', '12:00'), event('14:00', '15:00')];
  assert.equal(calendarNowIndex(events, at('08:00')), 1);
  assert.equal(calendarNowIndex(events, at('10:00')), 2);
  assert.equal(calendarNowIndex(events, at('11:30')), 2);
  assert.equal(calendarNowIndex(events, at('12:00')), 3);
  assert.equal(calendarNowIndex(events, at('15:00')), 4);
  assert.equal(calendarNowIndex([], at('15:00')), 0);
});

test('muting uses the end time and preserves date-only and multi-day entries', () => {
  assert.equal(calendarEventPassed(event('09:00', '10:00'), at('09:30')), false);
  assert.equal(calendarEventPassed(event('09:00', '10:00'), at('10:00')), true);
  assert.equal(calendarEventPassed(event('17:00'), at('17:00')), true);
  const dateOnly = event('00:00', '00:00', { all_day: true });
  assert.equal(calendarEventPassed(dateOnly, at('23:59')), false);
  assert.equal(calendarEventPassed(dateOnly, at('00:00', '2026-10-17')), true);
  const multiDay = { ...dateOnly, ends_at: at('00:00', '2026-10-18') };
  assert.equal(calendarEventPassed(multiDay, at('23:59', '2026-10-17')), false);
  assert.equal(calendarEventPassed(multiDay, at('00:00', '2026-10-18')), true);
});

test('weekend marker precedes tomorrow’s date-only entries and uses campus days', () => {
  const events = [event('09:00', '10:00'), event('00:00', '00:00', { starts_at: at('00:00', '2026-10-17'), ends_at: at('00:00', '2026-10-17'), all_day: true })];
  assert.equal(calendarNowIndex(events, at('16:00')), 1);
  const dateOnly = event('00:00', '00:00', { all_day: true });
  assert.equal(calendarEventPassed(dateOnly, Date.parse('2026-10-17T03:59:00Z')), false, 'UTC tomorrow is still today on campus');
});
