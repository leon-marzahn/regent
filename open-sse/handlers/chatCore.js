import { detectFormat, getTargetFormat, resolveTransport } from "../services/provider.js";
import { translateRequest } from "../translator/index.js";
import { applyThinking, extractThinking, stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { FORMATS } from "../translator/formats.js";
import { normalizeClaudePassthrough, anchorClaudeCache } from "../translator/formats/claude.js";
import { createStreamController } from "../utils/streamHandler.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { createRequestLogger } from "../utils/requestLogger.js";
import { getModelTargetFormat, getModelSupportedFormats, getModelStrip, getModelUpstreamId, getModelType, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { PROVIDERS } from "../config/providers.js";
import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { upstreamResponseHeaders } from "../utils/upstreamHeaders.js";
import { HTTP_STATUS, TOKEN_SAVER_HEADER, LEGACY_TOKEN_SAVER_HEADER } from "../config/runtimeConfig.js";
import { handleBypassRequest } from "../utils/bypassHandler.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { annotateAttempt } from "@/lib/requestTrace.js";
import { getExecutor } from "../executors/index.js";
import { supportsGrokCliReasoningEffort } from "../config/grokCli.js";
import { buildRequestDetail, recordRequestDetail, extractRequestConfig } from "./chatCore/requestDetail.js";
import { handleForcedSSEToJson } from "./chatCore/sseToJsonHandler.js";
import { handleNonStreamingResponse } from "./chatCore/nonStreamingHandler.js";
import { replayJsonResultAsSSE } from "./chatCore/jsonToSSE.js";
import { handleStreamingResponse, buildOnStreamComplete } from "./chatCore/streamingHandler.js";
import { detectClientTool, isNativePassthrough } from "../utils/clientDetector.js";
import { dedupeTools } from "../utils/toolDeduper.js";
import { takeRenamedToolNames } from "../utils/opencodeFingerprint.js";
import { injectCaveman } from "../rtk/caveman.js";
import { injectPonytail } from "../rtk/ponytail.js";
import { injectCustomPrompt } from "../rtk/customPrompt.js";
import { compressMessages, formatRtkLog } from "../rtk/index.js";
import { compressWithHeadroom, formatHeadroomLog, formatHeadroomSizeLog, isHeadroomPhantomSavings } from "../rtk/headroom.js";
import { compressWithPxpipe } from "../rtk/pxpipe.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { stripUnsupportedModalities } from "../translator/concerns/modality.js";
import { prefetchRemoteImages } from "../translator/concerns/prefetch.js";
import { defaultClaudeToolType, shouldDefaultClaudeToolType } from "../translator/concerns/toolCall.js";
import { resolveSessionId, clientIpFromHeaders } from "../utils/sessionManager.js";
import { normalizeTlsImpersonation } from "../config/tlsImpersonation.js";
import { knownSecrets, redactValues, maskString } from "../utils/maskSecrets.cjs";
import { requestStreamUsage, clientRequestedStreamUsage, isStreamUsageRejection, rememberStreamUsageRejected } from "../translator/concerns/streamUsage.js";
import { refreshCredentialsWithProxy } from "../utils/proxyScope.js";

/**
 * Core chat handler - shared between SSE and Worker
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {string} options.sourceFormatOverride - Override detected source format (e.g. "openai-responses")
 */
/**
 * Remove translator-internal continuity fields from the outbound upstream
 * body. The Responses→Chat request translator stashes reasoning
 * `encrypted_content` on assistant messages so a later openai→responses
 * round-trip can restore the store=false continuity blob; that stash must
 * never reach an upstream provider. Chat-native proxies reject the unknown
 * assistant-message field and answer every turn with a literal "400" body
 * (observed with multi-turn Codex sessions via OpenAI-compatible nodes).
 */
export function stripContinuityFields(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  for (const msg of body.messages) {
    if (msg && typeof msg === "object") {
      delete msg.encrypted_content;
      delete msg.reasoning_encrypted_content;
    }
  }
  return body;
}

export async function handleChatCore({ traceAttempt = null, body, modelInfo, credentials, log, onCredentialsRefreshed, onRequestSuccess, onDisconnect, clientRawRequest, connectionId, userAgent, apiKey, ccFilterNaming, rtkEnabled, headroomEnabled, headroomUrl, headroomCompressUserMessages, headroomTimeoutMs, cavemanEnabled, cavemanLevel, ponytailEnabled, ponytailLevel, customPromptEnabled, customPrompt, pxpipeEnabled, pxpipeMinChars, pxpipeTimeoutMs, pxpipeTransform, pxpipeUnavailableReason, onPxpipeEvent, sourceFormatOverride, providerThinking, providerOverrides, clientSignal = null }) {
  const { provider, model } = modelInfo;
  const requestStartTime = Date.now();
  // Stable per-session color so all lines of one CLI conversation share a tag
  const sessionSeed = (() => {
    try {
      return resolveSessionId({ headers: clientRawRequest?.headers, body, connectionId, scope: provider });
    } catch {
      return connectionId || "";
    }
  })();
  const reqTag = log?.tagForSession ? log.tagForSession(sessionSeed) : (log?.nextTag ? log.nextTag() : "");

  const sourceFormat = sourceFormatOverride || detectFormat(body);

  // Check for bypass patterns (warmup, skip, cc naming)
  const bypassResponse = handleBypassRequest(body, model, userAgent, ccFilterNaming);
  if (bypassResponse) return bypassResponse;

  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const modelTargetFormat = getModelTargetFormat(alias, model);
  // Multi-endpoint providers: pick transport matching sourceFormat → zero translation.
  // Per-model guard: only use the transport when the model declares support for that
  // sourceFormat — opencode-go models differ in endpoint support (kimi/glm only do
  // /chat/completions), so without this guard a claude-format request would wrongly
  // route kimi to /messages.
  const modelSupportedFormats = getModelSupportedFormats(alias, model);
  const runtimeTransport = resolveTransport(provider, sourceFormat);
  // Per-model guard: when a model declares supportedFormats, only use the
  // sourceFormat-matched transport if that format is declared (opencode-go models
  // differ — kimi/glm only do /chat/completions). Undeclared models keep the
  // upstream default (use the transport), preserving behavior for glm/deepseek/...
  // When the client's wire format is NOT among the model's supportedFormats, fall
  // back to the transport for the model's declared targetFormat so the URL always
  // matches the translated body. Without this, a Responses-only model (e.g. Muse
  // Spark: supportedFormats ["openai-responses"]) requested by an OpenAI client is
  // translated to the Responses body (`input`) yet POSTed to the default Chat
  // Completions URL, and upstream rejects it: "unknown parameter `input`".
  const modelTargetTransport = modelTargetFormat ? resolveTransport(provider, modelTargetFormat) : null;
  const useTransport = (!modelSupportedFormats || modelSupportedFormats.includes(sourceFormat))
    ? runtimeTransport
    : modelTargetTransport;
  // A source-format-matched endpoint keeps the request lossless. Prefer it
  // over a model-level targetFormat, which is only the fallback for clients
  // whose wire format has no supported transport (for example MiniMax-M3:
  // OpenAI clients should stay on /chat/completions; other clients can fall
  // back to its declared Claude target).
  const targetFormat = useTransport?.format || modelTargetFormat || getTargetFormat(provider, credentials);
  if (useTransport && credentials) credentials.runtimeTransport = useTransport;
  const stripList = getModelStrip(alias, model);

  // Inject provider-level thinking config override (only if client hasn't set)
  // on/off → extended type (body.thinking), none/low/medium/high → effort type (body.reasoning_effort)
  if (providerThinking?.mode && providerThinking.mode !== "auto") {
    const mode = providerThinking.mode;
    if (mode === "on" && !body.thinking) {
      console.log("Injecting provider-level thinking config override: on");
      body = { ...body, thinking: { type: "enabled", budget_tokens: 10000 } };
    } else if (mode === "off" && !body.thinking) {
      body = { ...body, thinking: { type: "disabled" } };
    } else if (!body.reasoning_effort) {
      body = { ...body, reasoning_effort: mode };
    }
  }

  const upstreamModel = getModelUpstreamId(alias, model, body);

  // Per-request opt-out: client can bypass all token savers via header
  const tokenSaverHeader =
    clientRawRequest?.headers?.[TOKEN_SAVER_HEADER] ?? clientRawRequest?.headers?.[LEGACY_TOKEN_SAVER_HEADER];
  const tokenSaverEnabled = tokenSaverHeader?.toLowerCase() !== "off";

  // Cursor's translator rewrites tool_result into user text, so RTK must run on
  // the source body before translation. Every other pair translates the tool
  // shapes 1:1 — keep the post-translate pass there so those providers are
  // untouched (and a retry never re-compresses an already-compressed body).
  const preTranslateRtk = provider === "cursor"
    ? compressMessages(body, tokenSaverEnabled && rtkEnabled)
    : null;
  const preTranslateRtkLine = formatRtkLog(preTranslateRtk);
  if (preTranslateRtkLine) console.log(preTranslateRtkLine);

  // Client intent, per source format. OpenAI Chat Completions, Claude Messages
  // and the Responses API all default to a JSON (non-streaming) response when
  // `stream` is absent; Gemini-family wires stream by endpoint, not body field.
  const clientRequestedStreaming = resolveClientStreamIntent(body, sourceFormat, clientRawRequest?.headers);
  const providerRequiresStreaming = PROVIDERS[provider]?.forceStream === true;
  let stream = providerRequiresStreaming ? true : clientRequestedStreaming;

  // Image generation models require non-streaming (Google v1internal:generateContent)
  const modelType = getModelType(alias, model);
  const isImageGenModel = modelType === "imageGen" || /image|imagen|image-generation/i.test(model);
  if (isImageGenModel && (provider === "antigravity" || provider === "gemini-cli")) {
    stream = false;
  }

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  // Only force non-streaming when client didn't explicitly request it.
  const detectedTool = detectClientTool(clientRawRequest?.headers || {}, body);
  if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false;

  // Check client Accept header preference for non-streaming requests
  // This fixes AI SDK compatibility where clients send Accept: application/json
  const acceptHeader = clientRawRequest?.headers?.accept || "";
  const clientPrefersJson = acceptHeader.includes("application/json");
  const clientPrefersSSE = acceptHeader.includes("text/event-stream");
  if (clientPrefersJson && !clientPrefersSSE && body.stream !== true && !providerRequiresStreaming) {
    stream = false;
  }

  // Credentials this request carries (read live: a token refresh mutates `credentials`).
  // Redacted by value from logs, error messages and stored errors, since some upstreams
  // echo the key back in their error body.
  const requestSecrets = () => knownSecrets(credentials, apiKey);
  const redact = (text) => maskString(redactValues(text, requestSecrets()));
  const reqLogger = await createRequestLogger(sourceFormat, targetFormat, model, requestSecrets);
  if (clientRawRequest) reqLogger.logClientRawRequest(clientRawRequest.endpoint, clientRawRequest.body, clientRawRequest.headers);
  reqLogger.logRawRequest(body);
  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Native passthrough: CLI tool and provider are the same ecosystem
  // Skip all translation/normalization — only model and Bearer are swapped
  const clientTool = detectClientTool(clientRawRequest?.headers || {}, body);
  const passthrough = isNativePassthrough(clientTool, provider);
  annotateAttempt(traceAttempt, { sourceFormat, targetFormat, stream, passthrough, upstreamModel: stripThinkingSuffix(upstreamModel) });

  // Expose raw client headers to translators/executors for session-id resolution
  if (credentials) credentials.rawHeaders = clientRawRequest?.headers || {};

  // Auto-strip media blocks the model can't read (vision/audio/pdf) before translation.
  if (!passthrough) {
    const caps = getCapabilitiesForModel(provider, model);
    if (stripUnsupportedModalities(body, sourceFormat, caps)) {
      log?.debug?.("MODALITY", `stripped unsupported media for ${provider}/${model}`);
    }
    // Convert remote image URLs to base64 for targets that can't fetch URLs.
    try {
      const n = await prefetchRemoteImages(body, sourceFormat, targetFormat, { signal: undefined });
      if (n > 0) log?.debug?.("MODALITY", `prefetched ${n} remote image(s) for ${targetFormat}`);
    } catch (e) { log?.warn?.("MODALITY", `image prefetch failed: ${e.message}`); }
  }

  let translatedBody;
  let toolNameMap;
  let customToolNames;
  if (passthrough) {
    log?.debug?.("PASSTHROUGH", `${clientTool} → ${provider} | native lossless`);
    translatedBody = { ...body, model: stripThinkingSuffix(upstreamModel) };
    if (provider === "codex") {
      const suffixThinking = {};
      applyThinking(sourceFormat, upstreamModel, suffixThinking, provider);
      if (suffixThinking.reasoning_effort) {
        const reasoning = translatedBody.reasoning;
        translatedBody.reasoning = {
          ...(reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? reasoning : {}),
          effort: suffixThinking.reasoning_effort,
        };
        delete translatedBody.reasoning_effort;
      }
    }
    // Normalize newer Cowork/CC beta shapes (adaptive thinking, mid-conversation system) the API rejects
    if (clientTool === "claude") normalizeClaudePassthrough(translatedBody, translatedBody.model);
  } else {
    translatedBody = translateRequest(sourceFormat, targetFormat, upstreamModel, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool);
    if (!translatedBody) {
      trackPendingRequest(model, provider, connectionId, false, true);
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Failed to translate request for ${sourceFormat} → ${targetFormat}`);
    }
    toolNameMap = translatedBody._toolNameMap;
    delete translatedBody._toolNameMap;
    customToolNames = translatedBody._customToolNames;
    delete translatedBody._customToolNames;
    translatedBody.model = stripThinkingSuffix(upstreamModel);
    stripContinuityFields(translatedBody);
  }

  // Same-format translation can hand back the client body itself; the stream
  // fields below are per-attempt, so never write them into the client body
  // (the account/combo fallback loop re-sends it to other providers).
  if (translatedBody === body) translatedBody = { ...body };
  syncUpstreamStreamFlag(translatedBody, passthrough ? sourceFormat : targetFormat, stream);

  // Real streaming usage instead of an estimate (OpenAI-format upstreams).
  const streamUsageInjected = requestStreamUsage(translatedBody, provider, passthrough ? sourceFormat : targetFormat, stream, credentials);

  // Tool normalization: MCP-equivalent built-in dedup (Claude clients) + same-name
  // dedup for DeepSeek models (upstream rejects duplicate tool names on all endpoints).
  if (Array.isArray(translatedBody.tools)) {
    const { tools: deduped, stripped } = dedupeTools(translatedBody.tools, { clientTool, model, messages: translatedBody.messages });
    if (stripped.length > 0) {
      translatedBody.tools = deduped;
      log?.debug?.("TOOLDEDUP", `stripped ${stripped.length}: ${stripped.slice(0, 3).join(", ")}${stripped.length > 3 ? "..." : ""}`);
    }
  }

  // Token savers: applied at the final body just before dispatch
  // Covers both passthrough (source shape) and translated (target shape) flows
  const finalFormat = passthrough ? sourceFormat : targetFormat;

  // Request line: one correlated summary (fmt + thinking + counts + account)
  if (log?.line) {
    const clientModel = clientRawRequest?.body?.model || `${provider}/${model}`;
    const msgN = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || body.messages?.length || body.input?.length || 0;
    const toolN = translatedBody.tools?.length || body.tools?.length || 0;
    const fmtStr = passthrough ? `FMT: ${sourceFormat} (passthrough)` : `FMT: ${sourceFormat}→${targetFormat}`;
    const showThinking = provider !== "grok-cli" || supportsGrokCliReasoningEffort(model);
    const think = showThinking ? log.fmtThink?.(extractThinking(translatedBody)) : null;
    const acc = credentials?.connectionName || credentials?.connectionId?.slice(0, 8) || "-";
    const parts = [
      `POST ${clientModel} → ${provider}/${model}`,
      fmtStr,
      stream ? "STREAM" : "JSON",
      `${msgN} MSG`,
    ];
    if (toolN) parts.push(`${toolN} TOOL`);
    if (think) parts.push(`THINK:${think}`);
    parts.push(`ACC:${acc}`);
    const clientIp = clientIpFromHeaders(clientRawRequest?.headers);
    if (clientIp) parts.push(`IP:${clientIp}`);
    log.line(reqTag, "▶", parts.join(" · "));
  }

  // TTS models don't support tool messages/function calling
  if (getModelType(alias, model) === "tts" && translatedBody.messages) {
    translatedBody.messages = translatedBody.messages.filter(msg => msg.role !== "tool");
    delete translatedBody.tools;
  }

  // Claude tool schema requires `type` to be explicitly set; strict gateways (e.g., MiniMax)
  // reject legacy payloads that omit it with HTTP 400. Default to "custom" when missing.
  // Provider-scoped via quirks (shouldDefaultClaudeToolType): only gateways that declare
  // requireClaudeToolType get the explicit type. Applying it unconditionally breaks
  // Claude-format endpoints that only accept the legacy typeless tool shape — DeepSeek's
  // Anthropic-compatible endpoint 400s with "unknown variant `custom`" (#3905).
  if (shouldDefaultClaudeToolType(provider, finalFormat, translatedBody.tools, PROVIDERS)) {
    translatedBody.tools = defaultClaudeToolType(translatedBody.tools);
  }

  // RTK: compress tool_result content. Skipped when already done pre-translate.
  const rtkStats = preTranslateRtk || compressMessages(translatedBody, tokenSaverEnabled && rtkEnabled);

  // Headroom: optional external proxy compression; fail open if proxy is absent.
  const headroomDiagnostics = {};
  const headroomStats = await compressWithHeadroom(translatedBody, { enabled: tokenSaverEnabled && headroomEnabled, url: headroomUrl, model: upstreamModel, format: finalFormat, compressUserMessages: headroomCompressUserMessages, timeoutMs: headroomTimeoutMs, diagnostics: headroomDiagnostics });
  const headroomLine = formatHeadroomLog(headroomStats);
  const headroomSizeLine = formatHeadroomSizeLog(headroomDiagnostics);
  if (headroomLine) {
    log?.info?.("HEADROOM", `${headroomLine}${headroomSizeLine ? ` | ${headroomSizeLine}` : ""}`);
    if (isHeadroomPhantomSavings(headroomStats, headroomDiagnostics)) {
      log?.warn?.("HEADROOM", `reported token delta, but messages and outbound JSON shrank <5% | ${formatHeadroomSizeLog(headroomDiagnostics)}`);
    }
  } else if (tokenSaverEnabled && headroomEnabled) log?.warn?.("HEADROOM", `skipped: ${headroomDiagnostics.reason || "compression unavailable"}${headroomDiagnostics.endpoint ? ` (${headroomDiagnostics.endpoint})` : ""}`);

  // Token-saver flags accumulator for the single "⚙" log line below.
  const xf = [];

  if (rtkStats?.hits?.length) xf.push(`RTK:${rtkStats.hits.length}`);

  // Caveman: inject terse-style system prompt
  if (tokenSaverEnabled && cavemanEnabled && cavemanLevel) {
    injectCaveman(translatedBody, finalFormat, cavemanLevel);
    xf.push(`CAVEMAN:${cavemanLevel}`);
  }

  // Ponytail: inject lazy-senior-dev system prompt
  if (tokenSaverEnabled && ponytailEnabled && ponytailLevel) {
    injectPonytail(translatedBody, finalFormat, ponytailLevel);
    xf.push(`PONYTAIL:${ponytailLevel}`);
  }

  // Custom prompt: user-authored instruction, independent of the savers above
  if (customPromptEnabled && injectCustomPrompt(translatedBody, finalFormat, customPrompt)) {
    xf.push(`CUSTOMPROMPT:${customPrompt.trim().length}c`);
  }

  // PXPIPE: image bulky context (Claude-format bodies only), last saver before dispatch
  let pxpipeSummary = null;
  if (pxpipeEnabled) {
    const pxpipeResult = await compressWithPxpipe(translatedBody, {
      enabled: true, format: finalFormat, model: upstreamModel,
      minChars: pxpipeMinChars, timeoutMs: pxpipeTimeoutMs, transform: pxpipeTransform,
      unavailableReason: pxpipeUnavailableReason,
    });
    pxpipeSummary = pxpipeResult.summary;
    if (pxpipeResult.body) translatedBody = pxpipeResult.body;
    if (pxpipeSummary?.applied) xf.push(`PXPIPE:${pxpipeSummary.imageCount}img`);
    try { onPxpipeEvent?.({ provider, model, ...pxpipeSummary }); } catch { /* stats must not break requests */ }
  }

  if (xf.length && log?.line) log.line(reqTag, "⚙", xf.join(" · "));

  // Pin cache breakpoints to the final body — every saver above can reshape
  // system/tools/messages, and a stale anchor costs a full prefix rewrite.
  if (passthrough && clientTool === "claude") anchorClaudeCache(translatedBody);

  const executor = getExecutor(provider);
  trackPendingRequest(model, provider, connectionId, true);
  appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => { });

  const msgCount = translatedBody.messages?.length || translatedBody.input?.length || translatedBody.contents?.length || translatedBody.request?.contents?.length || 0;
  log?.debug?.("REQUEST", `${provider.toUpperCase()} | ${model} | ${msgCount} msgs`);

  const streamController = createStreamController({
    onDisconnect: (reason) => {
      trackPendingRequest(model, provider, connectionId, false);
      if (onDisconnect) onDisconnect(reason);
    },
    onError: () => trackPendingRequest(model, provider, connectionId, false),
    log, provider, model, reqTag
  });

  // Callers that fan out non-streaming calls (fusion panels) pass the client's signal so
  // a disconnect aborts the upstream call instead of letting it run to completion.
  if (clientSignal) {
    if (clientSignal.aborted) streamController.handleDisconnect("client_aborted");
    else clientSignal.addEventListener("abort", () => streamController.handleDisconnect("client_aborted"), { once: true });
  }

  const proxyOptions = {
    connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
    // Strict pools must never silently fall back to a direct connection —
    // honored on the Cursor AgentService h2 path and in proxyFetch (#4333).
    proxyPoolId: credentials?.providerSpecificData?.connectionProxyPoolId || null,
    strictProxy: credentials?.providerSpecificData?.strictProxy === true,
    tlsImpersonation: normalizeTlsImpersonation(credentials?.providerSpecificData?.tlsImpersonation),
  };

  if (proxyOptions.vercelRelayUrl) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | vercel-relay=${proxyOptions.vercelRelayUrl}`);
  } else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    let maskedProxyUrl = proxyOptions.connectionProxyUrl;
    try {
      const parsed = new URL(proxyOptions.connectionProxyUrl);
      const host = parsed.hostname || "";
      const port = parsed.port ? `:${parsed.port}` : "";
      const protocol = parsed.protocol || "http:";
      maskedProxyUrl = `${protocol}//${host}${port}`;
    } catch {
      // Keep raw if URL parsing fails
    }

    const poolId = credentials?.providerSpecificData?.connectionProxyPoolId || "none";
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | pool=${poolId} | url=${maskedProxyUrl}`);
  }

  if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionNoProxy) {
    const connectionName = credentials?.connectionName || credentials?.connectionId || "unknown";
    log?.debug?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${connectionName} | no_proxy=${proxyOptions.connectionNoProxy}`);
  }

  // Execute request
  let providerResponse, providerUrl, providerHeaders, finalBody;
  // Most executors return their registry format. Cursor AgentService is an
  // exception: it is decoded by the executor into OpenAI-compatible output.
  let providerResponseFormat = targetFormat;
  try {
    const result = await executor.execute({
      model,
      body: translatedBody,
      stream,
      credentials,
      providerSessionId: sessionSeed,
      clientTool,
      signal: streamController.signal,
      log,
      proxyOptions,
      providerOverrides,
    });
    providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = result.transformedBody;
    providerResponseFormat = result.responseFormat || targetFormat;
    const renamedToolNames = takeRenamedToolNames(translatedBody);
    if (renamedToolNames?.size) {
      toolNameMap = new Map([...(toolNameMap || []), ...renamedToolNames]);
    }
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
  } catch (error) {
    if (typeof error?.message === "string") error.message = redact(error.message);
    if (typeof error?.stack === "string") error.stack = redact(error.stack);
    trackPendingRequest(model, provider, connectionId, false, true);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${error.name === "AbortError" ? 499 : HTTP_STATUS.BAD_GATEWAY}` }).catch(() => { });
    recordRequestDetail(traceAttempt, buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream, clientRawRequest?.regentHeaders),
      providerRequest: translatedBody || null,
      response: { error: error.message || String(error), status: error.name === "AbortError" ? 499 : 502, thinking: null },
      pxpipe: pxpipeSummary,
      status: "error"
    })).catch(() => { });

    if (error.name === "AbortError") {
      streamController.handleError(error);
      return createErrorResult(499, "Request aborted");
    }
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    if (log?.errorLine) {
      log.errorLine(reqTag, "✗", `ERROR 502 · ${provider}/${model} · ${Date.now() - requestStartTime}ms\n    ${errMsg}${error.stack ? `\n    ${error.stack}` : ""}`);
    }
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // Handle 401/403 - try token refresh (skip for noAuth providers)
  if (!executor.noAuth && (providerResponse.status === HTTP_STATUS.UNAUTHORIZED || providerResponse.status === HTTP_STATUS.FORBIDDEN)) {
    try {
      // Mutate credentials after each successful refresh: rotating refresh_token
      // providers (xAI/grok-cli) issue a new RT on every refresh; without this,
      // refreshWithRetry's 2nd/3rd attempt reuses the already-consumed RT →
      // invalid_grant → auth_failed retryable=false.
      const newCredentials = await refreshWithRetry(async () => {
        // Same proxy as the upstream call (TLS impersonation stays on upstream calls only).
        const result = await refreshCredentialsWithProxy(executor, credentials, log, proxyOptions);
        if (result?.refreshToken && result.refreshToken !== credentials.refreshToken) {
          if (result.accessToken) credentials.accessToken = result.accessToken;
          credentials.refreshToken = result.refreshToken;
        }
        return result;
      }, 3, log);
      if (newCredentials?.accessToken || newCredentials?.copilotToken) {
        if (log?.line) log.line(reqTag, "🔑", `TOKEN REFRESHED · ${provider}/${model}`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          try { await onCredentialsRefreshed(newCredentials); } catch (e) { log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`); }
        }
        try {
          const retryResult = await executor.execute({
            model,
            body: translatedBody,
            stream,
            credentials,
            providerSessionId: sessionSeed,
            clientTool,
            signal: streamController.signal,
            log,
            proxyOptions,
            providerOverrides,
          });
          if (retryResult.response.ok) {
            providerResponse = retryResult.response;
            providerUrl = retryResult.url;
            providerResponseFormat = retryResult.responseFormat || targetFormat;
          }
        } catch { log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`); }
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (e) {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`);
    }
  }

  // We added stream_options.include_usage and a strict upstream rejected it:
  // remember that for this node and retry once without the field, so the
  // request behaves exactly as it did before the gateway asked for usage.
  if (streamUsageInjected && await isStreamUsageRejection(providerResponse)) {
    rememberStreamUsageRejected(provider, credentials);
    delete translatedBody.stream_options;
    log?.warn?.("STREAM", `${provider}/${model} rejected stream_options; retrying without it (remembered for this node)`);
    try {
      const retry = await executor.execute({
        model, body: translatedBody, stream, credentials, providerSessionId: sessionSeed, clientTool,
        signal: streamController.signal, log, proxyOptions, providerOverrides,
      });
      providerResponse = retry.response;
      providerUrl = retry.url;
      finalBody = retry.transformedBody;
      providerResponseFormat = retry.responseFormat || targetFormat;
    } catch (error) {
      if (typeof error?.message === "string") error.message = redact(error.message);
      trackPendingRequest(model, provider, connectionId, false, true);
      if (error.name === "AbortError") { streamController.handleError(error); return createErrorResult(499, "Request aborted"); }
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY));
    }
  }

  // Usage on an OpenAI passthrough stream is gateway-managed whether or not the
  // upstream accepted stream_options (a strict upstream rejects the field, and
  // some send the trailer unasked): hold the finish chunk for a usage trailer
  // ([DONE] or a bounded timer releases it) and forward the trailer only to a
  // client that asked for it.
  const streamUsage = {
    awaitTrailer: stream,
    dropTrailer: !clientRequestedStreamUsage(body),
  };

  // Provider returned error
  if (!providerResponse.ok) {
    trackPendingRequest(model, provider, connectionId, false, true);
    const parsed = await parseUpstreamError(providerResponse, executor);
    const { statusCode, resetsAtMs } = parsed;
    const message = redact(parsed.message);
    appendRequestLog({ model, provider, connectionId, status: `FAILED ${statusCode}` }).catch(() => { });
    recordRequestDetail(traceAttempt, buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream, clientRawRequest?.regentHeaders),
      providerRequest: finalBody || translatedBody || null,
      response: { error: message, status: statusCode, thinking: null },
      pxpipe: pxpipeSummary,
      status: "error"
    })).catch(() => { });

    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    if (log?.errorLine) {
      const urlStr = providerUrl ? `\n    URL: ${redact(providerUrl)}` : "";
      log.errorLine(reqTag, "✗", `ERROR ${statusCode} · ${provider}/${model} · ${Date.now() - requestStartTime}ms${urlStr}\n    ${errMsg}`);
    }
    reqLogger.logError(new Error(message), finalBody || translatedBody);
    return createErrorResult(statusCode, errMsg, resetsAtMs, upstreamResponseHeaders(providerResponse.headers));
  }

  const sharedCtx = { traceAttempt, provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, pxpipe: pxpipeSummary, reqTag, log };
  const appendLog = (extra) => appendRequestLog({ model, provider, connectionId, ...extra }).catch(() => { });
  const trackDone = () => trackPendingRequest(model, provider, connectionId, false);

  // Provider forced streaming but client wants JSON. The Responses wire always
  // streams upstream (openaiToOpenAIResponsesRequest pins stream:true), so a
  // non-stream OpenAI/native client behind a Responses upstream must also take
  // this path — handleForcedSSEToJson returns null when the body is not SSE.
  if (!clientRequestedStreaming && (providerRequiresStreaming || providerResponseFormat === FORMATS.OPENAI_RESPONSES)) {
    const result = await handleForcedSSEToJson({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, customToolNames, toolNameMap, trackDone, appendLog });
    if (result) { streamController.handleComplete(); return result; }
  }

  // Defensive: an upstream that ignores `stream` answers with a plain JSON body.
  // Piping that through the SSE transform parses no `data:` lines, records no
  // usage and labels JSON as text/event-stream — take the JSON path instead.
  let upstreamIsJson = false;
  if (stream) {
    const probed = await probeJsonUpstream(providerResponse);
    providerResponse = probed.response;
    upstreamIsJson = probed.isJson;
    if (upstreamIsJson) log?.debug?.("STREAM", `${provider}/${model} answered a streaming request with JSON; using the non-streaming path`);
  }

  // True non-streaming response
  if (!stream || upstreamIsJson) {
    const result = await handleNonStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, reqLogger, toolNameMap, customToolNames, trackDone, appendLog });
    streamController.handleComplete();
    // The client asked to stream: replay the JSON answer as SSE in its format.
    if (upstreamIsJson && clientRequestedStreaming) return replayJsonResultAsSSE(result, sourceFormat, providerResponse.headers, { includeUsage: clientRequestedStreamUsage(body) });
    return result;
  }

  // Streaming response
  const { onStreamComplete, streamDetailId } = buildOnStreamComplete({ ...sharedCtx });
  return handleStreamingResponse({ ...sharedCtx, providerResponse, sourceFormat, targetFormat: providerResponseFormat, userAgent, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, credentials, streamUsage });
}

// Source formats whose clients choose streaming with a `stream` body field
// (absent = false, per each API's contract).
const BODY_STREAM_FIELD_FORMATS = new Set([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]);

/**
 * Whether the client asked for a streamed response.
 * - Gemini-family wires (gemini, gemini-cli, antigravity) always stream here;
 *   the /v1beta route picks the action by URL and sets `stream` itself.
 * - Body-field formats: `stream: true` streams, `stream: false` does not, and
 *   an absent field means JSON, unless the client accepts only
 *   text/event-stream, which is an explicit request for SSE.
 */
export function resolveClientStreamIntent(body, sourceFormat, headers = {}) {
  if (sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI) return true;
  if (body?.stream === true) return true;
  if (body?.stream === false) return false;
  if (!BODY_STREAM_FIELD_FORMATS.has(sourceFormat)) return true;
  const accept = String(headers?.accept || "");
  return accept.includes("text/event-stream") && !accept.includes("application/json");
}

/**
 * Make the upstream body's `stream` field match the decided mode for wires
 * that carry it in the body. Without this, a request that omitted `stream` but
 * is forced to stream (provider forceStream) reaches the upstream without it,
 * and the upstream answers JSON while we wait for SSE. A non-streaming OpenAI
 * body also drops `stream_options`, which strict upstreams reject without stream.
 */
export function syncUpstreamStreamFlag(upstreamBody, upstreamFormat, stream) {
  if (!upstreamBody || typeof upstreamBody !== "object" || !BODY_STREAM_FIELD_FORMATS.has(upstreamFormat)) return upstreamBody;
  if (stream) {
    if (upstreamBody.stream !== true) upstreamBody.stream = true;
  } else if (upstreamFormat === FORMATS.OPENAI && upstreamBody.stream !== true) {
    delete upstreamBody.stream_options;
  }
  return upstreamBody;
}

/**
 * Detect a JSON body answering a streaming request. Only bodies labeled
 * application/json are inspected; SSE (or unlabeled) responses pass through
 * untouched. The first bytes decide: an SSE line (`data:`, `event:`, `:`...)
 * keeps streaming without buffering; a body starting with `{` is read whole
 * and kept as JSON only if it parses as one document (NDJSON does not).
 * Whatever was read is replayed, so the caller always gets a usable Response.
 */
export async function probeJsonUpstream(response) {
  const contentType = (response?.headers?.get?.("content-type") || "").toLowerCase();
  if (!response?.body || !contentType.includes("application/json") || contentType.includes("text/event-stream")) {
    return { response, isJson: false };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const peeked = [];
  let head = "";
  let done = false;
  while (!done && head.trim() === "") {
    const r = await reader.read();
    done = r.done;
    if (r.value) { peeked.push(r.value); head += decoder.decode(r.value, { stream: true }); }
  }
  const rebuild = (body) => new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });

  if (head.trimStart().startsWith("{")) {
    while (!done) {
      const r = await reader.read();
      done = r.done;
      if (r.value) { peeked.push(r.value); head += decoder.decode(r.value, { stream: true }); }
    }
    head += decoder.decode();
    try { JSON.parse(head); return { response: rebuild(head), isJson: true }; } catch { return { response: rebuild(head), isJson: false }; }
  }

  // Looks like a stream: replay the peeked bytes, then the rest, unbuffered.
  const replay = new ReadableStream({
    start(controller) { for (const chunk of peeked) controller.enqueue(chunk); if (done) controller.close(); },
    async pull(controller) {
      const r = await reader.read();
      if (r.done) controller.close(); else controller.enqueue(r.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { response: rebuild(replay), isJson: false };
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - Date.now() < bufferMs;
}
