import { recommendationsFromData } from '../apps/relay/src/recommendations.mjs';
import { at, DATE, syntheticDay } from '../test/helpers/recommendation-day.mjs';

const data = syntheticDay();
console.log('Synthetic day simulation (America/Toronto; no network or AI calls)');
for (const [label, date, time] of [['Morning', DATE, '08:00'], ['Class', DATE, '09:10'], ['Lunch', DATE, '11:45'], ['Afternoon', DATE, '14:05'], ['Evening', DATE, '20:00'], ['Weekend', '2026-09-26', '10:00']]) {
  const result = recommendationsFromData({ ...data, now: at(date, time) });
  console.log(`\n${label} ${date} ${time}`);
  console.log(result.items.slice(0, 4).map(item => `  ${item.kind}: ${item.title}`).join('\n'));
}
