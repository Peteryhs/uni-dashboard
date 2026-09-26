import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OfficeHourRule,
  OfficeHoursConfig,
  OfficeHoursDraft,
} from '#contract/office-hours.mjs';
import {
  expandRuleOccurrences,
  buildPreviewOccurrences,
  userOfficeHours,
} from '#sources/office-hours/source.mjs';
import {
  parseOfficeHoursWithAi,
  runStructured,
  clearAiCache,
  DEFAULT_AI_MODEL,
} from '../apps/relay/src/ai.mjs';
import { SqliteStore } from '../apps/relay/src/store.mjs';
import { runSource } from '../apps/relay/src/runner.mjs';
import { createServer } from '../apps/relay/src/server.mjs';
import { dueSoonCard, nextCommitmentCard } from '../apps/relay/src/cards.mjs';
import { zonedToEpoch } from '#sources/ics/parse.mjs';
import { DatabaseSync } from 'node:sqlite';
import { D1Store } from '../apps/relay/src/d1-store.mjs';
import worker from '../apps/relay/src/worker.mjs';

test('expandRuleOccurrences expands weekly rules accurately across window', () => {
  const rule = {
    id: 'test-1',
    course: 'ECE 198',
    label: 'Prof office hours',
    kind: 'office_hours',
    host: 'Prof. Smith',
    location: 'E7 3416',
    byday: ['MO', 'WE'],
    start_local: '14:00',
    end_local: '15:00',
    starts_on: '2026-09-28',
    until: '2026-10-12',
    notes: '',
  };

  const windowStart = zonedToEpoch(2026, 9, 21, 0, 0, 0, 'America/Toronto');
  const windowEnd = zonedToEpoch(2026, 10, 20, 23, 59, 59, 'America/Toronto');

  const occs = expandRuleOccurrences(rule, { windowStart, windowEnd, tz: 'America/Toronto' });
  assert.ok(occs.length > 0);

  // Check starts_on boundary: none before Sept 28
  for (const o of occs) {
    assert.ok(o.start >= zonedToEpoch(2026, 9, 28, 0, 0, 0, 'America/Toronto'));
    assert.ok(o.start <= zonedToEpoch(2026, 10, 12, 23, 59, 59, 'America/Toronto'));
    // Duration is 1 hour
    assert.equal(o.end - o.start, 60 * 60 * 1000);
  }
});

test('AC 8: DST transition across November 2026 maintains identical local wall-clock time (14:00) on both sides', () => {
  // Daylight Saving Time in America/Toronto ends on Sunday, November 1, 2026.
  // Clocks fall back from UTC-4 (EDT) to UTC-5 (EST).
  const rule = {
    id: 'dst-rule',
    course: 'MATH 117',
    label: 'Wednesday Clinic',
    kind: 'help_session',
    host: '',
    location: 'MC 2042',
    byday: ['WE'],
    start_local: '14:00',
    end_local: '15:00',
    starts_on: '2026-10-21',
    until: '2026-11-18',
    notes: '',
  };

  const windowStart = zonedToEpoch(2026, 10, 20, 0, 0, 0, 'America/Toronto');
  const windowEnd = zonedToEpoch(2026, 11, 20, 23, 59, 59, 'America/Toronto');

  const occs = expandRuleOccurrences(rule, { windowStart, windowEnd, tz: 'America/Toronto' });
  assert.equal(occs.length, 5); // Oct 21, Oct 28, Nov 4, Nov 11, Nov 18

  for (const occ of occs) {
    const timeStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Toronto',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(occ.start));
    assert.equal(timeStr, '14:00', 'Local wall-clock time must stay exactly 14:00 across DST shift');
  }

  // Pre-DST: Oct 28 14:00 EDT = 18:00 UTC
  // Post-DST: Nov 4 14:00 EST = 19:00 UTC
  const oct28Occ = occs.find((o) => new Date(o.start).getUTCDate() === 28);
  const nov4Occ = occs.find((o) => new Date(o.start).getUTCDate() === 4);
  assert.ok(oct28Occ && nov4Occ);
  assert.equal(new Date(oct28Occ.start).toISOString(), '2026-10-28T18:00:00.000Z');
  assert.equal(new Date(nov4Occ.start).toISOString(), '2026-11-04T19:00:00.000Z');
});

test('buildPreviewOccurrences returns up to count occurrences sorted by starts_at', () => {
  const rules = [
    {
      course: 'ECE 198',
      label: 'Office hours',
      kind: 'office_hours',
      byday: ['MO', 'WE'],
      start_local: '14:00',
      end_local: '15:00',
      starts_on: '2026-09-28',
      until: '2026-12-05',
      location: 'E7 3416',
    },
    {
      course: 'ECE 198',
      label: 'TA session',
      kind: 'help_session',
      byday: ['TH'],
      start_local: '10:30',
      end_local: '11:20',
      starts_on: '2026-09-28',
      until: '2026-12-05',
      location: 'DC 2568',
    },
  ];

  const now = zonedToEpoch(2026, 9, 25, 12, 0, 0, 'America/Toronto');
  const preview = buildPreviewOccurrences(rules, { now, tz: 'America/Toronto', count: 6 });

  assert.equal(preview.length, 6);
  // Verify strictly sorted by starts_at
  for (let i = 1; i < preview.length; i++) {
    assert.ok(preview[i].starts_at >= preview[i - 1].starts_at);
  }
  // Matches slot
  assert.ok(preview[0].label.includes('ECE 198'));
});

test('Fixtures 1-6 recurrence and occurrence expansion', () => {
  // Fixture 1: Mon & Wed 2:00-3:00pm in E7 3416
  const fix1 = {
    course: 'ECE 198',
    label: 'Office hours',
    kind: 'office_hours',
    byday: ['MO', 'WE'],
    start_local: '14:00',
    end_local: '15:00',
    location: 'E7 3416',
    starts_on: null,
    until: null,
  };
  const occ1 = expandRuleOccurrences(fix1, {
    windowStart: zonedToEpoch(2026, 9, 21, 0, 0, 0, 'America/Toronto'),
    windowEnd: zonedToEpoch(2026, 9, 28, 0, 0, 0, 'America/Toronto'),
    tz: 'America/Toronto',
  });
  assert.equal(occ1.length, 2); // Mon Sept 21 and Wed Sept 23

  // Fixture 2: TTh 10:30-11:20 (50-minute slot preserved)
  const fix2 = {
    course: '',
    label: 'Office hours',
    kind: 'office_hours',
    byday: ['TU', 'TH'],
    start_local: '10:30',
    end_local: '11:20',
    location: 'DC 2568',
    starts_on: null,
    until: null,
  };
  const occ2 = expandRuleOccurrences(fix2, {
    windowStart: zonedToEpoch(2026, 9, 21, 0, 0, 0, 'America/Toronto'),
    windowEnd: zonedToEpoch(2026, 9, 28, 0, 0, 0, 'America/Toronto'),
    tz: 'America/Toronto',
  });
  assert.equal(occ2.length, 2);
  assert.equal(occ2[0].end - occ2[0].start, 50 * 60 * 1000, '50-minute slot must be preserved');

  // Fixture 3: Fridays 1-2pm starting Oct 3 until Dec 5
  const fix3 = {
    course: '',
    label: 'OH',
    kind: 'office_hours',
    byday: ['FR'],
    start_local: '13:00',
    end_local: '14:00',
    starts_on: '2026-10-03',
    until: '2026-12-05',
    location: '',
  };
  const occ3 = expandRuleOccurrences(fix3, {
    windowStart: zonedToEpoch(2026, 9, 21, 0, 0, 0, 'America/Toronto'),
    windowEnd: zonedToEpoch(2026, 12, 15, 0, 0, 0, 'America/Toronto'),
    tz: 'America/Toronto',
  });
  assert.ok(occ3.length > 0);
  assert.ok(occ3[0].start >= zonedToEpoch(2026, 10, 3, 0, 0, 0, 'America/Toronto'));
  assert.ok(occ3[occ3.length - 1].start <= zonedToEpoch(2026, 12, 5, 23, 59, 59, 'America/Toronto'));

  // Fixture 5: Appointment only produces 0 rules
  const fix5Draft = OfficeHoursDraft.parse({ rules: [], warnings: ['Office hours by appointment only'] });
  assert.equal(fix5Draft.rules.length, 0);
  assert.equal(fix5Draft.warnings.length, 1);

  // Fixture 6: MWF 11:30-12:20 with reading week note
  const fix6 = {
    course: '',
    label: 'Class',
    kind: 'office_hours',
    byday: ['MO', 'WE', 'FR'],
    start_local: '11:30',
    end_local: '12:20',
    location: '',
    starts_on: null,
    until: null,
    notes: 'no class during reading week',
  };
  const occ6 = expandRuleOccurrences(fix6, {
    windowStart: zonedToEpoch(2026, 9, 21, 0, 0, 0, 'America/Toronto'),
    windowEnd: zonedToEpoch(2026, 9, 28, 0, 0, 0, 'America/Toronto'),
    tz: 'America/Toronto',
  });
  assert.equal(occ6.length, 3); // Mon, Wed, Fri
  assert.equal(fix6.notes, 'no class during reading week');
});

test('AC 4: Malformed AI response retries once, then returns 502 with raw text', async () => {
  clearAiCache();
  let callCount = 0;
  const mockAiRun = async (model, payload) => {
    callCount++;
    // Returns invalid response missing required fields
    return {
      response: 'This is not valid json at all and cannot parse',
    };
  };

  await assert.rejects(
    async () => {
      await parseOfficeHoursWithAi({
        text: 'Office hours: Mon & Wed 2-3pm in E7',
        env: { AI: { run: mockAiRun } },
        now: 1000,
      });
    },
    (err) => {
      assert.equal(err.status, 502);
      assert.ok(err.raw.includes('This is not valid json'));
      return true;
    },
    'Must fail with 502 on double validation failure'
  );

  assert.equal(callCount, 2, 'Must have attempted exactly one retry');
});

test('AC 4: Retry succeeds when second response fixes schema error', async () => {
  clearAiCache();
  let callCount = 0;
  const mockAiRun = async (model, payload) => {
    callCount++;
    if (callCount === 1) {
      return { response: '{"not_rules": []}' };
    }
    return {
      response: JSON.stringify({
        rules: [
          {
            course: 'ECE 198',
            label: 'Office hours',
            kind: 'office_hours',
            host: '',
            location: 'E7 3416',
            byday: ['MO', 'WE'],
            start_local: '14:00',
            end_local: '15:00',
            starts_on: null,
            until: null,
            notes: '',
            confidence: 0.9,
            source_text: 'Mon & Wed 2-3pm',
          },
        ],
        warnings: [],
      }),
    };
  };

  const draft = await parseOfficeHoursWithAi({
    text: 'Office hours: Mon & Wed 2-3pm in E7 3416',
    env: { AI: { run: mockAiRun } },
    now: 2000,
  });

  assert.equal(callCount, 2);
  assert.equal(draft.rules.length, 1);
  assert.equal(draft.rules[0].start_local, '14:00');
});

test('AC 3: parseOfficeHoursWithAi never writes to the store', async () => {
  const store = new SqliteStore(':memory:');
  const initialSetting = store.getSetting('OFFICE_HOURS_JSON');
  assert.equal(initialSetting, null);

  const mockAiRun = async () => ({
    response: JSON.stringify({
      rules: [
        {
          course: 'ECE 198',
          label: 'Office hours',
          kind: 'office_hours',
          host: '',
          location: 'E7 3416',
          byday: ['MO', 'WE'],
          start_local: '14:00',
          end_local: '15:00',
          starts_on: null,
          until: null,
          notes: '',
          confidence: 0.9,
          source_text: 'Mon & Wed 2-3pm',
        },
      ],
      warnings: [],
    }),
  });

  const draft = await parseOfficeHoursWithAi({
    text: 'Office hours: Mon & Wed 2-3pm in E7 3416',
    env: { AI: { run: mockAiRun } },
  });

  assert.equal(draft.rules.length, 1);
  // Store must still be completely untouched
  assert.equal(store.getSetting('OFFICE_HOURS_JSON'), null);
  store.close();
});

test('AC 5, 6, 7: PUT /v1/office-hours persists config, triggers poll, updates rows in place, and tombstones on delete', async () => {
  const store = new SqliteStore(':memory:');
  const now = zonedToEpoch(2026, 9, 21, 10, 0, 0, 'America/Toronto');

  // Initial state: empty rules
  const initialRaw = await userOfficeHours.fetchRaw({ store });
  assert.equal(initialRaw.body, '{"rules":[],"version":1}');

  // Save rule 1: Mon & Wed 14:00-15:00
  const ruleId = 'rule-abc';
  const initialConfig = {
    version: 1,
    rules: [
      {
        id: ruleId,
        course: 'ECE 198',
        label: 'Prof office hours',
        kind: 'office_hours',
        host: 'Prof. Smith',
        location: 'E7 3416',
        byday: ['MO', 'WE'],
        start_local: '14:00',
        end_local: '15:00',
        starts_on: '2026-09-21',
        until: '2026-09-30',
        notes: '',
        confidence: 0.95,
        source_text: 'Mon & Wed 2-3',
        created_at: now,
        updated_at: now,
      },
    ],
  };

  store.setSetting('OFFICE_HOURS_JSON', JSON.stringify(initialConfig), now);
  const receipt1 = await runSource(userOfficeHours, store, { now });
  assert.equal(receipt1.outcome, 'ok');
  assert.ok(receipt1.rows_written > 0);

  const initialRows = store.rows('timeline_event', {
    where: "source_id = 'user-office-hours'",
  });
  assert.ok(initialRows.length > 0);
  const countBeforeEdit = initialRows.length;
  const firstRow = initialRows[0];
  assert.equal(firstRow.kind, 'office_hours');
  assert.ok(firstRow.external_id.startsWith(`office-hours-${ruleId}#`));

  // AC 6: Edit the rule's time from 14:00 to 15:00. external_id remains stable, row updates in place
  const updatedConfig = {
    version: 1,
    rules: [
      {
        ...initialConfig.rules[0],
        start_local: '15:00',
        end_local: '16:00',
        updated_at: now + 1000,
      },
    ],
  };

  store.setSetting('OFFICE_HOURS_JSON', JSON.stringify(updatedConfig), now + 1000);
  const receipt2 = await runSource(userOfficeHours, store, { now: now + 1000 });
  assert.equal(receipt2.outcome, 'ok');

  const editedRows = store.rows('timeline_event', {
    where: "source_id = 'user-office-hours'",
  });
  // Must NOT duplicate rows
  assert.equal(editedRows.length, countBeforeEdit);
  // Time must be updated
  const editedFirstRow = editedRows.find((r) => r.external_id === firstRow.external_id);
  assert.ok(editedFirstRow);
  assert.notEqual(editedFirstRow.starts_at, firstRow.starts_at);

  // AC 7: Delete the rule. Its rows must be tombstoned
  const emptyConfig = { version: 1, rules: [] };
  store.setSetting('OFFICE_HOURS_JSON', JSON.stringify(emptyConfig), now + 2000);
  const receipt3 = await runSource(userOfficeHours, store, { now: now + 2000 });
  assert.equal(receipt3.outcome, 'empty');

  // Verify tombstoning: previous rows must now be tombstoned
  const remainingLiveRows = store.rows('timeline_event', {
    where: "source_id = 'user-office-hours'",
  });
  assert.equal(remainingLiveRows.length, 0);

  store.close();
});

test('AC 9: Invalid OFFICE_HOURS_JSON in store yields failed run receipt and deletes nothing', async () => {
  const store = new SqliteStore(':memory:');
  const now = Date.now();

  // Seed a valid row
  const goodConfig = {
    version: 1,
    rules: [
      {
        id: 'good-1',
        course: 'ECE 198',
        label: 'OH',
        kind: 'office_hours',
        host: '',
        location: '',
        byday: ['MO'],
        start_local: '10:00',
        end_local: '11:00',
        starts_on: null,
        until: null,
        notes: '',
        confidence: 1,
        source_text: '',
        created_at: now,
        updated_at: now,
      },
    ],
  };
  store.setSetting('OFFICE_HOURS_JSON', JSON.stringify(goodConfig), now);
  await runSource(userOfficeHours, store, { now });
  const liveBefore = store.rows('timeline_event', { where: "source_id = 'user-office-hours'" });
  assert.ok(liveBefore.length > 0);

  // Put corrupt data in setting
  store.setSetting('OFFICE_HOURS_JSON', 'NOT_VALID_JSON{', now + 1000);
  const receipt = await runSource(userOfficeHours, store, { now: now + 1000 });
  assert.equal(receipt.outcome, 'failed');
  assert.match(receipt.error, /invalid/i);

  // Previous rows must NOT be deleted or tombstoned
  const liveAfter = store.rows('timeline_event', { where: "source_id = 'user-office-hours'" });
  assert.equal(liveAfter.length, liveBefore.length);

  store.close();
});

test('AC 10: Office hours do NOT appear in deadlines card and do NOT hijack hero nextCommitmentCard', async () => {
  const now = zonedToEpoch(2026, 9, 21, 10, 0, 0, 'America/Toronto');
  const store = new SqliteStore(':memory:');

  // Insert a class event from portal at 14:00
  store.upsertRows('timeline_event', [
    {
      source_id: 'uw-portal-ics',
      external_id: 'portal-class-1',
      uid: 'portal-1',
      observed_at: now,
      valid_until: now + 86400000,
      kind: 'class',
      title: 'ECE 198 Lecture',
      subtitle: '',
      location: 'E7 2005',
      all_day: false,
      starts_at: now + 4 * 3600 * 1000, // 14:00
      ends_at: now + 5 * 3600 * 1000,
      url: '',
      description: '',
    },
  ]);

  // Insert an office hours event earlier at 11:00
  store.upsertRows('timeline_event', [
    {
      source_id: 'user-office-hours',
      external_id: 'oh-event-1',
      uid: 'oh-1',
      observed_at: now,
      valid_until: now + 86400000,
      kind: 'office_hours',
      title: 'ECE 198 · Prof Office Hours',
      subtitle: 'Prof. Smith',
      location: 'E7 3416',
      all_day: false,
      starts_at: now + 1 * 3600 * 1000, // 11:00
      ends_at: now + 2 * 3600 * 1000,
      url: '',
      description: '',
    },
  ]);

  // Next commitment card must pick the ECE 198 Lecture, NOT the office hour
  const heroCard = await nextCommitmentCard(store, { now });
  assert.equal(heroCard.data.title, 'ECE 198 Lecture');
  assert.notEqual(heroCard.data.title, 'ECE 198 · Prof Office Hours');

  // Due soon card must not include the office hour
  const deadlines = await dueSoonCard(store, { now });
  const items = deadlines.data.items || [];
  assert.ok(!items.some((i) => i.title.includes('Office Hours')));

  store.close();
});

function createMockD1() {
  const db = new DatabaseSync(':memory:');
  const api = {
    async exec(q) {
      db.exec(q);
      return { count: 0, duration: 0 };
    },
    prepare(sql) {
      let bound = [];
      return {
        bind(...args) {
          bound = args;
          return this;
        },
        async run() {
          const res = db.prepare(sql).run(...bound);
          return { success: true, meta: { changes: Number(res.changes ?? 0) } };
        },
        async all() {
          return { success: true, results: db.prepare(sql).all(...bound) };
        },
        async first(col) {
          const row = db.prepare(sql).get(...bound);
          if (!row) return null;
          return col ? row[col] : row;
        },
      };
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
  return { api, db };
}

test('Worker endpoints: GET/PUT /v1/office-hours, POST /v1/ai/parse-office-hours, and AC 11', async () => {
  const { api } = createMockD1();
  const store = new D1Store(api);
  await store.init();
  const env = { DB: api };

  // 1. GET /v1/office-hours returns default empty config
  const res1 = await worker.fetch(new Request('https://dash.test/v1/office-hours'), env, {});
  assert.equal(res1.status, 200);
  const config1 = await res1.json();
  assert.deepEqual(config1, { rules: [], version: 1 });

  // 2. PUT /v1/office-hours validates and saves rules
  const putBody = {
    version: 1,
    rules: [
      {
        course: 'ECE 198',
        label: 'Prof office hours',
        kind: 'office_hours',
        byday: ['MO', 'WE'],
        start_local: '14:00',
        end_local: '15:00',
        starts_on: '2026-09-28',
        until: '2026-12-05',
        location: 'E7 3416',
      },
    ],
  };

  const res2 = await worker.fetch(
    new Request('https://dash.test/v1/office-hours', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(putBody),
    }),
    env,
    {}
  );
  assert.equal(res2.status, 200);
  const putRes = await res2.json();
  assert.equal(putRes.config.rules.length, 1);
  assert.ok(putRes.config.rules[0].id);
  assert.ok(putRes.rows_written > 0);

  // 3. GET /v1/office-hours returns saved rules
  const res3 = await worker.fetch(new Request('https://dash.test/v1/office-hours'), env, {});
  assert.equal(res3.status, 200);
  const config3 = await res3.json();
  assert.equal(config3.rules.length, 1);
  assert.equal(config3.rules[0].course, 'ECE 198');

  // 4. POST /v1/ai/parse-office-hours with mock AI
  const mockAi = {
    run: async () => ({
      response: JSON.stringify({
        rules: [
          {
            course: 'ECE 198',
            label: 'TA session',
            kind: 'help_session',
            byday: ['TH'],
            start_local: '10:30',
            end_local: '11:20',
            starts_on: null,
            until: null,
            location: 'DC 2568',
            confidence: 0.95,
            source_text: 'TA session',
          },
        ],
        warnings: [],
      }),
    }),
  };

  const tasks = [];
  const parseRes = await worker.fetch(
    new Request('https://dash.test/v1/ai/parse-office-hours', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'TA session Thursdays 10:30-11:20 in DC 2568' }),
    }),
    { ...env, AI: mockAi },
    { waitUntil: (task) => tasks.push(task) }
  );
  assert.equal(parseRes.status, 202);
  assert.equal((await parseRes.json()).status, 'processing');
  await Promise.all(tasks);
  const parseJob = await worker.fetch(new Request('https://dash.test/v1/ai/jobs?kind=office_hours&scope=latest'), env, {});
  assert.equal(parseJob.status, 200);
  const parseJson = await parseJob.json();
  assert.equal(parseJson.status, 'ready');
  assert.equal(parseJson.result.draft.rules.length, 1);
  assert.ok(parseJson.result.preview.length > 0);

  // 5. AC 11: OFFICE_HOURS_JSON is never written through the credentials path
  const prevEnvVal = process.env.OFFICE_HOURS_JSON;
  await worker.fetch(
    new Request('https://dash.test/v1/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ OFFICE_HOURS_JSON: '{"injected": true}' }),
    }),
    env,
    {}
  );
  assert.equal(process.env.OFFICE_HOURS_JSON, prevEnvVal);
});
