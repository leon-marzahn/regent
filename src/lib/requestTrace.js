// Per-request routing trace for the Usage request inspector.
//
// One trace per /v1 chat request: the requested model, the combo it expanded
// to, and every upstream attempt in order (provider, account label, model,
// translation pair, status, latency, tokens, why it fell back).
//
// Rules:
// - Metadata only. Never bodies, headers, keys, tokens or cookies; error text is
//   redacted and clamped. Connection ids/labels, not credentials.
// - Bounded: an in-memory write-through cache of MAX_TRACES traces (TRACE_TTL_MS),
//   persisted in batches to SQLite (requestTracesRepo, capped by the request-log limit),
//   MAX_ATTEMPTS attempts per trace. Writes are batched off the hot path.
// - Fail-open: every exported function swallows its own errors. Tracing must
//   never break or slow a request.
import { AsyncLocalStorage } from "node:async_hooks";

export const MAX_TRACES = 500;
export const MAX_ATTEMPTS = 16;
export const TRACE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR_CHARS = 240;
const MAX_STR = 200;
const STREAM_PLACEHOLDER = "[Streaming in progress...]";

// Shared across module instances (Next bundles API routes and /v1 separately).
const store = (globalThis.__regentRequestTraces ??= {
  traces: new Map(),
  als: new AsyncLocalStorage(),
  seq: 0,
  dirty: new Set(),
  flushTimer: null,
});

export const FLUSH_DELAY_MS = 1000;

/** Queue a trace for the next batched DB write. Never throws, never awaits. */
function markDirty(id) {
  try {
    if (!id) return;
    store.dirty.add(id);
    if (store.flushTimer) return;
    store.flushTimer = setTimeout(() => {
      store.flushTimer = null;
      flushTraces().catch(() => {});
    }, FLUSH_DELAY_MS);
    store.flushTimer.unref?.();
  } catch {
    /* fail-open */
  }
}

/** Write queued traces to SQLite. Errors are logged once per batch and dropped. */
export async function flushTraces() {
  const ids = [...store.dirty];
  store.dirty.clear();
  if (!ids.length) return;
  try {
    const snaps = ids
      .map((id) => store.traces.get(id))
      .filter(Boolean)
      .map(snapshot)
      .filter(Boolean);
    const { saveRequestTraces } = await import("@/lib/db/repos/requestTracesRepo.js");
    await saveRequestTraces(snaps);
  } catch (e) {
    console.warn("[requestTrace] persist failed:", e?.message);
  }
}

const str = (v, max = MAX_STR) => (v == null || v === "" ? undefined : String(v).slice(0, max));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Strip anything credential-shaped from free text (upstream error messages). */
export function redactSecrets(text) {
  if (text == null) return undefined;
  let s =
    typeof text === "string"
      ? text
      : (() => {
          try {
            return JSON.stringify(text);
          } catch {
            return String(text);
          }
        })();
  s = s
    // user:pass@ in URLs (proxy URLs, basic-auth endpoints)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1***:***@")
    // Authorization-style values
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ***")
    // key=value / "key": "value" for secret-ish names
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|cookie|authorization|x-api-key|key)["']?\s*[:=]\s*["']?)[^"'\s,&}]+/gi,
      "$1***",
    )
    // Well-known key prefixes and JWTs
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "$1-***")
    .replace(/\b(AIza)[A-Za-z0-9_-]{20,}/g, "$1***")
    .replace(/\b(gh[pousr]_)[A-Za-z0-9]{16,}/g, "$1***")
    .replace(/\b(xox[abpr]-)[A-Za-z0-9-]{8,}/g, "$1***")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "***jwt***")
    // Long opaque tokens
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "***");
  return s.length > MAX_ERROR_CHARS ? `${s.slice(0, MAX_ERROR_CHARS)}…` : s;
}

/** Why an attempt failed, in the inspector's vocabulary. */
export function classifyFailure(status) {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 499) return "aborted";
  if (status === 503) return "unavailable";
  if (typeof status === "number" && status >= 500) return "server";
  if (typeof status === "number" && status >= 400) return "client";
  return "error";
}

function prune(now = Date.now()) {
  const { traces } = store;
  for (const [id, t] of traces) {
    if (traces.size <= MAX_TRACES && now - t.startedAt <= TRACE_TTL_MS) break;
    traces.delete(id);
  }
}

/** Create and register a trace. Returns null on any failure. */
export function startTrace({ endpoint, requestedModel } = {}) {
  try {
    const now = Date.now();
    const id = `tr_${now.toString(36)}${(store.seq++ % 1679616).toString(36).padStart(4, "0")}${Math.random().toString(36).slice(2, 6)}`;
    const trace = {
      id,
      startedAt: now,
      timestamp: new Date(now).toISOString(),
      endpoint: str(endpoint, 120),
      requestedModel: str(requestedModel),
      combo: undefined,
      attempts: [],
      outcome: { status: "pending" },
    };
    store.traces.set(id, trace);
    prune(now);
    return trace;
  } catch {
    return null;
  }
}

/** Run fn with trace as the current trace (fn runs even if trace is null). */
export function runWithTrace(trace, fn) {
  if (!trace) return fn();
  return store.als.run(trace, fn);
}

export function currentTrace() {
  try {
    return store.als.getStore() || null;
  } catch {
    return null;
  }
}

export function setRequestedModel(model, trace = currentTrace()) {
  try {
    if (trace) trace.requestedModel = str(model);
  } catch {
    /* fail-open */
  }
}

/** Record the combo the requested model expanded to (first one wins: nested combos keep the outer). */
export function traceCombo({ name, strategy, models } = {}, trace = currentTrace()) {
  try {
    if (!trace || trace.combo) return;
    trace.combo = {
      name: str(name),
      strategy: str(strategy, 40),
      models: Array.isArray(models)
        ? models
            .slice(0, 32)
            .map((m) => str(m))
            .filter(Boolean)
        : [],
    };
  } catch {
    /* fail-open */
  }
}

/** Start an attempt on the current trace. Returns a handle (or null). */
export function beginAttempt(
  { provider, model, connectionId, connectionLabel, requestedModel } = {},
  trace = currentTrace(),
) {
  try {
    if (!trace) return null;
    if (trace.attempts.length >= MAX_ATTEMPTS) {
      trace.truncatedAttempts = (trace.truncatedAttempts || 0) + 1;
      return null;
    }
    const attempt = {
      traceId: trace.id,
      index: trace.attempts.length,
      startedAt: Date.now(),
      provider: str(provider, 80),
      model: str(model),
      connectionId: str(connectionId, 80),
      connectionLabel: str(connectionLabel, 120),
      requestedModel: requestedModel && requestedModel !== model ? str(requestedModel) : undefined,
      status: "pending",
    };
    trace.attempts.push(attempt);
    return attempt;
  } catch {
    return null;
  }
}

/** Translation pair + streaming, set by chatCore once known. */
export function annotateAttempt(
  attempt,
  { sourceFormat, targetFormat, stream, passthrough, upstreamModel } = {},
) {
  try {
    if (!attempt) return;
    if (sourceFormat) attempt.sourceFormat = str(sourceFormat, 40);
    if (targetFormat) attempt.targetFormat = str(targetFormat, 40);
    if (typeof stream === "boolean") attempt.stream = stream;
    if (typeof passthrough === "boolean") attempt.passthrough = passthrough;
    if (upstreamModel) attempt.upstreamModel = str(upstreamModel);
    markDirty(attempt.traceId);
  } catch {
    /* fail-open */
  }
}

function compactTokens(t) {
  if (!t || typeof t !== "object") return undefined;
  const cached =
    num(t.cached_tokens) ??
    num(t.cache_read_input_tokens) ??
    num(t.prompt_tokens_details?.cached_tokens);
  const out = {
    in: num(t.prompt_tokens) ?? num(t.input_tokens),
    out: num(t.completion_tokens) ?? num(t.output_tokens),
    cached,
    cacheWrite: num(t.cache_creation_input_tokens),
    reasoning: num(t.reasoning_tokens) ?? num(t.completion_tokens_details?.reasoning_tokens),
    credits: num(t.credits),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

/**
 * Fold a request-detail record (the same object chatCore saves for the Usage
 * feed) into its attempt: status, latency, tokens, error summary, detail id.
 * Only whitelisted metadata is copied; bodies are ignored.
 */
export function traceDetail(attempt, detail) {
  try {
    if (!attempt || !detail) return;
    const failed = detail.status === "error";
    const resp = detail.response && typeof detail.response === "object" ? detail.response : {};
    if (failed) {
      attempt.status = "error";
      attempt.statusCode = num(resp.status) ?? attempt.statusCode;
      attempt.error = redactSecrets(resp.error);
      attempt.reason = classifyFailure(attempt.statusCode);
    } else {
      // streamingHandler saves a placeholder when the stream opens, then the real detail on completion.
      attempt.status = resp.content === STREAM_PLACEHOLDER ? "streaming" : "ok";
      attempt.statusCode = 200;
    }
    const lat = detail.latency || {};
    if (num(lat.total)) attempt.latencyMs = lat.total;
    if (num(lat.ttft)) attempt.ttftMs = lat.ttft;
    const tokens = compactTokens(detail.tokens);
    if (tokens && (tokens.in || tokens.out)) attempt.tokens = tokens;
    if (detail.id) attempt.detailId = str(detail.id, 200);
    markDirty(attempt.traceId);
  } catch {
    /* fail-open */
  }
}

/** Close an attempt from the routing loop's view (status code, fallback decision). */
export function endAttempt(attempt, { status, error, fallback, reason, skipped } = {}) {
  try {
    if (!attempt) return;
    if (attempt.latencyMs == null) attempt.latencyMs = Date.now() - attempt.startedAt;
    if (skipped) attempt.skipped = true;
    if (typeof status === "number") {
      if (status >= 400) {
        attempt.status = "error";
        attempt.statusCode = status;
        attempt.reason = reason || attempt.reason || classifyFailure(status);
        if (error != null && !attempt.error) attempt.error = redactSecrets(error);
      } else if (attempt.status === "pending") {
        attempt.status = "ok";
        attempt.statusCode = status;
      }
    } else if (reason) {
      attempt.reason = reason;
    }
    if (fallback) attempt.fallback = str(fallback, 20);
    markDirty(attempt.traceId);
  } catch {
    /* fail-open */
  }
}

/** Final outcome as returned to the client. */
export function finishTrace(trace, { status, stream } = {}) {
  try {
    if (!trace) return;
    trace.outcome = {
      status: typeof status === "number" ? (status < 400 ? "ok" : "error") : "error",
      statusCode: num(status),
    };
    if (typeof stream === "boolean") trace.stream = stream;
    trace.totalLatencyMs = Date.now() - trace.startedAt;
    markDirty(trace.id);
  } catch {
    /* fail-open */
  }
}

/** A serializable copy for the API (also re-runs redaction defensively). */
export function getTrace(id) {
  try {
    prune();
    const t = store.traces.get(id);
    return t ? snapshot(t) : null;
  } catch {
    return null;
  }
}

/** Memory first (live, includes in-flight streams), then the persisted copy. */
export async function loadTrace(id) {
  const live = getTrace(id);
  if (live) return live;
  try {
    const { getRequestTraceById } = await import("@/lib/db/repos/requestTracesRepo.js");
    const t = await getRequestTraceById(id);
    if (!t) return null;
    // Stored rows were redacted on write; redact again in case of older rows.
    return {
      ...t,
      attempts: (t.attempts || []).map((a) => ({
        ...a,
        error: a.error ? redactSecrets(a.error) : undefined,
      })),
    };
  } catch {
    return null;
  }
}

function snapshot(t) {
  try {
    const attempts = t.attempts.map(({ startedAt, traceId: _traceId, ...a }, i) => ({
      ...a,
      offsetMs: startedAt - t.startedAt,
      error: a.error ? redactSecrets(a.error) : undefined,
      // A failed attempt followed by another one without an account switch
      // means the combo moved on to its next model.
      fallback:
        a.fallback ||
        (a.status === "error" && i < t.attempts.length - 1
          ? t.combo
            ? "model"
            : "account"
          : undefined),
    }));
    const last = attempts[attempts.length - 1];
    const tokens = [...attempts].reverse().find((a) => a.tokens)?.tokens;
    // Streaming responses finish after the handler returned; take the live end.
    const streamingDone = last && last.status !== "streaming" && last.latencyMs != null;
    return {
      id: t.id,
      timestamp: t.timestamp,
      endpoint: t.endpoint,
      requestedModel: t.requestedModel,
      combo: t.combo,
      attempts,
      truncatedAttempts: t.truncatedAttempts,
      outcome: t.outcome,
      stream: t.stream ?? last?.stream,
      tokens,
      totalLatencyMs:
        streamingDone && last.stream
          ? Math.max(t.totalLatencyMs ?? 0, (last.offsetMs ?? 0) + last.latencyMs)
          : t.totalLatencyMs,
    };
  } catch {
    return null;
  }
}

export const __test__ = {
  reset() {
    store.traces.clear();
    store.dirty.clear();
    if (store.flushTimer) clearTimeout(store.flushTimer);
    store.flushTimer = null;
  },
  size() {
    return store.traces.size;
  },
  raw(id) {
    return store.traces.get(id);
  },
  latestId() {
    return [...store.traces.keys()].pop();
  },
};
