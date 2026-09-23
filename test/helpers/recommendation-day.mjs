/** Entirely synthetic university day, suitable for public simulations. */
export const at = (date, time) => Date.parse(`${date}T${time}:00-04:00`);
export const DATE = '2026-09-23';
const event = (id, category, title, course, date, start, end = start, extra = {}) => ({
  id, category, title, course, starts_at: at(date, start), ends_at: at(date, end), all_day: false,
  state: 'live', source_label: category === 'deadline' ? 'LEARN' : 'Schedule', location: 'Campus room', links: [], description: '', url: null, ...extra,
});
export function syntheticDay() {
  const events = [
    event('class-ece150', 'class', 'ECE 150 lecture', 'ECE 150', DATE, '09:00', '10:00'),
    event('class-math117', 'class', 'MATH 117 tutorial', 'MATH 117', DATE, '14:00', '15:00'),
    event('quiz', 'deadline', 'ECE 150 - Quiz 2 - Due', 'ECE 150', DATE, '23:59', '23:59', { links: [{ kind: 'quiz', url: 'https://learn.uwaterloo.ca/d2l/lms/quizzing/quiz2', label: 'Quiz 2' }] }),
    event('math-assignment', 'deadline', 'MATH 117 - Assignment 2 - Due', 'MATH 117', '2026-09-24', '18:00'),
    event('ece-project', 'deadline', 'ECE 198 - Design project - Due', 'ECE 198', '2026-09-28', '18:00'),
    event('office', 'office_hours', 'ECE 198 office hours', 'ECE 198', DATE, '15:00', '16:00'),
  ];
  const entry = (id, kind, title, extra = {}) => ({ id, kind, title, start_date: DATE, end_date: DATE, due_at: null, topics: [], readings: [], url: null, effort: 'unknown', estimated_minutes: null, evidence: `${DATE}: ${title}`, ...extra });
  return {
    calendar: { days: [{ date: DATE, events }], courses: ['ECE 150', 'MATH 117', 'ECE 198'].map((course, i) => ({ course, learn_url: `https://learn.uwaterloo.ca/d2l/home/${100 + i}`, resources: [] })), sources: [{ id: 'uw-portal-ics', status: 'ok' }, { id: 'uw-learn-ics', status: 'ok' }], truncated: false },
    syllabi: [{ course: 'ECE 150', entries: [
      entry('topic', 'topic', 'Pointers', { topics: ['Pointers and references'], readings: ['Chapter 5'] }),
      entry('quiz', 'assessment', 'Quiz 2', { due_at: at(DATE, '23:59'), topics: ['Loops and functions'], effort: 'small', evidence: 'Quiz 2 — Sept 23, 11:59 PM; covers loops and functions.' }),
    ] }],
    food: { status: 'ready', service_date: DATE, recommendation: { headline: 'Try the tofu bowl.', top_outlet: 'Campus Cafe', ranked_outlets: [{ outlet: 'Campus Cafe', rank: 1 }] } },
    menu: [{ service_date: DATE, outlet: 'Campus Cafe', dish: 'Tofu bowl', url: 'https://example.edu/menu' }],
    weather: { observed_at: at(DATE, '07:30'), state: 'live', forecast: [{ at: at(DATE, '09:00'), temp_c: 13, feels_c: 11, precip_prob: 75, precip_mm: 1.2, wind_kmh: 15 }] },
  };
}
