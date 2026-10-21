import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bestSpaceDetail,
  bestSpaceTitle,
  formatPeopleCapacity,
  formatStudySpaceCount,
  occupancyLabel,
  occupancyPercent,
} from '../apps/web/src/lib/study-spaces.ts';

test('occupancy labels hold at every documented boundary', () => {
  assert.equal(occupancyLabel(null), 'No count');
  assert.equal(occupancyLabel(0), 'Quiet');
  assert.equal(occupancyLabel(15), 'Quiet');
  assert.equal(occupancyLabel(16), 'Comfortable');
  assert.equal(occupancyLabel(40), 'Comfortable');
  assert.equal(occupancyLabel(41), 'Busy');
  assert.equal(occupancyLabel(70), 'Busy');
  assert.equal(occupancyLabel(71), 'Very busy');
  assert.equal(occupancyLabel(100), 'Very busy');
});

test('occupancy percent rounds, clamps, and rejects unusable values', () => {
  assert.equal(occupancyPercent(13, 145), 9);
  assert.equal(occupancyPercent(1, 8), 13);
  assert.equal(occupancyPercent(2, 3), 67);
  assert.equal(occupancyPercent(1, 3), 33);
  assert.equal(occupancyPercent(150, 100), 100);
  assert.equal(occupancyPercent(-5, 100), null, 'a negative count is unknown, not empty');
  assert.equal(occupancyPercent(5, 0), null);
  assert.equal(occupancyPercent(0, 0), null);
  assert.equal(occupancyPercent(5, -10), null);
  assert.equal(occupancyPercent(null, 100), null);
  assert.equal(occupancyPercent(5, null), null);
  assert.equal(occupancyPercent(undefined, undefined), null);
});

test('best-space detail names both counts without inventing a percentage', () => {
  assert.equal(bestSpaceDetail({
    library_name: 'Dana Porter Library',
    space_name: 'Main Floor Study Space',
    people: 13,
    capacity: 145,
    percent: 9,
  }), '13 people · 9% of 145');
  assert.equal(bestSpaceDetail({
    library_name: 'Dana Porter Library',
    space_name: 'Main Floor Study Space',
    people: 13,
    capacity: 145,
    percent: null,
  }), '13 people · 9% of 145');
  assert.equal(bestSpaceDetail({
    library_name: 'Dana Porter Library',
    space_name: 'Main Floor Study Space',
    people: null,
    capacity: 145,
    percent: 9,
  }), 'No count');
  assert.equal(bestSpaceDetail(null), '');
});

test('best-space title joins the library and floor without dropping either', () => {
  assert.equal(bestSpaceTitle({
    library_name: 'Dana Porter Library',
    space_name: 'Main Floor Study Space',
    people: 13,
    capacity: 145,
    percent: 9,
  }), 'Dana Porter Library · Main Floor Study Space');
  assert.equal(bestSpaceTitle({
    library_name: 'Dana Porter Library',
    space_name: '   ',
    people: 13,
    capacity: 145,
    percent: 9,
  }), 'Dana Porter Library');
  assert.equal(bestSpaceTitle(null), '');
});

test('count formatting keeps one person singular and hides a missing capacity', () => {
  assert.equal(formatStudySpaceCount(1, 100), '1 person · 1% of 100');
  assert.equal(formatStudySpaceCount(13, 145, 9), '13 people · 9% of 145');
  assert.equal(formatStudySpaceCount(13, 0), 'No count');
  assert.equal(formatStudySpaceCount(null, 145), 'No count');
  assert.equal(formatPeopleCapacity(13, 145), '13 / 145 people');
  assert.equal(formatPeopleCapacity(13, null), null);
});
