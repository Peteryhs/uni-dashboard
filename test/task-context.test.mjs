import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  courseFromLocation,
  extractLinks,
  descriptionBody,
  taskContext,
  unescapeIcsText,
  phaseOf,
  groupScope,
  parseDescriptionDueDate,
  cleanDisplayTitle,
  isSameAssessment,
} from '../apps/relay/src/task-context.mjs';

/**
 * Every string in this file was copied out of the live LEARN and Portal feeds on 2026-09-22, so the
 * parser is tested against what the feeds actually send rather than against invented examples.
 */

test('LOCATION is a course for LEARN tasks and a place for everything else', () => {
  assert.equal(courseFromLocation('ECE 198 - Fall 2026').course, 'ECE 198');
  assert.equal(courseFromLocation('MATH 117 - Fall 2026').course, 'MATH 117');
  assert.equal(courseFromLocation('MTHEL 99 - Fall 2026').course, 'MTHEL 99');
  assert.equal(courseFromLocation('COMMST 191/COMMST 192 - Fall 2026').course, 'COMMST 191/COMMST 192');

  // a venue with a term glued on the end is not a course
  const venue = courseFromLocation('Claudette Millar Hall (CMH) - Great Hall (CFE – Fall 2026)');
  assert.equal(venue.course, '');
  assert.match(venue.place, /Claudette Millar Hall/);

  assert.equal(courseFromLocation('University of Waterloo').course, '');
  assert.equal(courseFromLocation('Engineering Ready Modules (2026)').place, 'Engineering Ready Modules (2026)');
  assert.deepEqual(courseFromLocation(''), { course: '', place: '' });
});

test('links come out of the description with a kind and a label', () => {
  const description =
    '\\nTest your understanding of Waterloo Ready with this short 4-question quiz!\\n' +
    '\\nQuizzes:\\nResidence Experience - https://learn.uwaterloo.ca/d2l/lms/quizzing/quizzing.d2l?ou=1133427&qi=321940' +
    '\\n\\nView event - https://learn.uwaterloo.ca/d2l/le/calendar/1133427/event/3773431/detailsview?ou=1133427#3773431';

  const links = extractLinks(description);
  assert.equal(links.length, 2);
  assert.equal(links[0].kind, 'quiz', 'the quiz outranks the generic view-event link');
  assert.equal(links[0].label, 'Residence Experience');
  assert.match(links[0].url, /quizzing\.d2l/);
  assert.equal(links[1].kind, 'event');
  assert.equal(links[1].label, 'View event');
});

test('a dropbox link is recognised as a submission, not just a link', () => {
  const links = extractLinks(
    'Dropbox:\\nRelease Forms - https://learn.uwaterloo.ca/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=1307622&db=415640',
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, 'submit');
  assert.equal(links[0].label, 'Release Forms');
});

test('the same link twice in one description appears once', () => {
  const url = 'https://learn.uwaterloo.ca/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=1&db=2';
  const links = extractLinks(`Dropbox:\nThing - ${url}\nView event - ${url}`);
  assert.equal(links.length, 1);
});

test('the body keeps the sentences and drops the link plumbing', () => {
  const description =
    '\\n\\n\\nWhat: A 15-minute résumé review with a first year tutor or trained staff member \\n\\nWhere: CMH Great Hall.' +
    '\\n\\nDropbox:\\nRelease Forms - https://learn.uwaterloo.ca/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=1&db=2' +
    '\\n\\nView event - https://learn.uwaterloo.ca/d2l/le/calendar/1/event/2/detailsview';

  const body = descriptionBody(description);
  assert.match(body, /15-minute résumé review/);
  assert.match(body, /Where: CMH Great Hall/);
  assert.ok(!body.includes('https://'), 'no raw URLs in the prose');
  assert.ok(!body.includes('View event'));
  assert.ok(!body.includes('Dropbox:'));
});

test('taskContext returns course, place, links and body together', () => {
  const ctx = taskContext({
    title: 'Prework 1 Quiz - Due',
    location: 'ECE 198 - Fall 2026',
    description: 'Workshop 1 Prequiz\\n\\nQuizzes:\\nPrework 1 Quiz - https://learn.uwaterloo.ca/d2l/lms/quizzing/quizzing.d2l?ou=1318281&qi=328370',
  });
  assert.equal(ctx.course, 'ECE 198');
  assert.equal(ctx.place, '');
  assert.equal(ctx.links[0].kind, 'quiz');
  assert.equal(ctx.url, ctx.links[0].url, 'the primary url is the quiz, not the view-event link');
  assert.equal(ctx.body, 'Workshop 1 Prequiz');
});

test('a task with no location falls back to the course in the title', () => {
  const ctx = taskContext({ title: 'ECE 150 - Assignment 3 due', location: '', description: '' });
  assert.equal(ctx.course, 'ECE 150');
  assert.deepEqual(ctx.links, []);
  assert.equal(ctx.url, '');
});

test('a task with no links anywhere does not invent one', () => {
  const ctx = taskContext({ title: 'Quiz #1', location: 'ECE 105 - Fall 2026', description: '' });
  assert.equal(ctx.course, 'ECE 105');
  assert.equal(ctx.url, '');
  assert.equal(ctx.body, '');
});

test('ICS escapes are undone before anything is parsed', () => {
  assert.equal(unescapeIcsText('Course Drop\\, Penalty 1\\nSecond line'), 'Course Drop, Penalty 1\nSecond line');
});

test('phaseOf separates opening dates from due dates', () => {
  assert.equal(phaseOf('MATH 117 Tutorial 4 - Available'), 'opens');
  assert.equal(phaseOf('Project Team Contract - Available'), 'opens');
  assert.equal(phaseOf('Prework 2 Quiz - Due'), 'due');
  assert.equal(phaseOf('Assignment #2 due'), 'due');
  assert.equal(phaseOf('Residence Experience - Availability Ends'), 'due', 'Availability Ends is a deadline, not an opening');
  assert.equal(phaseOf('ECE190 midterm test'), 'due');
});

test('groupScope parses section and group bounds from title brackets', () => {
  const g1 = groupScope('Group Deliverable 1 (Part 1) submission [Sec 002 Groups 1-20] - Due');
  assert.equal(g1.section, 2);
  assert.deepEqual(g1.groups, [1, 20]);
  assert.equal(g1.base, 'Group Deliverable 1 (Part 1) submission - Due');

  const g2 = groupScope('Group Agreement Form submission [Sec 002 Groups 1-40] - Due');
  assert.equal(g2.section, 2);
  assert.deepEqual(g2.groups, [1, 40]);
  assert.equal(g2.base, 'Group Agreement Form submission - Due');

  const g3 = groupScope('Quiz #2');
  assert.equal(g3.section, null);
  assert.equal(g3.groups, null);
  assert.equal(g3.base, 'Quiz #2');
});

test('parseDescriptionDueDate extracts due dates from event description with HTML and Crowdmark note', () => {
  const desc =
    '8:30amTUTORIAL ASSIGNMENT 3 - AvailableMATH 117opens<p>To be submitted to Crowdmark by 6pm on Friday, Oct 2. Lateness penalty of 1% per minute.</p> Materials TUTORIAL ASSIGNMENT 3\\nLEARN[View event](https://learn.uwaterloo.ca/d2l/le/calendar/1288774/event/3846570/detailsview?ou=1288774#3846570)Hide event';

  const refDate = Date.parse('2026-09-25T12:00:00Z');
  const res = parseDescriptionDueDate(desc, { eventStart: refDate, timezone: 'America/Toronto' });
  assert.ok(res, 'should successfully parse due date from description');

  // Verify against America/Toronto: Oct 2 2026, 18:00 (EDT = UTC-4) -> 2026-10-02 22:00:00Z
  const expectedUtc = Date.parse('2026-10-02T22:00:00.000Z');
  assert.equal(res.due_at, expectedUtc);
  assert.match(res.text, /6pm on Friday, Oct 2/i);
});

test('parseDescriptionDueDate handles various syntax variants and ignores non-due dates', () => {
  const refDate = Date.parse('2026-09-25T12:00:00Z');

  // "Due Friday, Oct 2 at 11:59pm"
  const r1 = parseDescriptionDueDate('Due Friday, Oct 2 at 11:59pm', { eventStart: refDate });
  assert.ok(r1);
  assert.equal(new Date(r1.due_at).toISOString(), '2026-10-03T03:59:00.000Z'); // 23:59 EDT = 03:59 UTC next day

  // ISO date with time: "Must be submitted before 2026-10-05 17:00"
  const r2 = parseDescriptionDueDate('Must be submitted before 2026-10-05 17:00', { eventStart: refDate });
  assert.ok(r2);
  assert.equal(new Date(r2.due_at).toISOString(), '2026-10-05T21:00:00.000Z'); // 17:00 EDT = 21:00 UTC

  // Non-due descriptions should return null
  assert.equal(parseDescriptionDueDate('Office hours held in MC 4015 every Friday at 2pm', { eventStart: refDate }), null);
  assert.equal(parseDescriptionDueDate('Read chapter 4 and complete exercises 1 to 5', { eventStart: refDate }), null);
  assert.equal(parseDescriptionDueDate('', { eventStart: refDate }), null);
  assert.equal(parseDescriptionDueDate(null, { eventStart: refDate }), null);
});

test('taskContext automatically populates due_at when parsed from description', () => {
  const refDate = Date.parse('2026-09-25T12:00:00Z');
  const ctx = taskContext({
    title: 'TUTORIAL ASSIGNMENT 3 - Available',
    location: 'MATH 117 - Fall 2026',
    description: '<p>To be submitted to Crowdmark by 6pm on Friday, Oct 2.</p>',
    starts_at: refDate,
  });
  assert.equal(ctx.course, 'MATH 117');
  assert.ok(ctx.due_at);
  assert.equal(new Date(ctx.due_at).toISOString(), '2026-10-02T22:00:00.000Z');
});

test('cleanDisplayTitle removes both - Available and - Due tags', () => {
  assert.equal(cleanDisplayTitle('TUTORIAL ASSIGNMENT 3 - Available'), 'TUTORIAL ASSIGNMENT 3');
  assert.equal(cleanDisplayTitle('TUTORIAL ASSIGNMENT 3 - Due'), 'TUTORIAL ASSIGNMENT 3');
  assert.equal(cleanDisplayTitle('Project Milestone 1 Available'), 'Project Milestone 1');
  assert.equal(cleanDisplayTitle('Quiz 4 Due'), 'Quiz 4');
});

test('isSameAssessment matches corresponding assessments and avoids merging numbered items', () => {
  // Matching across available/due variants
  assert.equal(
    isSameAssessment('TUTORIAL ASSIGNMENT 3 - Available', 'TUTORIAL ASSIGNMENT 3 - Due', 'MATH 117', 'MATH 117'),
    true
  );
  // Matching with course in title
  assert.equal(
    isSameAssessment('TUTORIAL ASSIGNMENT 3 - Available', 'MATH 117 - TUTORIAL ASSIGNMENT 3 - Due', 'MATH 117', 'MATH 117'),
    true
  );
  // Different courses do not match
  assert.equal(
    isSameAssessment('Assignment 1', 'Assignment 1', 'MATH 117', 'ECE 105'),
    false
  );
  // Differently numbered quizzes do NOT match
  assert.equal(
    isSameAssessment('Quiz 1 - Available', 'Quiz 10 - Due', 'ECE 150', 'ECE 150'),
    false
  );
  assert.equal(
    isSameAssessment('Assignment 2', 'Assignment 20', 'MATH 117', 'MATH 117'),
    false
  );
});

