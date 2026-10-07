/**
 * Menu helpers shared by the dining section. The same station keywords are mirrored in the
 * Android client (ui/food/Stations.kt) so both draw the same icon for the same counter.
 */
export type StationKind = 'grill' | 'stove' | 'build' | 'pizza' | 'deli' | 'soup' | 'bakery' | 'other';

const STATION_RULES: [StationKind, RegExp][] = [
  ['grill', /grill|bbq|barbe?cue|carvery|smoke|rotisserie|burger/i],
  ['build', /creation|build|salad|bowl|fresh/i],
  ['pizza', /pizza|oven|flatbread/i],
  ['deli', /deli|sandwich|sub\b|wrap/i],
  ['soup', /soup|noodle|wok|ramen|pho/i],
  ['bakery', /bake|bakery|dessert|sweet|pastry/i],
  ['stove', /hot dish|stove|mom|comfort|entr[eé]e|home|kitchen|counter/i],
];

export function stationKind(station: string): StationKind {
  return STATION_RULES.find(([, re]) => re.test(station))?.[0] ?? 'other';
}

/** Group dishes by station, keeping the page order of both stations and dishes. */
export function stationGroups<T extends { station: string }>(dishes: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const dish of dishes) {
    const list = groups.get(dish.station);
    if (list) list.push(dish);
    else groups.set(dish.station, [dish]);
  }
  return [...groups.entries()];
}

/** The page marks "made without" for gluten and dairy; every other tag is a property the dish has. */
export const DIET_TAGS: Record<string, { short: string; label: string }> = {
  vegan: { short: 'VG', label: 'Vegan' },
  vegetarian: { short: 'V', label: 'Vegetarian' },
  halal: { short: 'H', label: 'Halal' },
  gluten: { short: 'GF', label: 'Gluten-free' },
  dairy: { short: 'DF', label: 'Dairy-free' },
};

export function dietTag(tag: string): { short: string; label: string } {
  return DIET_TAGS[tag.toLowerCase()] ?? { short: tag.slice(0, 3).toUpperCase(), label: tag.charAt(0).toUpperCase() + tag.slice(1) };
}
