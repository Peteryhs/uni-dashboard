import { test } from 'node:test';
import assert from 'node:assert/strict';
import { courseFromLocation, extractLinks, descriptionBody, taskContext, unescapeIcsText } from '../apps/relay/src/task-context.mjs';

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
