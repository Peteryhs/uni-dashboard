/** Shared menu_item reading rules, so every reader sees the same full day of dishes. */

/** Well above a real day (about 30 dishes across the three halls), so no outlet is ever cut short. */
export const MENU_ROW_LIMIT = 2000;

/** The client-facing shape of one menu_item row, used by the food card and GET /v1/menu. */
export function menuDish(row) {
  return { dish: row.dish, station: row.station || '', diet: row.diet ?? [], url: row.url ?? '' };
}
