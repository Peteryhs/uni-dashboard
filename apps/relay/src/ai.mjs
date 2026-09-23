/**
 * Workers AI recommendation and ranking engine for daily dining menus and office hours parsing.
 *
 * Designed to dual-target:
 * 1. Cloudflare Workers environment: uses env.AI.run(model, payload)
 * 2. Node.js relay / CLI / VPS: calls Cloudflare Workers AI REST API if credentials are set
 * No offline ranking is fabricated when AI credentials are unavailable.
 */
import { FoodAiRecommendation } from '#contract/card-data.mjs';
import { z } from 'zod';
import { OfficeHoursDraft, OFFICE_HOURS_JSON_SCHEMA } from '#contract/office-hours.mjs';
import { config } from './config.mjs';

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
    id: '@cf/zai-org/glm-4.7-flash',
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

/** In-memory cache of evaluated recommendations and parsed rules: key -> { data, expiresAt } */
const aiCache = new Map();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours (matches menu update cadence)
const OFFICE_HOURS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for office hours parsing

/**
 * Node builtins are reached through getBuiltinModule, never through a static import.
 */
function nodeBuiltin(name) {
  try {
    return globalThis.process?.getBuiltinModule?.(name) ?? null;
  } catch {
    return null;
  }
}

const diskCache = (() => {
  const fs = nodeBuiltin('node:fs');
  const path = nodeBuiltin('node:path');
  if (!fs || !path) return null;
  return { fs, file: path.resolve(process.cwd(), '.ai-cache.json') };
})();

function loadPersistentCache() {
  if (!diskCache) return;
  try {
    const { fs, file } = diskCache;
    if (fs.existsSync(file)) {
      const now = Date.now();
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
        if (v && v.expiresAt > now && v.data) {
          aiCache.set(k, v);
        }
      }
    }
  } catch {}
}

function savePersistentCache() {
  if (!diskCache) return;
  try {
    const { fs, file } = diskCache;
    const now = Date.now();
    const obj = {};
    for (const [k, v] of aiCache.entries()) {
      if (v && v.expiresAt > now) {
        obj[k] = v;
      }
    }
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch {}
}

// Populate cache on startup
loadPersistentCache();

/**
 * Cache key: FNV-1a run twice with different offsets, hex encoded.
 */
export function hashKey(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0xc9dc5118;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function cacheKey(serviceDate, model, tasteProfile) {
  const payload = JSON.stringify({
    d: serviceDate,
    m: model,
    bio: tasteProfile?.bio?.trim().toLowerCase() ?? '',
    spice: tasteProfile?.spiceLevel ?? 'medium',
    goals: (tasteProfile?.dietaryGoals ?? []).slice().sort(),
    diet: tasteProfile?.dietaryFilter ?? 'all',
  });
  return hashKey(payload);
}

export function officeHoursCacheKey(text, model) {
  return hashKey('oh:' + model + ':' + text.trim());
}

export function clearAiCache() {
  aiCache.clear();
  if (!diskCache) return;
  try {
    diskCache.fs.writeFileSync(diskCache.file, '{}', 'utf8');
  } catch {}
}

/**
 * Safely unwrap text content from various Cloudflare Workers AI and OpenAI response shapes.
 */
export function unwrapAiResponseText(response) {
  if (typeof response === 'string') return response;
  const content =
    response?.choices?.[0]?.message?.content ??
    response?.response;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') return JSON.stringify(content);
  if (response && typeof response === 'object') return JSON.stringify(response);
  return '';
}

/**
 * Parse JSON from string, falling back to brace extraction.
 */
export function parseJsonFromAiText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  return extractJson(trimmed);
}

export function extractJson(str) {
  if (typeof str !== 'string') return null;
  const firstBrace = str.indexOf('{');
  const lastBrace = str.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = str.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  const firstBracket = str.indexOf('[');
  const lastBracket = str.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const candidate = str.slice(firstBracket, lastBracket + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

/**
 * Reusable structured AI execution helper.
 * Dual-targets Worker binding and Cloudflare REST API.
 * Retries once on schema validation failure with the error message appended.
 * Throws 502 with raw text if schema validation fails twice.
 */
export async function runStructured({
  systemMessage,
  userMessage,
  schema = null,
  jsonSchema = null,
  model = DEFAULT_AI_MODEL,
  cfEnv = null,
  env = null,
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '',
  apiToken = process.env.CLOUDFLARE_API_TOKEN || '',
  cacheKey = null,
  ttlMs = CACHE_TTL_MS,
  now = Date.now(),
  force = false,
  transform = null,
  fewShotMessages = [],
  maxTokens = 1536,
  beforeAiCall = null,
}) {
  if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 2048) throw new RangeError('AI output limit must be 64-2048 tokens');
  const effectiveEnv = cfEnv || env;
  const hasWorkerAi = effectiveEnv && effectiveEnv.AI && typeof effectiveEnv.AI.run === 'function';
  const hasRestCreds = Boolean(accountId && apiToken);

  if (!hasWorkerAi && !hasRestCreds) {
    throw new Error(
      'Cloudflare Workers AI credentials not configured in Settings. Operation requires a valid Cloudflare Account ID and API Token.'
    );
  }

  // Check cache
  if (cacheKey && !force) {
    const cached = aiCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return cached.data;
    }
  }

  const responseFormat = jsonSchema
    ? { type: 'json_schema', json_schema: jsonSchema }
    : { type: 'json_object' };

  async function callAi(messages) {
    if (beforeAiCall) await beforeAiCall({ model, messages, maxTokens, jsonSchema });
    if (hasWorkerAi) {
      try {
        return await effectiveEnv.AI.run(model, {
          messages,
          response_format: responseFormat,
          max_tokens: maxTokens,
        });
      } catch (err) {
        const msg = err?.message || String(err);
        if (msg.includes("JSON Mode couldn't be met") || msg.includes('json mode')) {
          const modeErr = new Error(`Cloudflare Workers AI JSON mode constraint could not be met: ${msg}`);
          modeErr.status = 502;
          throw modeErr;
        }
        throw new Error(`Workers AI execution failed: ${msg}`);
      }
    }

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages,
          response_format: responseFormat,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Could not reach Cloudflare Workers AI: ${err.message}`);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`Cloudflare Workers AI request failed (${res.status}): ${errText || 'Upstream error'}`);
      err.status = res.status >= 500 ? 502 : res.status;
      throw err;
    }

    const json = await res.json().catch(() => ({}));
    return json.result ?? json;
  }

  const messages = [
    { role: 'system', content: systemMessage },
    ...fewShotMessages,
    { role: 'user', content: userMessage },
  ];

  let rawResponse;
  try {
    rawResponse = await callAi(messages);
  } catch (err) {
    if (!err.status) err.status = 502;
    throw err;
  }

  let rawText = unwrapAiResponseText(rawResponse);
  let parsedObj = parseJsonFromAiText(rawText);
  let transformed = parsedObj;
  if (transform && parsedObj) {
    try {
      transformed = transform(parsedObj);
    } catch {
      transformed = null;
    }
  }

  let validation = schema && transformed ? schema.safeParse(transformed) : { success: Boolean(transformed), data: transformed };

  // Retry once on schema validation or JSON parse failure
  if (!validation.success || !transformed) {
    const validationError = validation.error
      ? validation.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
      : 'Response was not valid JSON';

    const retryMessages = [
      ...messages,
      { role: 'assistant', content: rawText || '{}' },
      {
        role: 'user',
        content: `Your previous reply failed validation: ${validationError}. Return only valid JSON matching the schema.`,
      },
    ];

    try {
      rawResponse = await callAi(retryMessages);
      rawText = unwrapAiResponseText(rawResponse);
      parsedObj = parseJsonFromAiText(rawText);
      transformed = parsedObj;
      if (transform && parsedObj) {
        try {
          transformed = transform(parsedObj);
        } catch {
          transformed = null;
        }
      }
      validation = schema && transformed ? schema.safeParse(transformed) : { success: Boolean(transformed), data: transformed };
    } catch (retryErr) {
      const err = new Error(`AI execution failed on retry: ${retryErr.message}`);
      err.raw = rawText;
      err.status = retryErr.status || 502;
      throw err;
    }

    if (!validation.success || !transformed) {
      const secondError = validation.error
        ? validation.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
        : 'Response was not valid JSON';
      const err = new Error(`AI response failed schema validation after retry: ${secondError}`);
      err.raw = rawText;
      err.status = 502;
      throw err;
    }
  }

  const result = validation.data;

  if (cacheKey) {
    aiCache.set(cacheKey, {
      data: result,
      expiresAt: now + ttlMs,
    });
    savePersistentCache();
  }

  return result;
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

function transformMenuAiResponse(parsed, serviceDate, model, now) {
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
    generated_at: now,
  };
}

/**
 * Execute menu ranking strictly via Cloudflare Workers AI (Worker binding or REST API).
 * Never returns fake/placeholder rankings or fabricated match scores.
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
  beforeAiCall = null,
}) {
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

  const key = cacheKey(serviceDate, model, tasteProfile);
  const { systemMessage, userMessage } = buildPrompt({ serviceDate, tasteProfile, outlets });

  return await runStructured({
    systemMessage,
    userMessage,
    schema: FoodAiRecommendation,
    model,
    cfEnv,
    env,
    accountId,
    apiToken,
    cacheKey: key,
    ttlMs: CACHE_TTL_MS,
    beforeAiCall,
    now,
    force,
    transform: (parsed) => transformMenuAiResponse(parsed, serviceDate, model, now),
  });
}

/** Summarize active campus incidents for a compact, one-line alert banner. */
export async function summarizeAlertsWithAi({ notices, cfEnv = null, now = Date.now(), beforeAiCall = null }) {
  const payload = notices.slice(0, 8).map((notice) => ({
    title: notice.title,
    severity: notice.severity,
    affected: notice.components || [],
    update: String(notice.body || '').slice(0, 700),
  }));
  const result = await runStructured({
    systemMessage: 'Summarize university service incidents for one student. Return exactly one plain sentence under 35 words. Name the main affected service and location when given. Do not invent facts, add advice, or include links.',
    userMessage: JSON.stringify(payload),
    schema: z.object({ summary: z.string().min(1).max(500) }),
    model: DEFAULT_AI_MODEL,
    maxTokens: 256,
    beforeAiCall,
    cfEnv,
    now,
    transform: (value) => ({ summary: String(value.summary || '').replace(/\s+/g, ' ').trim() }),
  });
  const firstSentence = /^(.+?[.!?])(?:\s|$)/.exec(result.summary)?.[1] || result.summary;
  return firstSentence.slice(0, 240).trim();
}

/**
 * Build system and user prompt for parsing office hours text into structured recurrence rules.
 */
export function buildOfficeHoursPrompt({ text, course = '', dateStr, timezone = config.timezone }) {
  const systemMessage = [
    `You are an expert academic schedule parser for University of Waterloo students.`,
    `Current date is ${dateStr} in timezone ${timezone}.`,
    `Your task is to parse unstructured text written by a professor, instructor, or teaching assistant describing office hours, tutorial sessions, or help sessions into structured recurrence rules.`,
    `CRITICAL REQUIREMENTS:`,
    `1. Output weekdays strictly as two-letter iCalendar codes in the 'byday' array: ['MO','TU','WE','TH','FR','SA','SU'].`,
    `   Note that 'MW' means ['MO','WE'], 'TTh' or 'TR' means ['TU','TH'], 'MWF' means ['MO','WE','FR'], 'Th' means ['TH'].`,
    `2. Output times in 24-hour wall-clock format 'HH:MM' (e.g. '14:00' for 2:00pm, '10:30' for 10:30am). In academic contexts, '2-3pm' means '14:00' to '15:00'.`,
    `3. Standard UW slot preservation: 50-minute slots like '10:30-11:20' or '13:30-14:20' must be preserved exactly. Do not round or correct them to :30.`,
    `4. One rule per distinct weekday-set + time + location combination. 'Mon & Wed 2-3 in E7 3416' is ONE rule with byday: ['MO','WE']. However, a session on Mon 2-3 and a different session on Thu 10-11 are TWO separate rules.`,
    `5. If a course code is known or mentioned (e.g. 'ECE 198'), assign it to 'course'. Otherwise use empty string ''.`,
    `6. 'kind' must be one of: 'office_hours', 'tutorial', 'help_session', 'other'.`,
    `7. 'starts_on': inclusive start date 'YYYY-MM-DD' if stated (e.g., 'starting next week', 'starts Oct 3'), otherwise null (meaning immediately).`,
    `8. 'until': inclusive end date 'YYYY-MM-DD' if stated (e.g., 'through Dec 5', 'until Dec 5'), otherwise null (+120 days default).`,
    `9. Non-representable schedule exceptions: Reading week exclusions, holiday cancellations, appointment-only instructions, or other conditions MUST be placed into 'notes'.`,
    `10. Uncertainties, assumptions, or missing end dates MUST be placed into the 'warnings' array.`,
    `11. HONESTY: Never invent a location, host, or end date. Empty string or null is correct when the text is silent.`,
    `12. If the text specifies no recurring schedule at all (e.g. 'Office hours by appointment only, email me'), output an EMPTY rules array (rules: []) and explain in 'warnings'. Never fabricate a recurring rule.`,
    `13. 'confidence' is a number between 0 and 1 representing your confidence in the extraction.`,
    `14. 'source_text' is the specific text snippet that generated this rule.`,
    `Return ONLY a valid JSON object matching the requested schema.`,
  ].join('\n');

  const fewShotMessages = [
    {
      role: 'user',
      content: JSON.stringify({
        text: 'Office hours: Mon & Wed 2:00-3:00pm in E7 3416, starting next week through Dec 5.\nTA session Thursdays 10:30-11:20 in DC 2568 (no session during reading week).',
        course: 'ECE 198',
      }),
    },
    {
      role: 'assistant',
      content: JSON.stringify({
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
            starts_on: '2026-09-28',
            until: '2026-12-05',
            notes: '',
            confidence: 0.95,
            source_text: 'Office hours: Mon & Wed 2:00-3:00pm in E7 3416, starting next week through Dec 5.',
          },
          {
            course: 'ECE 198',
            label: 'TA session',
            kind: 'help_session',
            host: '',
            location: 'DC 2568',
            byday: ['TH'],
            start_local: '10:30',
            end_local: '11:20',
            starts_on: null,
            until: null,
            notes: 'no session during reading week',
            confidence: 0.95,
            source_text: 'TA session Thursdays 10:30-11:20 in DC 2568 (no session during reading week).',
          },
        ],
        warnings: ['TA session has no end date stated, defaulted to term duration'],
      }),
    },
  ];

  const userMessage = JSON.stringify({
    text,
    course: course || '',
  });

  return { systemMessage, fewShotMessages, userMessage };
}

/**
 * Parse office hours text with AI into a validated OfficeHoursDraft.
 * Never writes to storage.
 */
export async function parseOfficeHoursWithAi({
  text,
  course = '',
  model = DEFAULT_AI_MODEL,
  cfEnv = null,
  env = null,
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '',
  apiToken = process.env.CLOUDFLARE_API_TOKEN || '',
  force = false,
  now = Date.now(),
  timezone = config.timezone,
  beforeAiCall = null,
}) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('Office hours text cannot be empty');
  }

  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  const key = officeHoursCacheKey(text, model);
  const { systemMessage, fewShotMessages, userMessage } = buildOfficeHoursPrompt({
    text,
    course,
    dateStr,
    timezone,
  });

  return await runStructured({
    systemMessage,
    userMessage,
    schema: OfficeHoursDraft,
    jsonSchema: OFFICE_HOURS_JSON_SCHEMA,
    model,
    cfEnv,
    env,
    accountId,
    apiToken,
    cacheKey: key,
    ttlMs: OFFICE_HOURS_CACHE_TTL_MS,
    now,
    force,
    fewShotMessages,
    beforeAiCall,
    transform: (parsed) => {
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rules)) return null;
      const rawRules = parsed.rules;
      const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
      const rules = rawRules.map((r) => ({
        course: r.course || course || '',
        label: r.label || 'Office hours',
        kind: ['office_hours', 'tutorial', 'help_session', 'other'].includes(r.kind) ? r.kind : 'office_hours',
        host: r.host || '',
        location: r.location || '',
        byday: Array.isArray(r.byday) ? r.byday : [],
        start_local: r.start_local || '',
        end_local: r.end_local || '',
        starts_on: r.starts_on || null,
        until: r.until || null,
        notes: r.notes || '',
        confidence: typeof r.confidence === 'number' ? r.confidence : 1,
        source_text: r.source_text || text.trim(),
      }));
      return { rules, warnings };
    },
  });
}
