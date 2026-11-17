import { saveRequestUsage, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { COLORS } from "../../utils/stream.js";
import { traceDetail } from "@/lib/requestTrace.js";
import { canonicalizeUsage } from "../../utils/usageTracking.js";
import { openaiCacheWriteTokens, reportedUsageCost } from "../../translator/concerns/usage.js";
import { REQUEST_DETAIL_FIELDS } from "../../config/requestDetailConfig.js";

// Router control headers (x-regent-*, plus the legacy x-9router-* names) the client sent.
export function pickRegentHeaders(headers) {
  const picked = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (/^x-(regent|9router)-/i.test(key)) picked[key.toLowerCase()] = String(value);
  }
  return picked;
}

// The client request as stored for the Usage drawer. `body` is the client's
// body in its own wire format (Responses `input`, Claude `system`, ...), so
// the stored fields come from the per-format list in requestDetailConfig.js.
export function extractRequestConfig(body, stream, regentHeaders) {
  const config = { model: body?.model, stream };
  for (const field of REQUEST_DETAIL_FIELDS) {
    if (body?.[field] !== undefined) config[field] = body[field];
  }
  if (regentHeaders && Object.keys(regentHeaders).length) config.regentHeaders = regentHeaders;
  return config;
}

export function extractUsageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;

  // Claude format
  // Note: OpenAI Responses usage ({input_tokens, input_tokens_details:{cached_tokens}})
  // also matches this branch. Its prompt is cache-INCLUSIVE and its cache rides in
  // input_tokens_details, so emit it as cached_tokens — the convention
  // canonicalizeUsage() passes through without folding. Reading it here keeps
  // cache accounting correct for /v1/responses and codex traffic.
  if (responseBody.usage?.input_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.input_tokens || 0,
      completion_tokens: responseBody.usage.output_tokens || 0,
      cached_tokens: responseBody.usage.cached_tokens ?? responseBody.usage.input_tokens_details?.cached_tokens,
      cache_read_input_tokens: responseBody.usage.cache_read_input_tokens,
      cache_creation_input_tokens: responseBody.usage.cache_creation_input_tokens
    };
  }

  // OpenAI format
  if (responseBody.usage?.prompt_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.prompt_tokens || 0,
      completion_tokens: responseBody.usage.completion_tokens || 0,
      cached_tokens: responseBody.usage.cached_tokens ?? responseBody.usage.prompt_tokens_details?.cached_tokens,
      // canonicalizeUsage reads cache writes from here (cache_creation_tokens / OpenRouter's
      // cache_write_tokens). Not lifted to cache_creation_input_tokens: that would send it
      // down the Claude fold branch and add the writes to prompt_tokens twice.
      prompt_tokens_details: responseBody.usage.prompt_tokens_details,
      reasoning_tokens: responseBody.usage.completion_tokens_details?.reasoning_tokens,
      credits: responseBody.usage.credits,
      cost_usd: reportedUsageCost(responseBody.usage)
    };
  }

  // Gemini format. Antigravity / gemini-cli wrap the payload in { response: {...} }.
  const usageMetadata = responseBody.usageMetadata || responseBody.response?.usageMetadata;
  if (usageMetadata) {
    return {
      prompt_tokens: usageMetadata.promptTokenCount || 0,
      // thoughtsTokenCount is outside candidatesTokenCount; fold it in so
      // reasoning_tokens stays a subset of completion_tokens (see pricing.js).
      completion_tokens: (usageMetadata.candidatesTokenCount || 0) + (usageMetadata.thoughtsTokenCount || 0),
      cached_tokens: usageMetadata.cachedContentTokenCount || 0,
      reasoning_tokens: usageMetadata.thoughtsTokenCount || 0
    };
  }

  // Ollama format: prompt_eval_count/eval_count at top level (not nested under usage).
  // prompt_eval_cached_count is a cache-read subset of prompt_eval_count (cache-INCLUSIVE).
  if (responseBody.done === true &&
      (responseBody.prompt_eval_count !== undefined || responseBody.eval_count !== undefined)) {
    const prompt = responseBody.prompt_eval_count || 0;
    const completion = responseBody.eval_count || 0;
    const cached = responseBody.prompt_eval_cached_count || 0;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      cached_tokens: cached
    };
  }

  return null;
}

export function buildRequestDetail(base, overrides = {}) {
  return {
    provider: base.provider || "unknown",
    model: base.model || "unknown",
    connectionId: base.connectionId || undefined,
    timestamp: new Date().toISOString(),
    latency: base.latency || { ttft: 0, total: 0 },
    // Claude-shaped usage (input_tokens/output_tokens) must still fill the fields the dashboard reads.
    tokens: base.tokens
      ? {
          ...base.tokens,
          // Claude input_tokens excludes cache; add it back so IN is the full prompt.
          prompt_tokens: base.tokens.prompt_tokens
            ?? (base.tokens.input_tokens || 0) + (base.tokens.cache_read_input_tokens || 0) + (base.tokens.cache_creation_input_tokens || 0),
          completion_tokens: base.tokens.completion_tokens ?? base.tokens.output_tokens ?? 0
        }
      : { prompt_tokens: 0, completion_tokens: 0 },
    request: base.request,
    providerRequest: base.providerRequest || null,
    providerResponse: base.providerResponse || null,
    response: base.response || {},
    pxpipe: base.pxpipe || undefined,
    status: base.status || "success",
    ...overrides
  };
}

// Build the "done" summary: duration, ttft, in/out tokens with cache breakdown
export function formatDoneLine({ usage, latency }) {
  const u = usage || {};
  const inTok = u.prompt_tokens ?? u.input_tokens ?? 0;
  const outTok = u.completion_tokens ?? u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? openaiCacheWriteTokens(u.prompt_tokens_details) ?? 0;
  let inStr = `IN ${inTok}`;
  if (cacheRead || cacheCreate) {
    const parts = [];
    if (cacheRead) parts.push(`↻${cacheRead}`);
    if (cacheCreate) parts.push(`+${cacheCreate}`);
    inStr += ` (CACHE ${parts.join(" ")})`;
  }
  const ttftStr = latency?.ttft ? ` · TTFT ${latency.ttft}ms` : "";
  return `DONE ${latency?.total ?? 0}ms${ttftStr} · ${inStr} · OUT ${outTok}`;
}

export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, traceId, endpoint, label = "USAGE", silent = false }) {
  if (!tokens || typeof tokens !== "object") return;

  const inTokens = tokens.input_tokens ?? tokens.prompt_tokens ?? 0;
  const outTokens = tokens.output_tokens ?? tokens.completion_tokens ?? 0;

  if (inTokens === 0 && outTokens === 0) return;

  if (!silent) {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const accountSuffix = connectionId ? ` | account=${connectionId.slice(0, 8)}...` : "";
    console.log(`${COLORS.green}[${time}] 📊 [${label}] ${provider.toUpperCase()} | in=${inTokens} | out=${outTokens}${accountSuffix}${COLORS.reset}`);
  }

  // Canonicalize to one storage convention (prompt_tokens cache-inclusive) so
  // cached/cache-creation tokens survive to cost calc + stats. See canonicalizeUsage.
  const normalized = canonicalizeUsage(tokens) || {
    prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? 0,
    completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? 0
  };

  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: normalized,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    traceId: traceId || undefined,
    endpoint: endpoint || null
  }).catch(() => {});
}

/**
 * Save a request detail for the Usage feed and fold its metadata into the
 * routing trace attempt (if any). Trace errors never affect the save.
 */
export function recordRequestDetail(traceAttempt, detail) {
  if (traceAttempt && detail) {
    try {
      detail.traceId = traceAttempt.traceId;
      traceDetail(traceAttempt, detail);
    } catch { /* tracing is fail-open */ }
  }
  return saveRequestDetail(detail);
}
