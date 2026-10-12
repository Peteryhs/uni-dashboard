import test from 'node:test';
import assert from 'node:assert/strict';
import { campusDate, shiftDate, formatTime, formatShortDay } from '../apps/web/src/lib/time.ts';

test('menu dates advance at campus midnight, independently of the device timezone', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'America/Vancouver';
    const before = Date.parse('2026-10-12T03:59:59Z');
    const after = Date.parse('2026-10-12T04:00:00Z');
    assert.equal(campusDate(before), '2026-10-11');
    assert.equal(campusDate(after), '2026-10-12');
    assert.equal(shiftDate(campusDate(before), 1), '2026-10-12');
    assert.equal(shiftDate(campusDate(after), 1), '2026-10-13');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('calendar date shifting survives daylight saving and year boundaries', () => {
  assert.equal(shiftDate('2026-03-08', 1), '2026-03-09');
  assert.equal(shiftDate('2026-11-01', 1), '2026-11-02');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDate('2027-01-01', -1), '2026-12-31');
});

test('office-hours preview formatting uses campus dates and times across DST', () => {
  const summer = Date.parse('2026-10-12T18:00:00Z');
  const winter = Date.parse('2026-11-02T19:00:00Z');
  assert.equal(formatTime(summer), '2:00pm');
  assert.equal(formatTime(winter), '2:00pm');
  assert.equal(formatShortDay(Date.parse('2026-10-12T01:00:00Z')), 'Sun, Oct 11');
});
