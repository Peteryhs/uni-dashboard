# Recommendation day simulation

The fixture uses invented courses, tasks, a room, and a menu. It does not contain the student's imported data. Run `node tools/simulate-recommendations.mjs` to reproduce the day. The engine performs no network calls or AI inference when building this feed.

| Campus time | First recommendation | Why |
| --- | --- | --- |
| Wednesday 08:00 | Prepare for ECE 150 at 09:00 | The next class is an hour away. Its imported syllabus adds pointers and references; a rain reminder appears below. |
| Wednesday 09:10 | ECE 150 is happening now | The ongoing class remains ahead of later deadlines. |
| Wednesday 11:45 | Lunch at Campus Cafe | No class is in progress and lunch is approaching. The saved dining recommendation supplies the suggestion. |
| Wednesday 14:05 | MATH 117 is happening now | Class takes priority; ECE 198 office hours appear because they precede the design project's deadline. |
| Wednesday 20:00 | ECE 150 Quiz 2 due at 23:59 | The evening deadline takes priority, followed by tomorrow's assignment and a study window. |
| Saturday 10:00 | Begin the ECE 198 design project | The larger project remains useful before Monday's deadline, even without weekend classes. |

The same fixture exercises urgent deadlines and ongoing exams ahead of lunch; completion, undo, and expiring snooze; a changed due date; overlapping commitments; failed and old feeds; old menus; date-only assessments; missing weather measurements; weekly syllabus ranges; and two similarly named quizzes. Twelve recommendation tests cover these behaviors.

## What the engine can know

Quiz 2 explicitly covers **loops and functions** in the synthetic syllabus. That remains the quiz coverage even though today's lecture is about **pointers and references**. Matching a syllabus assessment with its LEARN entry produces one task and preserves the direct quiz link. Without explicit coverage, the feed says coverage has not been provided.

A date-only assessment stays date-only. The engine never invents a midnight deadline. Weekly topics are described as material for the period, with the exact lecture topic unconfirmed. An elapsed due time becomes a request to confirm submission, because the calendar does not reveal whether work was submitted.

Task size can be estimated from names such as project or quiz and is labelled as such. Actual duration is only supplied when the imported syllabus provides it. A study window measures a gap in the imported timetable; it is not a promise that the user is free or that a task will fit. Travel, breaks, and commitments missing from the feed still need consideration.

## Cost and refresh behavior

The feed updates its ordering from the current campus time and persisted facts. Reads are bounded, no model is called, no public weather service is contacted, and no model-generated plan is stored per minute. Dining and weather use cached results prepared elsewhere. The integration test verifies the engine builds successfully with network access disabled and at most twelve store reads for its test case.

## Boundaries

This is a rule-based prioritizer backed by imported facts. It does not see LEARN submission status, course changes absent from the feeds, travel times, personal energy, or private commitments that have not been imported. Course variety is applied only among similarly ranked work; imminent deadlines and current commitments preserve their priority. Source failures and old data remain visible in the response.
