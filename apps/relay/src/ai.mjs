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
import { registerDynamicRates } from './ai-budget.mjs';

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
    id: '@cf/ibm-granite/granite-4.0-h-micro',
    name: 'IBM Granite 4.0 Micro',
    tag: 'Cheapest Free · $0.02/M',
  },
  {
    id: '@cf/meta/llama-3.2-1b-instruct',
    name: 'Meta Llama 3.2 (1B)',
    tag: 'Ultra-Lightweight · $0.03/M',
  },
  {
    id: '@cf/meta/llama-3.2-3b-instruct',
    name: 'Meta Llama 3.2 (3B)',
    tag: 'Fast & Cheap · $0.05/M',
  },
  {
    id: '@cf/qwen/qwen3-30b-a3b-fp8',
    name: 'Qwen3 (30B-A3B)',
    tag: 'Dense & MoE · $0.05/M',
  },
  {
    id: '@cf/meta/llama-3.1-8b-instruct-fp8',
    name: 'Meta Llama 3.1 (8B)',
    tag: 'Standard 8B · Free Tier',
  },
  {
    id: '@cf/zai-org/glm-4.7-flash',
    name: 'GLM-4.7 Flash',
    tag: 'Ultra-Fast Flash · $0.06/M',
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
];

export const CURATED_MODEL_METADATA = {
  '@cf/google/gemma-4-26b-a4b-it': {
    name: 'Google Gemma 4 (26B-A4B)',
    tag: 'Recommended · 4B Active MoE',
  },
  '@cf/ibm-granite/granite-4.0-h-micro': {
    name: 'IBM Granite 4.0 Micro',
    tag: 'Cheapest Free · $0.02/M',
  },
  '@cf/meta/llama-3.2-1b-instruct': {
    name: 'Meta Llama 3.2 (1B)',
    tag: 'Ultra-Lightweight · $0.03/M',
  },
  '@cf/meta/llama-3.2-3b-instruct': {
    name: 'Meta Llama 3.2 (3B)',
    tag: 'Fast & Cheap · $0.05/M',
  },
  '@cf/qwen/qwen3-30b-a3b-fp8': {
    name: 'Qwen3 (30B-A3B)',
    tag: 'Dense & MoE · $0.05/M',
  },
  '@cf/meta/llama-3.1-8b-instruct-fp8': {
    name: 'Meta Llama 3.1 (8B)',
    tag: 'Standard 8B · Free Tier',
  },
  '@cf/zai-org/glm-4.7-flash': {
    name: 'GLM-4.7 Flash',
    tag: 'Ultra-Fast Flash · $0.06/M',
  },
  '@cf/openai/gpt-oss-20b': {
    name: 'OpenAI GPT-OSS (20B)',
    tag: 'Open-Weight Reasoning',
  },
  '@cf/meta/llama-4-scout-17b-16e-instruct': {
    name: 'Meta Llama 4 Scout (17B)',
    tag: '16-Expert MoE',
  },
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': {
    name: 'DeepSeek-R1 Distill (32B)',
    tag: 'Reasoning Specialist',
  },
};

export function formatModelDisplayName(id) {
  if (CURATED_MODEL_METADATA[id]?.name) return CURATED_MODEL_METADATA[id].name;
  const clean = id.replace(/^@cf\//, '');
  const [vendor, slug] = clean.includes('/') ? clean.split('/') : ['', clean];

  const vendorMap = {
    'ibm-granite': 'IBM Granite',
    'meta': 'Meta',
    'google': 'Google',
    'zai-org': 'Z.ai',
    'qwen': 'Qwen',
    'openai': 'OpenAI',
    'mistralai': 'Mistral',
    'mistral': 'Mistral',
    'deepseek-ai': 'DeepSeek',
    'nvidia': 'NVIDIA',
    'aisingapore': 'AI Singapore',
  };

  const v = vendorMap[vendor] || (vendor ? vendor.charAt(0).toUpperCase() + vendor.slice(1) : '');
  const s = slug
    .replace(/-/g, ' ')
    .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
    .replace(/Fp8/g, 'FP8')
    .replace(/It\b/g, 'Instruct');

  return v ? `${v} ${s}` : s;
}

export function buildModelTag(id, inputPrice) {
  if (CURATED_MODEL_METADATA[id]?.tag) return CURATED_MODEL_METADATA[id].tag;
  if (inputPrice !== null && Number.isFinite(inputPrice)) {
    return `Free Tier · $${inputPrice.toFixed(2)}/M tokens`;
  }
  return 'Free Tier';
}

let cachedDiscoveredModels = null;
let modelsCacheExpiresAt = 0;
const MODELS_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export async function getAvailableAiModels({
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '',
  apiToken = process.env.CLOUDFLARE_API_TOKEN || '',
  force = false,
  now = Date.now(),
} = {}) {
  if (!force && cachedDiscoveredModels && now < modelsCacheExpiresAt) {
    return cachedDiscoveredModels;
  }

  const diskKey = 'cf_discovered_models';
  if (!force && aiCache.has(diskKey)) {
    const entry = aiCache.get(diskKey);
    if (entry && now < entry.expiresAt && Array.isArray(entry.data) && entry.data.length > 0) {
      cachedDiscoveredModels = entry.data;
      modelsCacheExpiresAt = entry.expiresAt;
      return entry.data;
    }
  }

  if (!accountId || !apiToken) {
    return POPULAR_MODELS;
  }

  try {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?task=Text%20Generation`;
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return POPULAR_MODELS;
    }

    const data = await res.json().catch(() => ({}));
    const rawList = Array.isArray(data.result) ? data.result : [];
    if (!rawList.length) {
      return POPULAR_MODELS;
    }

    const eligible = [];
    for (const m of rawList) {
      if (!m.name || typeof m.name !== 'string') continue;
      const props = {};
      for (const p of m.properties || []) {
        if (p?.property_id) props[p.property_id] = p.value;
      }

      // Exclude models that require a paid Workers plan
      const requirePaid = props.require_workers_paid === 'true' || props.require_workers_paid === true;
      if (requirePaid) continue;

      // Exclude LoRA adapters and safety/guardrail classifiers
      if (m.name.endsWith('-lora')) continue;
      if (m.name.includes('guard') || m.name.includes('moderation')) continue;
      if (props.beta === 'true' && !props.price) continue;

      let inputPrice = null;
      let outputPrice = null;
      if (Array.isArray(props.price)) {
        for (const pr of props.price) {
          if (pr.unit?.includes('input') && !pr.unit?.includes('cached')) inputPrice = pr.price;
          if (pr.unit?.includes('output')) outputPrice = pr.price;
        }
      }

      // Calculate neuron rates: 1,000 neurons = $0.011 => ~$90,909 neurons per $1.00 USD
      if (inputPrice !== null && outputPrice !== null) {
        registerDynamicRates(m.name, inputPrice * 90909, outputPrice * 90909);
      }

      const avgPrice = (inputPrice !== null && outputPrice !== null)
        ? (inputPrice + outputPrice) / 2
        : (inputPrice ?? 999);

      eligible.push({
        id: m.name,
        inputPrice,
        outputPrice,
        avgPrice,
      });
    }

    // Sort: default recommended model first, then cheapest free models ascending
    eligible.sort((a, b) => {
      if (a.id === DEFAULT_AI_MODEL) return -1;
      if (b.id === DEFAULT_AI_MODEL) return 1;
      return a.avgPrice - b.avgPrice;
    });

    const formatted = eligible.map((m) => ({
      id: m.id,
      name: formatModelDisplayName(m.id),
      tag: buildModelTag(m.id, m.inputPrice),
    }));

    if (formatted.length) {
      cachedDiscoveredModels = formatted;
      modelsCacheExpiresAt = now + MODELS_CACHE_TTL_MS;
      aiCache.set(diskKey, { data: formatted, expiresAt: modelsCacheExpiresAt });
      savePersistentCache();
      return formatted;
    }
  } catch (err) {
    // Upstream failure or offline: fall back to POPULAR_MODELS
  }

  return POPULAR_MODELS;
}

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
    response?.response ??
    response?.output_text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === 'string' ? part : part?.text ?? part?.content ?? '').filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    return JSON.stringify(content);
  }
  if (response && typeof response === 'object') return JSON.stringify(response);
  return '';
}

function parseJsonCandidate(candidate) {
  let value = candidate;
  // A few model/provider combinations return a JSON-encoded string containing the JSON object.
  // Unwrap at most twice; never try to repair values or infer missing fields.
  for (let depth = 0; depth <= 2; depth++) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string' && depth < 2) {
        value = parsed.trim();
        continue;
      }
      return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

/** Parse plain, fenced, nested-string, or prose-wrapped JSON without rewriting its data. */
export function parseJsonFromAiText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const direct = parseJsonCandidate(trimmed);
  if (direct !== null) return direct;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) {
    const parsed = parseJsonCandidate(fenced[1]);
    if (parsed !== null) return parsed;
  }
  return extractJson(trimmed);
}

export function extractJson(str) {
  if (typeof str !== 'string') return null;
  for (let start = 0; start < str.length; start++) {
    if (str[start] !== '{' && str[start] !== '[') continue;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let end = start; end < str.length; end++) {
      const char = str[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        const open = stack.pop();
        if ((char === '}' && open !== '{') || (char === ']' && open !== '[')) break;
        if (!stack.length) {
          const parsed = parseJsonCandidate(str.slice(start, end + 1));
          if (parsed !== null) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

function safeResponseDiagnostic(rawResponse, rawText) {
  const trimmed = rawText.trim();
  const finishReason = rawResponse?.choices?.[0]?.finish_reason ?? rawResponse?.finish_reason;
  return {
    response_chars: rawText.length,
    starts_with_json: /^[\[{]/.test(trimmed),
    ends_with_json: /[\]}]$/.test(trimmed),
    has_ranking_key: /\b(?:ranked_outlets|rankedOutlets)\b/.test(rawText),
    parses_as_json: parseJsonFromAiText(rawText) !== null,
    response_envelope: rawResponse?.choices ? 'choices' : rawResponse?.response !== undefined ? 'response' : 'other',
    ...(typeof finishReason === 'string' && /^[a-z_-]+$/i.test(finishReason) ? { finish_reason: finishReason } : {}),
  };
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
  let transformError = '';
  const applyTransform = (value) => {
    if (!transform || !value) return value;
    try {
      const transformed = transform(value);
      if (!transformed) transformError = 'Response JSON did not match the expected structure';
      return transformed;
    } catch (error) {
      transformError = error instanceof Error ? error.message : String(error);
      return null;
    }
  };
  let transformed = applyTransform(parsedObj);

  let validation = schema && transformed ? schema.safeParse(transformed) : { success: Boolean(transformed), data: transformed };

  // Retry once on schema validation or JSON parse failure
  if (!validation.success || !transformed) {
    const validationError = validation.error
      ? validation.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
      : !parsedObj ? 'Response was not valid JSON' : transformError || 'Response JSON did not match the expected structure';

    const retryMessages = [
      ...messages,
      {
        role: 'user',
        content: [
          `Your previous response was rejected: ${validationError}.`,
          'Re-evaluate using only the menu and taste profile from the first user message.',
          'Return one JSON object only, with no markdown, commentary, or reasoning text.',
          'Include headline, top_outlet, ranked_outlets, and tip. Each ranked outlet must include outlet, rank, an integer match_score from 0 to 100, verdict, and highlights.',
          'Do not invent or default a score. Use the evidence in the posted menu and taste profile.',
        ].join(' '),
      },
    ];

    try {
      rawResponse = await callAi(retryMessages);
      rawText = unwrapAiResponseText(rawResponse);
      parsedObj = parseJsonFromAiText(rawText);
      transformError = '';
      transformed = applyTransform(parsedObj);
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
        : !parsedObj ? 'Response was not valid JSON' : transformError || 'Response JSON did not match the expected structure';
      const err = new Error(`AI response failed schema validation after retry: ${secondError}`);
      err.raw = rawText;
      err.diagnostic = safeResponseDiagnostic(rawResponse, rawText);
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
  let payload = parsed;
  for (let depth = 0; depth < 4 && payload && typeof payload === 'object'; depth++) {
    if (Array.isArray(payload.ranked_outlets) || Array.isArray(payload.rankedOutlets)) break;
    const nested = payload.result ?? payload.data ?? payload.output ?? payload.response ?? payload.content ?? payload.recommendation;
    if (nested === undefined) break;
    payload = typeof nested === 'string' ? parseJsonFromAiText(nested) : nested;
  }
  const ranked = payload?.ranked_outlets ?? payload?.rankedOutlets;
  if (!Array.isArray(ranked)) throw new TypeError('Expected a ranked_outlets array in the JSON response');
  return {
    service_date: serviceDate,
    model,
    headline: payload.headline,
    top_outlet: payload.top_outlet ?? payload.topOutlet,
    ranked_outlets: ranked.map((o) => ({
      outlet: o.outlet ?? o.outlet_name ?? o.outletName,
      rank: o.rank,
      match_score: o.match_score ?? o.matchScore,
      verdict: o.verdict,
      highlights: Array.isArray(o.highlights)
        ? o.highlights.map((h) => {
            const rawWhy = typeof h.why === 'string' ? h.why.trim() : h.why;
            if (typeof rawWhy !== 'string') return { dish: h.dish, why: rawWhy };
            const words = rawWhy.split(/\s+/).filter(Boolean);
            const why = words.length > 5 ? words.slice(0, 5).join(' ') : rawWhy;
            return { dish: h.dish, why };
          })
        : o.highlights,
    })),
    tip: payload.tip,
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
    maxTokens: 2048,
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
