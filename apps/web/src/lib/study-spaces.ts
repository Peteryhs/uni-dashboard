/**
 * Occupancy helpers for the study-spaces card.
 *
 * Waitz reports people and capacity. The card also carries a precomputed percent, but floor rows
 * and cached bundles can omit it, so the same rounded and clamped value is derived here.
 */

export type OccupancyLabel = 'Quiet' | 'Comfortable' | 'Busy' | 'Very busy' | 'No count';

export interface OccupancySpace {
  people: number | null;
  capacity: number | null;
  percent?: number | null;
}

export interface StudySpaceBestLike extends OccupancySpace {
  library_name: string;
  space_name: string;
}

function isNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function occupancyPercent(
  people: number | null | undefined,
  capacity: number | null | undefined,
): number | null {
  if (!isNumber(people) || people < 0 || !isNumber(capacity) || capacity <= 0) return null;
  return clampPercent((people / capacity) * 100);
}

export function occupancyLabel(percent: number | null | undefined): OccupancyLabel {
  if (!isNumber(percent) || percent < 0) return 'No count';
  if (percent <= 15) return 'Quiet';
  if (percent <= 40) return 'Comfortable';
  if (percent <= 70) return 'Busy';
  return 'Very busy';
}

/** The card's own percent wins, so a saved bundle keeps the value it was built with. */
export function studySpacePercent(space: OccupancySpace): number | null {
  if (isNumber(space.percent)) return clampPercent(space.percent);
  return occupancyPercent(space.people, space.capacity);
}

export function formatPeopleCount(people: number | null | undefined): string | null {
  if (!isNumber(people) || people < 0) return null;
  const count = Math.round(people);
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

export function formatPeopleCapacity(
  people: number | null | undefined,
  capacity: number | null | undefined,
): string | null {
  if (!isNumber(people) || people < 0 || !isNumber(capacity) || capacity <= 0) return null;
  return `${Math.round(people)} / ${Math.round(capacity)} people`;
}

export function formatStudySpaceCount(
  people: number | null | undefined,
  capacity: number | null | undefined,
  percent?: number | null,
): string {
  const share = isNumber(percent) ? clampPercent(percent) : occupancyPercent(people, capacity);
  const peopleText = formatPeopleCount(people);
  if (share == null || peopleText == null || !isNumber(capacity) || capacity <= 0) return 'No count';
  return `${peopleText} · ${share}% of ${Math.round(capacity)}`;
}

export function bestSpaceDetail(best: StudySpaceBestLike | null | undefined): string {
  if (!best) return '';
  return formatStudySpaceCount(best.people, best.capacity, best.percent);
}

export function bestSpaceTitle(best: StudySpaceBestLike | null | undefined): string {
  if (!best) return '';
  const space = best.space_name?.trim();
  return space ? `${best.library_name} · ${space}` : best.library_name;
}
