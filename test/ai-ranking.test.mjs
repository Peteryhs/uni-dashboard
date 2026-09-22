import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupMenuByOutlet,
  buildPrompt,
  cacheKey,
  rankDailyMenu,
  clearAiCache,
  DEFAULT_AI_MODEL,
} from '../apps/relay/src/ai.mjs';

const SAMPLE_ROWS = [
  {
    outlet: "Mudie's - Residence Dining Hall",
    dish: 'Smokey BBQ Beans',
    diet: ['dairy'],
    station: '',
  },
  {
    outlet: "Mudie's - Residence Dining Hall",
    dish: 'Soy Chili Chicken Wings',
    diet: [],
    station: '',
  },
  {
    outlet: 'REVelation - Residence Dining Hall',
    dish: 'Jerk Chicken Drumsticks',
    diet: ['dairy'],
    station: '',
  },
  {
    outlet: 'REVelation - Residence Dining Hall',
    dish: 'Hunan Beef Stir Fry',
    diet: ['dairy'],
    station: '',
  },
];

test('groupMenuByOutlet groups menu items correctly', () => {
  const grouped = groupMenuByOutlet(SAMPLE_ROWS);
  assert.equal(grouped.length, 2);
  const rev = grouped.find((o) => o.outlet.includes('REVelation'));
  assert.ok(rev);
  assert.equal(rev.dishes.length, 2);
  assert.equal(rev.dishes[0].dish, 'Jerk Chicken Drumsticks');
});

test('buildPrompt formats prompt for compact token consumption', () => {
  const outlets = groupMenuByOutlet(SAMPLE_ROWS);
  const prompt = buildPrompt({
    serviceDate: '2026-09-21',
    tasteProfile: {
      bio: 'Spicy food and high protein',
      spiceLevel: 'hot',
      dietaryGoals: ['high-protein'],
    },
    outlets,
  });

  assert.ok(prompt.systemMessage.includes('JSON'));
  assert.ok(prompt.userMessage.includes('2026-09-21'));
  assert.ok(prompt.userMessage.includes('Jerk Chicken Drumsticks'));
});

test('cacheKey produces deterministic hashes regardless of whitespace or casing', () => {
  const k1 = cacheKey('2026-09-21', DEFAULT_AI_MODEL, {
    bio: ' Spicy Chicken ',
    spiceLevel: 'hot',
    dietaryGoals: ['high-protein', 'comfort'],
  });
  const k2 = cacheKey('2026-09-21', DEFAULT_AI_MODEL, {
    bio: 'spicy chicken',
    spiceLevel: 'hot',
    dietaryGoals: ['comfort', 'high-protein'],
  });
  assert.equal(k1, k2);

  const k3 = cacheKey('2026-09-22', DEFAULT_AI_MODEL, {
    bio: 'spicy chicken',
    spiceLevel: 'hot',
    dietaryGoals: ['comfort', 'high-protein'],
  });
  assert.notEqual(k1, k3);
});

test('rankDailyMenu throws explicit error when no credentials and no env.AI are present (zero fake data)', async () => {
  clearAiCache();
  await assert.rejects(
    async () => {
      await rankDailyMenu({
        menuItems: SAMPLE_ROWS,
        serviceDate: '2026-09-21',
        tasteProfile: { bio: 'Spicy noodles' },
        model: DEFAULT_AI_MODEL,
        accountId: '',
        apiToken: '',
        env: null,
      });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /credentials not configured/i);
      return true;
    },
    'must reject instead of generating fake placeholder rankings',
  );
});

test('rankDailyMenu returns parsed recommendation when env.AI is provided', async () => {
  clearAiCache();
  const mockAiRun = async () => ({
    response: JSON.stringify({
      headline: 'REVelation is your top match today.',
      top_outlet: 'REVelation - Residence Dining Hall',
      ranked_outlets: [
        {
          outlet: 'REVelation - Residence Dining Hall',
          rank: 1,
          match_score: 95,
          verdict: 'Great match for jerk chicken and beef stir fry.',
          highlights: [{ dish: 'Jerk Chicken Drumsticks', why: 'High protein spicy dish' }],
        },
        {
          outlet: "Mudie's - Residence Dining Hall",
          rank: 2,
          match_score: 75,
          verdict: 'Good variety.',
          highlights: [],
        },
      ],
      tip: 'Get there early.',
    }),
  });

  const res = await rankDailyMenu({
    menuItems: SAMPLE_ROWS,
    serviceDate: '2026-09-21',
    tasteProfile: { bio: 'Jerk chicken' },
    model: DEFAULT_AI_MODEL,
    env: { AI: { run: mockAiRun } },
    now: 1000,
  });

  assert.equal(res.top_outlet, 'REVelation - Residence Dining Hall');
  assert.equal(res.ranked_outlets.length, 2);
  assert.equal(res.ranked_outlets[0].match_score, 95);
  assert.equal(res.ranked_outlets[0].highlights[0].dish, 'Jerk Chicken Drumsticks');
});

test('rankDailyMenu handles OpenAI/Gemma 4 choices response format', async () => {
  clearAiCache();
  const mockAiRun = async () => ({
    choices: [
      {
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            headline: 'Gemma 4 selected Mudies for BBQ.',
            top_outlet: "Mudie's - Residence Dining Hall",
            ranked_outlets: [
              {
                outlet: "Mudie's - Residence Dining Hall",
                rank: 1,
                match_score: 92,
                verdict: 'Wings match student cravings perfectly.',
                highlights: [{ dish: 'Soy Chili Chicken Wings', why: 'Rich savory glaze' }],
              },
            ],
            tip: 'Enjoy the wings.',
          }),
        },
      },
    ],
  });

  const res = await rankDailyMenu({
    menuItems: SAMPLE_ROWS,
    serviceDate: '2026-09-21',
    tasteProfile: { bio: 'Wings' },
    model: DEFAULT_AI_MODEL,
    env: { AI: { run: mockAiRun } },
    now: 1500,
  });

  assert.equal(res.top_outlet, "Mudie's - Residence Dining Hall");
  assert.equal(res.ranked_outlets[0].match_score, 92);
  assert.equal(res.ranked_outlets[0].highlights[0].dish, 'Soy Chili Chicken Wings');
});

test('rankDailyMenu caches evaluation and returns identical payload', async () => {
  clearAiCache();
  let calls = 0;
  const mockAiRun = async () => {
    calls++;
    return {
      response: JSON.stringify({
        headline: 'REVelation is your top match today.',
        top_outlet: 'REVelation - Residence Dining Hall',
        ranked_outlets: [
          {
            outlet: 'REVelation - Residence Dining Hall',
            rank: 1,
            match_score: 95,
            verdict: 'Great match for jerk chicken.',
            highlights: [],
          },
        ],
        tip: '',
      }),
    };
  };

  const first = await rankDailyMenu({
    menuItems: SAMPLE_ROWS,
    serviceDate: '2026-09-21',
    tasteProfile: { bio: 'Noodle bowls' },
    model: DEFAULT_AI_MODEL,
    env: { AI: { run: mockAiRun } },
    now: 1000,
  });

  const second = await rankDailyMenu({
    menuItems: SAMPLE_ROWS,
    serviceDate: '2026-09-21',
    tasteProfile: { bio: 'Noodle bowls' },
    model: DEFAULT_AI_MODEL,
    env: { AI: { run: mockAiRun } },
    now: 2000,
  });

  assert.equal(calls, 1, 'second call should hit cache');
  assert.equal(first.generated_at, second.generated_at);
  assert.equal(first.top_outlet, second.top_outlet);

  const third = await rankDailyMenu({
    menuItems: SAMPLE_ROWS,
    serviceDate: '2026-09-21',
    tasteProfile: { bio: 'Noodle bowls' },
    model: DEFAULT_AI_MODEL,
    env: { AI: { run: mockAiRun } },
    force: true,
    now: 3000,
  });

  assert.equal(calls, 2, 'third call with force: true should bypass cache and call AI');
  assert.equal(third.generated_at, 3000);
});

test('rankDailyMenu handles empty menu rows gracefully without calling AI', async () => {
  const rec = await rankDailyMenu({
    menuItems: [],
    serviceDate: '2026-09-21',
    tasteProfile: {},
    model: DEFAULT_AI_MODEL,
  });

  assert.equal(rec.ranked_outlets.length, 0);
  assert.ok(rec.headline.includes('No menu items posted'));
});

test('rankDailyMenu clamps dish highlight why to 5 words max', async () => {
  clearAiCache();
  const mockAiRun = async () => ({
    response: JSON.stringify({
      headline: 'REVelation is top match.',
      top_outlet: 'REVelation - Residence Dining Hall',
      ranked_outlets: [
        {
          outlet: 'REVelation - Residence Dining Hall',
          rank: 1,
          match_score: 95,
          verdict: 'Great fit.',
          highlights: [
            {
              dish: 'Jerk Chicken Drumsticks',
              why: 'This is a very long sentence that exceeds five words by quite a lot',
            },
            {
              dish: 'Hunan Beef Stir Fry',
              why: 'Crispy spicy beef',
            },
          ],
        },
      ],
      tip: '',
    }),
  });

  const res = await rankDailyMenu({
    menuItems: SAMPLE_ROWS,
    serviceDate: '2026-09-21',
    tasteProfile: { bio: 'Meat' },
    model: DEFAULT_AI_MODEL,
    env: { AI: { run: mockAiRun } },
    now: 3000,
  });

  const h1 = res.ranked_outlets[0].highlights[0];
  const words1 = h1.why.split(/\s+/);
  assert.ok(words1.length <= 5, `Expected <= 5 words, got ${words1.length}: "${h1.why}"`);
  assert.equal(h1.why, 'This is a very long');

  const h2 = res.ranked_outlets[0].highlights[1];
  assert.equal(h2.why, 'Crispy spicy beef');
});

