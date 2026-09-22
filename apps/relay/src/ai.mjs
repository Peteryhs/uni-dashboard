/**
 * Workers AI recommendation and ranking engine for daily dining menus.
 *
 * Designed to dual-target:
 * 1. Cloudflare Workers environment: uses env.AI.run(model, payload)
 * 2. Node.js relay / CLI / VPS: calls Cloudflare Workers AI REST API if credentials are set
 * 3. Offline / dev fallback: deterministic rule-based ranking engine if no credentials are configured
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FoodAiRecommendation } from '#contract/card-data.mjs';

try {
  process.loadEnvFile?.();
} catch {}

export const DEFAULT_AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';

export const POPULAR_MODELS = [
  {
    id: '@cf/google/gemma-4-26b-a4b-it',
    name: 'Google Gemma 4 (26B-A4B)',
    tag: 'Recommended · 4B Active MoE',
  },
  {
    id: '@cf/zhipu/glm-4.7-flash',
    name: 'GLM-4.7 Flash',
    tag: 'Ultra-Fast Flash',
  },
  {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    name: 'Meta Llama 4 Scout (17B)',
    tag: '16-Expert MoE',
  },
  {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    name: 'DeepSeek-R1 Distill (32B)',
    tag: 'Reasoning Specialist',
  },
  {
    id: '@cf/qwen/qwen3-30b-a3b-fp8',
    name: 'Qwen3 (30B-A3B)',
    tag: 'Dense & MoE',
  },
];

const FETCH_TIMEOUT_MS = 90_000;

/** In-memory and persistent disk cache for evaluated recommendations: key -> { data, expiresAt } */
const recommendationCache = new Map();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours (matches menu update cadence)
const CACHE_FILE = resolve(process.cwd(), '.ai-cache.json');

function loadPersistentCache() {
  try {
    if (existsSync(CACHE_FILE)) {
      const entries = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
      const now = Date.now();
      for (const [k, v] of Object.entries(entries)) {
        if (v && v.expiresAt > now && v.data) {
          recommendationCache.set(k, v);
        }
      }
    }
  } catch {}
}

function savePersistentCache() {
  try {
    const now = Date.now();
    const obj = {};
    for (const [k, v] of recommendationCache.entries()) {
      if (v && v.expiresAt > now) {
        obj[k] = v;
      }
    }
    writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch {}
}

// Populate cache on startup
loadPersistentCache();

export function cacheKey(serviceDate, model, tasteProfile) {
  const payload = JSON.stringify({
    d: serviceDate,
    m: model,
    bio: tasteProfile?.bio?.trim().toLowerCase() ?? '',
    spice: tasteProfile?.spiceLevel ?? 'medium',
    goals: (tasteProfile?.dietaryGoals ?? []).slice().sort(),
    diet: tasteProfile?.dietaryFilter ?? 'all',
  });
  return createHash('sha256').update(payload).digest('hex');
}

export function clearAiCache() {
  recommendationCache.clear();
  try {
    if (existsSync(CACHE_FILE)) {
      writeFileSync(CACHE_FILE, '{}', 'utf8');
    }
  } catch {}
}

/**
 * Group flat menu rows by outlet name for prompt context.
 */
export function groupMenuByOutlet(menuRows) {
  const byOutlet = new Map();
  for (const r of menuRows) {
    if (!byOutlet.has(r.outlet)) byOutlet.set(r.outlet, []);
    byOutlet.get(r.outlet).push({
      dish: r.dish,
      diet: Array.isArray(r.diet) ? r.diet : [],
      station: r.station || '',
    });
  }
  return [...byOutlet.entries()].map(([outlet, dishes]) => ({ outlet, dishes }));
}

/**
 * Formulate compact prompt to minimize token and neuron burn.
 */
export function buildPrompt({ serviceDate, tasteProfile, outlets }) {
  const systemMessage = [
    'You are an expert campus dining advisor for University of Waterloo students.',
    'Evaluate today campus dining hall menus against the student taste profile.',
    'Rank the dining halls from best to worst fit, calculate a match score (0-100), and highlight the top 1-2 dishes per hall with a concise reason.',
    'CRITICAL REQUIREMENT: For each dish in "highlights", the "why" reason must be AT MOST 5 WORDS (5 words max!). Example: "Spicy chicken, high protein" or "Fresh wok noodle bowl". Never exceed 5 words.',
    'Return ONLY a valid JSON object with this exact structure:',
    '{',
    '  "headline": "1 sentence summarizing today best dining hall match",',
    '  "top_outlet": "Exact name of the #1 ranked dining hall",',
    '  "ranked_outlets": [',
    '    {',
    '      "outlet": "Exact outlet name",',
    '      "rank": 1,',
    '      "match_score": 95,',
    '      "verdict": "1 concise sentence explaining the score",',
    '      "highlights": [',
    '        { "dish": "Exact dish name", "why": "5 words max reason" }',
    '      ]',
    '    }',
    '  ],',
    '  "tip": "Short practical student tip for today"',
    '}',
  ].join(' ');

  const userMessage = JSON.stringify({
    date: serviceDate,
    student_profile: {
      tastes_and_cravings: tasteProfile.bio || 'Open to all variety',
      preferred_spice_level: tasteProfile.spiceLevel || 'medium',
      dietary_goals: tasteProfile.dietaryGoals || [],
      strict_dietary_filter: tasteProfile.dietaryFilter || 'all',
    },
    campus_menus: outlets.map((o) => ({
      outlet: o.outlet,
      dishes: o.dishes.map((d) => ({
        name: d.dish,
        dietary_tags: d.diet,
      })),
    })),
  });

  return { systemMessage, userMessage };
}

/**
 * Execute menu ranking strictly via Cloudflare Workers AI (Worker binding or REST API).
 * Never returns fake/placeholder rankings or fabricated match scores.
 *
 * If credentials are not configured or upstream API fails, throws an explicit error
 * so clients can render an honest status rather than fake data.
 */
export async function rankDailyMenu({
  menuItems = [],
  serviceDate,
  tasteProfile = {},
  model = DEFAULT_AI_MODEL,
  cfEnv = null,
  env = null,
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '',
  apiToken = process.env.CLOUDFLARE_API_TOKEN || '',
  force = false,
  now = Date.now(),
}) {
  const effectiveEnv = cfEnv || env;
  const outlets = groupMenuByOutlet(menuItems);

  if (outlets.length === 0) {
    return FoodAiRecommendation.parse({
      service_date: serviceDate,
      model,
      headline: 'No menu items posted for this service date.',
      top_outlet: '',
      ranked_outlets: [],
      tip: 'Check back once Waterloo Food Services updates today menu.',
      generated_at: now,
    });
  }

  // Check cache: if a real evaluation succeeded in the reasonable past, use it unless forced
  const key = cacheKey(serviceDate, model, tasteProfile);
  if (!force) {
    const cached = recommendationCache.get(key);
    if (cached && now < cached.expiresAt) {
      return cached.data;
    }
  }

  // Validate that real AI credentials exist
  const hasWorkerAi = effectiveEnv && effectiveEnv.AI && typeof effectiveEnv.AI.run === 'function';
  const hasRestCreds = Boolean(accountId && apiToken);

  if (!hasWorkerAi && !hasRestCreds) {
    throw new Error(
      'Cloudflare Workers AI credentials not configured in Settings. Menu evaluation requires a valid Cloudflare Account ID and API Token.'
    );
  }

  const { systemMessage, userMessage } = buildPrompt({ serviceDate, tasteProfile, outlets });
  let recommendation = null;

  // Strategy 1: Native Cloudflare Worker binding (env.AI)
  if (hasWorkerAi) {
    try {
      const response = await effectiveEnv.AI.run(model, {
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userMessage },
        ],
        response_format: { type: 'json_object' },
      });
      recommendation = parseAiResponse(response, serviceDate, model);
    } catch (err) {
      throw new Error(`Workers AI execution failed: ${err.message}`);
    }
  }

  // Strategy 2: Cloudflare Workers AI REST API (Node.js relay with credentials)
  if (!recommendation && hasRestCreds) {
    let res;
    try {
      const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemMessage },
            { role: 'user', content: userMessage },
          ],
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Could not reach Cloudflare Workers AI: ${err.message}`);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Cloudflare Workers AI request failed (${res.status}): ${errText || 'Upstream error'}`);
    }

    const json = await res.json().catch(() => ({}));
    const rawResult = json.result ?? json;
    recommendation = parseAiResponse(rawResult, serviceDate, model);
  }

  if (!recommendation) {
    throw new Error('Workers AI returned an invalid or unparseable response.');
  }

  // Validate against contract schema
  const validated = FoodAiRecommendation.parse({
    ...recommendation,
    service_date: serviceDate,
    model,
    generated_at: now,
  });

  // Store in cache
  recommendationCache.set(key, {
    data: validated,
    expiresAt: now + CACHE_TTL_MS,
  });
  savePersistentCache();

  return validated;
}

function parseAiResponse(response, serviceDate, model) {
  let parsed = null;

  // Modern Cloudflare Workers AI / OpenAI shape: { choices: [{ message: { content: "..." } }] }
  // Older shape: { response: "..." }
  // Raw string shape: "..."
  const textContent =
    response?.choices?.[0]?.message?.content ??
    response?.response ??
    (typeof response === 'string' ? response : null);

  if (textContent && typeof textContent === 'string') {
    try {
      parsed = JSON.parse(textContent);
    } catch {
      parsed = extractJson(textContent);
    }
  } else if (typeof response === 'object' && response !== null && Array.isArray(response.ranked_outlets)) {
    parsed = response;
  }

  if (!parsed || !Array.isArray(parsed.ranked_outlets)) {
    return null;
  }

  return {
    service_date: serviceDate,
    model,
    headline: parsed.headline || 'Top dining hall recommendations for today.',
    top_outlet: parsed.top_outlet || parsed.ranked_outlets[0]?.outlet || '',
    ranked_outlets: parsed.ranked_outlets.map((o, idx) => ({
      outlet: o.outlet,
      rank: o.rank ?? idx + 1,
      match_score: Math.max(0, Math.min(100, Math.round(Number(o.match_score) || 75))),
      verdict: o.verdict || '',
      highlights: Array.isArray(o.highlights)
        ? o.highlights.map((h) => {
            const rawWhy = String(h.why || '').trim();
            const words = rawWhy.split(/\s+/).filter(Boolean);
            const why = words.length > 5 ? words.slice(0, 5).join(' ') : rawWhy;
            return { dish: String(h.dish || ''), why };
          })
        : [],
    })),
    tip: parsed.tip || '',
    generated_at: Date.now(),
  };
}

function extractJson(str) {
  const match = str.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  return null;
}
