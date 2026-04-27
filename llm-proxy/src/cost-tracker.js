/**
 * Cost Tracker — Token counting and cost estimation for LLM API responses.
 *
 * Extracts token usage from streaming LLM responses (OpenAI, Claude, etc.)
 * and estimates cost based on configurable per-model pricing.
 *
 * Zero dependencies — parses SSE chunks from the relay stream.
 *
 * Usage:
 *   import { createCostTracker, getCostStats, getRequestCost } from './cost-tracker.js';
 *   const tracker = createCostTracker(requestId, requestBody);
 *   tracker.processChunk(chunkText);   // call for each relay chunk
 *   tracker.finalize();                // call on stream completion
 */

import * as log from './logger.js';

// --- Model pricing (USD per 1M tokens) ---
// Can be overridden via COST_PRICING_JSON env var

// 가격은 USD per 1M tokens. 공식 사이트 기준(2026-04 시점), findPricing()이
// longest-prefix match 하므로 버전 접미사가 붙은 모델명(예: -20260101)은
// 자동으로 접두어 엔트리에 매칭됨. 불확실하거나 누락된 모델은 COST_PRICING_JSON
// 환경변수로 운영 중 오버라이드 가능.
const DEFAULT_PRICING = {
  // ===== OpenAI =====
  // GPT-5.4 family (2026 flagship)
  'gpt-5.4-pro':           { input: 30.00, output: 180.00 },
  'gpt-5.4-mini':          { input: 0.75,  output: 4.50   },
  'gpt-5.4-nano':          { input: 0.20,  output: 1.25   },
  'gpt-5.4':               { input: 2.50,  output: 15.00  },
  // GPT-5 (standard)
  'gpt-5':                 { input: 1.25,  output: 10.00  },
  // GPT-4.1
  'gpt-4.1':               { input: 2.00,  output: 8.00   },
  // o-series reasoning
  'o3':                    { input: 10.00, output: 40.00  },
  'o3-mini':               { input: 1.10,  output: 4.40   },
  'o1':                    { input: 15.00, output: 60.00  },
  'o1-mini':               { input: 3.00,  output: 12.00  },
  // GPT-4o (legacy)
  'gpt-4o':                { input: 2.50,  output: 10.00  },
  'gpt-4o-mini':           { input: 0.15,  output: 0.60   },
  'gpt-4-turbo':           { input: 10.00, output: 30.00  },
  'gpt-4':                 { input: 30.00, output: 60.00  },
  'gpt-3.5-turbo':         { input: 0.50,  output: 1.50   },

  // ===== Anthropic =====
  // Claude 4.5 / 4.6 (1M context 표준가 포함 — 4.6)
  'claude-opus-4-6':       { input: 5.00,  output: 25.00  },
  'claude-opus-4-5':       { input: 5.00,  output: 25.00  },
  'claude-sonnet-4-6':     { input: 3.00,  output: 15.00  },
  'claude-sonnet-4-5':     { input: 3.00,  output: 15.00  },
  'claude-haiku-4-5':      { input: 1.00,  output: 5.00   },
  // Claude 4 (2025)
  'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
  'claude-sonnet-4-20250514':  { input: 3.00,  output: 15.00 },
  'claude-haiku-4-20250514':   { input: 0.80,  output: 4.00  },
  // Claude 3.5 / 3 (legacy)
  'claude-3-5-sonnet':     { input: 3.00,  output: 15.00  },
  'claude-3-5-haiku':      { input: 0.80,  output: 4.00   },
  'claude-3-opus':         { input: 15.00, output: 75.00  },

  // ===== Google Gemini =====
  // Gemini 3.1 — pro는 프롬프트 >200k 시 high-tier 요금 자동 적용 (Google 정책:
  // 전체 요청이 높은 단가로 재계산되며 split이 아님)
  'gemini-3.1-pro':        { input: 2.00,  output: 12.00,
                             tierThresholdTokens: 200000, inputHigh: 4.00, outputHigh: 18.00 },
  'gemini-3.1-flash-lite': { input: 0.25,  output: 1.50   },
  // Gemini 3
  'gemini-3-flash':        { input: 0.50,  output: 3.00   },
  // Gemini 2.5 — pro는 >200k 시 high-tier
  'gemini-2.5-pro':        { input: 1.25,  output: 10.00,
                             tierThresholdTokens: 200000, inputHigh: 2.50, outputHigh: 15.00 },
  'gemini-2.5-flash-lite': { input: 0.10,  output: 0.40   },
  'gemini-2.5-flash':      { input: 0.30,  output: 2.50   },
  // Gemini 2.0 / 1.5 (legacy)
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.30   },
  'gemini-2.0-flash':      { input: 0.10,  output: 0.40   },
  'gemini-1.5-pro':        { input: 1.25,  output: 5.00   },
  'gemini-1.5-flash':      { input: 0.075, output: 0.30   },
};

/** @type {Record<string, {input: number, output: number}>} */
let pricing = { ...DEFAULT_PRICING };

// Load custom pricing from env
try {
  const custom = process.env.COST_PRICING_JSON;
  if (custom) {
    const parsed = JSON.parse(custom);
    Object.assign(pricing, parsed);
    log.info('cost:pricing-loaded', { models: Object.keys(parsed).length });
  }
} catch (e) {
  log.warn('cost:pricing-parse-error', { error: e.message });
}

// --- Per-request cost data ---

/**
 * @typedef {Object} CostData
 * @property {string} requestId
 * @property {string} model
 * @property {number} tokensIn       - Input tokens (from request body or provider usage)
 * @property {number} tokensOut      - Output tokens (from provider usage or estimated)
 * @property {number} estimatedCost  - Estimated cost in USD
 * @property {string} provider       - Detected provider (openai, anthropic, google, unknown)
 * @property {boolean} usageFromApi  - Whether token counts came from the API (vs estimated)
 * @property {'standard'|'high'} [pricingTier] - Active pricing tier (only set for tiered models)
 */

/** @type {Map<string, CostData>} */
const costData = new Map();

// --- Aggregate stats ---

/** @type {{ totalCost: number, totalTokensIn: number, totalTokensOut: number, requestCount: number }} */
const aggregate = {
  totalCost: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  requestCount: 0,
};

// --- Provider detection ---

/**
 * Detect LLM provider from the target URL.
 * @param {string} url
 * @returns {'openai'|'anthropic'|'google'|'openrouter'|'unknown'}
 */
function detectProvider(url) {
  if (!url) return 'unknown';
  if (url.includes('api.openai.com') || url.includes('api.azure.com')) return 'openai';
  if (url.includes('api.anthropic.com')) return 'anthropic';
  if (url.includes('generativelanguage.googleapis.com')) return 'google';
  if (url.includes('openrouter.ai')) return 'openrouter';
  return 'unknown';
}

/**
 * Estimate input tokens from request body.
 * Uses the messages array content length as a rough estimate.
 * @param {Object} body - Parsed request body
 * @returns {number}
 */
function estimateInputTokens(body) {
  if (!body) return 0;
  try {
    let charCount = 0;

    // OpenAI / Claude: body.messages
    const messages = body.messages || [];
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        charCount += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            charCount += part.text.length;
          }
        }
      }
      if (msg.role) charCount += msg.role.length;
    }
    // OpenAI system prompt (string) / Claude system prompt (string)
    if (typeof body.system === 'string') charCount += body.system.length;

    // Gemini: body.contents — [{ role, parts: [{ text }] }]
    const contents = body.contents || [];
    for (const c of contents) {
      if (c?.role) charCount += c.role.length;
      const parts = c?.parts || [];
      for (const p of parts) {
        if (typeof p?.text === 'string') charCount += p.text.length;
        // inline_data(이미지 등)는 문자 수로 토큰 추정 불가 — 스킵
      }
    }
    // Gemini systemInstruction: { parts: [{ text }] } 또는 { role, parts }
    const sysInst = body.systemInstruction;
    if (sysInst?.parts) {
      for (const p of sysInst.parts) {
        if (typeof p?.text === 'string') charCount += p.text.length;
      }
    }

    // Rough estimate: ~4 chars per token for English, ~2 for CJK
    return Math.ceil(charCount / 3.5);
  } catch {
    return 0;
  }
}

// --- Tracker ---

/**
 * Create a cost tracker for a specific request.
 * @param {string} requestId
 * @param {string} targetUrl - Target LLM API URL
 * @param {Object} requestBody - Parsed request body
 * @returns {{ processChunk: (chunk: string) => void, finalize: () => CostData }}
 */
export function createCostTracker(requestId, targetUrl, requestBody) {
  const provider = detectProvider(targetUrl);
  // OpenAI/Copilot: model in body. Gemini: model in URL path (/models/<name>:generateContent)
  let model = requestBody?.model || 'unknown';
  if (model === 'unknown' && targetUrl) {
    const m = targetUrl.match(/\/models\/([^:/?]+)/);
    if (m) model = m[1];
  }
  const estimatedIn = estimateInputTokens(requestBody);

  /** @type {CostData} */
  const data = {
    requestId,
    model,
    tokensIn: estimatedIn,
    tokensOut: 0,
    estimatedCost: 0,
    provider,
    usageFromApi: false,
  };

  // Accumulate output characters for estimation fallback
  let outputChars = 0;

  // Buffer for partial JSON parsing
  let apiUsage = null;

  costData.set(requestId, data);

  return {
    /**
     * Process a relay chunk to extract token usage or count output chars.
     * @param {string} chunkText - Raw SSE line from relay
     */
    processChunk(chunkText) {
      // Try to extract usage from the chunk
      try {
        // OpenAI format: data: {"choices":[...],"usage":{"prompt_tokens":N,"completion_tokens":N}}
        // Claude format: event: message_delta / data: {"usage":{"input_tokens":N,"output_tokens":N}}
        // Gemini format: data: {"candidates":[{"content":{"parts":[{"text":...}]}}],"usageMetadata":{...}}
        //   또는 배열 스트림의 개별 원소 (alt=sse 없이) — JSON 파싱 시 배열 원소 단위가 오기 어려움, 스킵 허용.
        const jsonStr = chunkText.startsWith('data: ') ? chunkText.slice(6).trim() : chunkText.trim();
        if (!jsonStr || jsonStr === '[DONE]') return;

        const parsed = JSON.parse(jsonStr);

        // Extract content for character counting
        if (parsed.choices?.[0]?.delta?.content) {
          // OpenAI streaming
          outputChars += parsed.choices[0].delta.content.length;
        } else if (parsed.delta?.text) {
          // Claude streaming (message_delta)
          outputChars += parsed.delta.text.length;
        } else if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          // Claude content_block_delta
          outputChars += parsed.delta.text.length;
        } else if (Array.isArray(parsed.candidates)) {
          // Gemini streaming: candidates[].content.parts[].text
          for (const cand of parsed.candidates) {
            const parts = cand?.content?.parts || [];
            for (const p of parts) {
              if (typeof p?.text === 'string') outputChars += p.text.length;
            }
          }
        }

        // Extract usage info (usually in the final chunk)
        if (parsed.usage) {
          apiUsage = parsed.usage;
        }
        // OpenAI: x_groq or usage in choices
        if (parsed.x_groq?.usage) {
          apiUsage = parsed.x_groq.usage;
        }
        // Gemini: usageMetadata (별도 키 — 'usage'가 아님)
        if (parsed.usageMetadata) {
          apiUsage = parsed.usageMetadata;
        }
      } catch {
        // Not JSON, skip — could be SSE comment or partial line
      }
    },

    /**
     * Finalize cost calculation after stream completion.
     * @returns {CostData}
     */
    finalize() {
      // Use API-provided usage if available
      if (apiUsage) {
        data.usageFromApi = true;
        // OpenAI format
        if (apiUsage.prompt_tokens != null) {
          data.tokensIn = apiUsage.prompt_tokens;
          data.tokensOut = apiUsage.completion_tokens || 0;
        }
        // Claude format
        if (apiUsage.input_tokens != null) {
          data.tokensIn = apiUsage.input_tokens;
          data.tokensOut = apiUsage.output_tokens || 0;
        }
        // Gemini format (usageMetadata)
        if (apiUsage.promptTokenCount != null) {
          data.tokensIn = apiUsage.promptTokenCount;
          data.tokensOut = apiUsage.candidatesTokenCount || 0;
        }
      } else {
        // Estimate output tokens from character count
        data.tokensOut = Math.ceil(outputChars / 3.5);
      }

      // Calculate cost — tier 요금제가 있는 모델은 tokensIn이 임계값을 넘으면
      // 전체 요청을 high-tier 단가로 재계산 (Google Gemini pro 계열의 >200k 정책)
      const modelPricing = findPricing(data.model);
      if (modelPricing) {
        const isHighTier =
          modelPricing.tierThresholdTokens != null &&
          data.tokensIn > modelPricing.tierThresholdTokens;
        const inputRate  = isHighTier ? modelPricing.inputHigh  : modelPricing.input;
        const outputRate = isHighTier ? modelPricing.outputHigh : modelPricing.output;
        data.estimatedCost = (
          (data.tokensIn  / 1_000_000) * inputRate +
          (data.tokensOut / 1_000_000) * outputRate
        );
        data.pricingTier = modelPricing.tierThresholdTokens != null
          ? (isHighTier ? 'high' : 'standard')
          : undefined;
      }

      // Update aggregates
      aggregate.totalCost += data.estimatedCost;
      aggregate.totalTokensIn += data.tokensIn;
      aggregate.totalTokensOut += data.tokensOut;
      aggregate.requestCount++;

      log.debug('cost:finalized', {
        requestId,
        model: data.model,
        tokensIn: data.tokensIn,
        tokensOut: data.tokensOut,
        cost: data.estimatedCost.toFixed(6),
        fromApi: data.usageFromApi,
      });

      return data;
    },
  };
}

/**
 * Find pricing for a model, supporting prefix matching.
 * e.g. "gpt-4o-2024-08-06" matches "gpt-4o"
 * @param {string} model
 * @returns {{ input: number, output: number }|null}
 */
function findPricing(model) {
  if (!model) return null;
  // Exact match first
  if (pricing[model]) return pricing[model];
  // Prefix match (longest first)
  const candidates = Object.keys(pricing)
    .filter(k => model.startsWith(k))
    .sort((a, b) => b.length - a.length);
  return candidates.length > 0 ? pricing[candidates[0]] : null;
}

// --- Query functions ---

/**
 * Get cost data for a specific request.
 * @param {string} requestId
 * @returns {CostData|undefined}
 */
export function getRequestCost(requestId) {
  return costData.get(requestId);
}

/**
 * Remove cost data for a specific request (cleanup).
 * @param {string} requestId
 */
export function removeCostData(requestId) {
  costData.delete(requestId);
}

/**
 * Get aggregate cost statistics.
 * @returns {Object}
 */
export function getCostStats() {
  return {
    ...aggregate,
    totalCost: parseFloat(aggregate.totalCost.toFixed(6)),
    trackedRequests: costData.size,
    pricingModels: Object.keys(pricing).length,
  };
}

/**
 * Get all tracked cost data (for /metrics/cost endpoint).
 * @returns {CostData[]}
 */
export function getAllCostData() {
  return [...costData.values()];
}

/**
 * Get full cost state for persistence (aggregate + all per-request data).
 * @returns {{ aggregate: Object, costs: CostData[] }}
 */
export function getCostState() {
  return {
    aggregate: { ...aggregate },
    costs: [...costData.values()],
  };
}

/**
 * Restore cost state from persisted data (called on startup).
 * @param {{ aggregate?: Object, costs?: CostData[] }} saved
 */
export function loadCostState(saved) {
  if (!saved) return;
  if (saved.aggregate) {
    aggregate.totalCost = saved.aggregate.totalCost || 0;
    aggregate.totalTokensIn = saved.aggregate.totalTokensIn || 0;
    aggregate.totalTokensOut = saved.aggregate.totalTokensOut || 0;
    aggregate.requestCount = saved.aggregate.requestCount || 0;
  }
  if (Array.isArray(saved.costs)) {
    for (const c of saved.costs) {
      if (c.requestId) costData.set(c.requestId, c);
    }
  }
}

/**
 * Clear all cost data (aggregate + per-request). Used by admin reset.
 */
export function resetAllCosts() {
  costData.clear();
  aggregate.totalCost = 0;
  aggregate.totalTokensIn = 0;
  aggregate.totalTokensOut = 0;
  aggregate.requestCount = 0;
}
