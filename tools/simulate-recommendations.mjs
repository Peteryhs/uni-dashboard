import { recommendationsFromData } from '../apps/relay/src/recommendations.mjs';
import { at, DATE, syntheticDay } from '../test/helpers/recommendation-day.mjs';

const data = syntheticDay();
console.log('Synthetic day simulation (America/Toronto; no network or AI calls)');
for (const [label, date, time] of [['Morning', DATE, '08:00'], ['Class', DATE, '09:10'], ['Lunch', DATE, '11:45'], ['Afternoon', DATE, '14:05'], ['Evening', DATE, '20:00'], ['Weekend', '2026-09-26', '10:00']]) {
  const result = recommendationsFromData({ ...data, now: at(date, time) });
  console.log(`\n${label} ${date} ${time}`);
  console.log(result.items.slice(0, 4).map(item => `  ${item.kind}: ${item.title}`).join('\n'));
}

const roomChange = syntheticDay();
const friday = at('2026-09-25', '09:00');
roomChange.calendar.days[0].events.push({ id: 'friday-room-class', uid: 'ece150-friday-series', source_id: 'uw-portal-ics', category: 'class',
  title: 'ECE 150 lecture', course: 'ECE 150', starts_at: friday, ends_at: friday + 60 * 60_000, location: 'RCH 101', state: 'live', source_label: 'Schedule', links: [] });
roomChange.calendar.alerts = [{ id: 'friday-room-change', event_id: 'friday-room-class', kind: 'room', title: 'ECE 150: Room changed',
  body: 'ECE 150 lecture · E7 2409 → RCH 101', course: 'ECE 150', starts_at: friday, ends_at: friday + 60 * 60_000,
  observed_at: at('2026-09-22', '19:00'), location: 'RCH 101', previous_location: 'E7 2409', previous_at: null, current_at: null,
  all_day: false, url: 'https://example.edu/calendar', confidence: 'confirmed', evidence: 'Compared two successfully parsed calendar snapshots.',
  source_label: 'Schedule', state: 'live' }];
console.log('\nFriday room change reminder');
for (const [date, time] of [['2026-09-22', '21:00'], ['2026-09-24', '09:00']]) {
  const result = recommendationsFromData({ ...roomChange, now: at(date, time) });
  const candidate = result.diagnostics.candidates.find(item => item.kind === 'change' && item.title === 'ECE 150: Room changed');
  const visible = result.items.some(item => item.id === candidate?.id);
  console.log(`  ${date} ${time}: ${visible ? 'shown' : candidate.status}; eligible ${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' }).format(candidate.eligible_at ? new Date(candidate.eligible_at) : new Date(friday - 24 * 60 * 60_000))}; ${candidate.change.previous_location} → ${candidate.change.location}`);
}
