import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { PROVIDERS } from "../config/providers.js";
import { liftReasoningAliases } from "../translator/concerns/reasoning.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE, ensureStreamToolCallIds } from "./streamHelpers.js";
import { restoreToolNames } from "./opencodeFingerprint.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";
import { clientRequestedStreamUsage } from "../translator/concerns/streamUsage.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

// Upper bound on the deferred response.completed wait: a chat->responses stream
// that saw finish_reason without usage must not hold the client's terminal event
// forever when the upstream stalls with no usage trailer and no [DONE].
const PENDING_COMPLETION_FLUSH_MS = 3000;

// The Chat→Responses translator puts the upstream's real usage on
// response.completed. Like every other client format, the copy sent to the
// client gets the context-window buffer (see BUFFER_TOKENS); recorded usage is
// taken from the upstream chunks and stays real.
function withClientUsageBuffer(item) {
  if (item?.event !== "response.completed" || !item.data?.response?.usage) return item;
  return { ...item, data: { ...item.data, response: { ...item.data.response, usage: addBufferToUsage(item.data.response.usage) } } };
}

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    customToolNames = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    credentials = null,
    // Passthrough only. awaitTrailer: the upstream was asked for
    // stream_options.include_usage, so real usage arrives in a `choices: []`
    // chunk after the finish chunk; hold the finish chunk until then.
    // dropTrailer: the gateway (not the client) asked for it, so the
    // usage-only chunk is not forwarded.
    streamUsage = null
  } = options;

  let buffer = "";
  let usage = null;
  // True while `usage` (or state.usage) holds a length-based estimate: real
  // upstream usage arriving later replaces it instead of max-merging with it.
  let usageEstimated = false;
  // Finish chunks (one per choice index when n>1) held for the usage trailer.
  let heldFinish = null;
  let heldFinishTimer = null;
  const awaitUsageTrailer = mode === STREAM_MODE.PASSTHROUGH && streamUsage?.awaitTrailer === true;
  const dropUsageTrailer = awaitUsageTrailer && streamUsage?.dropTrailer === true;

  // Tool-call ids already sent to the client, keyed by the tool-call index.
  // A late fragment that opens a NEW index without an id must not reach the
  // client as-is: strict OpenAI-compatible SDKs abort the turn on a
  // tool_call without a string id (#4992).
  const seenToolCallIds = new Map();

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE
    ? { ...initState(sourceFormat), provider, toolNameMap, customToolNames: new Set(customToolNames || []), model, sessionId: credentials?._clientSessionId || null,
        // Which upstream format this stream came from. A response translator can be
        // reached either directly (target === its registered source) or as the second
        // hop of a pivot, and on the terminal null chunk the pivot drops it — so a
        // translator that defers closing events until flush needs to know which case
        // it is in. Absent/undefined means "unknown", i.e. do not defer.
        targetFormat }
    : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush
  let finalized = false;
  let completionFlushTimer = null;

  // Translate mode, Claude client behind an OpenAI chat upstream: the upstream's
  // finish chunk comes before its include_usage trailer, so message_delta (and
  // everything after it) is held until real usage arrives, [DONE], the end of
  // the stream, or PENDING_COMPLETION_FLUSH_MS — whichever is first. Content
  // deltas before the finish are never held.
  const holdClaudeFinish = mode === STREAM_MODE.TRANSLATE && sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.OPENAI;
  let heldTail = null;
  let heldTailTimer = null;
  // Translate mode, OpenAI chat client: the stream must end with data: [DONE],
  // preceded by the usage-only trailer when the client asked for it.
  const endsWithOpenAIDone = mode === STREAM_MODE.TRANSLATE && sourceFormat === FORMATS.OPENAI;
  const clientWantsUsageTrailer = endsWithOpenAIDone && clientRequestedStreamUsage(body);
  let openAIChunkBase = null;
  let openAIDoneSent = false;

  // Lane quirk: upstream streams thinking under the OpenRouter aliases
  // (`reasoning` / `reasoning_details[]`) instead of reasoning_content — OpenCode
  // Free's MiMo route does. Lift it on every passthrough delta so OpenAI-shaped
  // clients, the thinking accumulation below and usage accounting see the text.
  const liftAliases = mode === STREAM_MODE.PASSTHROUGH && !!PROVIDERS[provider]?.quirks?.reasoningAliasFields;

  // Usage/logging tail, callable from transform() as well as flush(): a client that
  // closes right after the terminal event cancels the reader, and flush() never runs.
  const finalizeStream = () => {
    if (completionFlushTimer) { clearTimeout(completionFlushTimer); completionFlushTimer = null; }
    if (finalized) return;
    finalized = true;

    const isPassthrough = mode === STREAM_MODE.PASSTHROUGH;
    let finalUsage = isPassthrough ? usage : state?.usage;

    if (!hasValidUsage(finalUsage) && totalContentLength > 0) {
      finalUsage = estimateUsage(body, totalContentLength, isPassthrough ? FORMATS.OPENAI : sourceFormat);
      if (isPassthrough) usage = finalUsage; else state.usage = finalUsage;
    }

    if (hasValidUsage(finalUsage)) {
      logUsage(isPassthrough ? provider : (state?.provider || targetFormat), finalUsage, model, connectionId, apiKey);
    } else {
      appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
    }

    if (onStreamComplete) {
      onStreamComplete({
        content: accumulatedContent,
        thinking: accumulatedThinking
      }, finalUsage, ttftAt);
    }
  };

  // Emit the deferred response.completed now — at [DONE], or when the watchdog
  // below gives up on a usage trailer that never arrives.
  const flushPendingCompletion = (controller) => {
    const completed = translateResponse(targetFormat, sourceFormat, null, state);
    for (const item of completed || []) {
      if (item === null || item === undefined) continue;
      const output = formatSSE(withClientUsageBuffer(item), sourceFormat);
      reqLogger?.appendConvertedChunk?.(output);
      controller.enqueue(sharedEncoder.encode(output));
      sseEmittedCount++;
    }
    finalizeStream();
  };

  // Translate mode: the client's finish chunk carries the real usage plus the
  // context buffer, or an estimate when the upstream sent none.
  const applyFinishUsage = (item) => {
    const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
    if (!state.finishReason || !isFinishChunk) return;
    if (!hasValidUsage(item.usage) && !hasValidUsage(state.usage) && totalContentLength > 0) {
      const estimated = estimateUsage(body, totalContentLength, sourceFormat);
      item.usage = filterUsageForFormat(addBufferToUsage(estimated), sourceFormat); // client copy gets the context buffer
      state.usage = estimated;
      usageEstimated = true;
    } else if (state.usage) {
      // Add buffer and filter usage for client (but keep original in state.usage for logging)
      item.usage = filterUsageForFormat(addBufferToUsage(state.usage), sourceFormat);
    }
  };

  const emitTranslated = (item, controller) => {
    if (endsWithOpenAIDone && item.object === "chat.completion.chunk" && !openAIChunkBase) {
      openAIChunkBase = { id: item.id, object: item.object, created: item.created, model: item.model };
    }
    const output = formatSSE(withClientUsageBuffer(item), sourceFormat);
    reqLogger?.appendConvertedChunk?.(output);
    controller.enqueue(sharedEncoder.encode(output));
    sseEmittedCount++;
  };

  const emitHeldTail = (controller) => {
    if (heldTailTimer) { clearTimeout(heldTailTimer); heldTailTimer = null; }
    if (!heldTail) return;
    const items = heldTail;
    heldTail = null;
    for (const item of items) {
      applyFinishUsage(item);
      emitTranslated(item, controller);
    }
  };

  const emitOpenAIDone = (controller) => {
    if (!endsWithOpenAIDone || openAIDoneSent) return;
    openAIDoneSent = true;
    let output = "";
    if (clientWantsUsageTrailer && hasValidUsage(state.usage) && !usageEstimated) {
      const base = openAIChunkBase || { object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
      output += formatSSE({ ...base, choices: [], usage: filterUsageForFormat(state.usage, FORMATS.OPENAI) }, FORMATS.OPENAI);
    }
    output += SSE_DONE;
    reqLogger?.appendConvertedChunk?.(output);
    controller.enqueue(sharedEncoder.encode(output));
  };

  // Passthrough: release a finish chunk held for the usage trailer, carrying
  // the real usage if it came, else an estimate (client copy gets the buffer).
  const emitHeldFinish = (controller) => {
    if (heldFinishTimer) { clearTimeout(heldFinishTimer); heldFinishTimer = null; }
    if (!heldFinish) return;
    const held = heldFinish;
    heldFinish = null;
    if (!hasValidUsage(usage)) {
      usage = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
      usageEstimated = true;
    }
    for (const parsed of held) {
      parsed.usage = filterUsageForFormat(addBufferToUsage(usage), FORMATS.OPENAI);
      const output = `data: ${JSON.stringify(parsed)}\n\n`;
      reqLogger?.appendConvertedChunk?.(output);
      controller.enqueue(sharedEncoder.encode(output));
    }
  };

  // The client went away: stop every pending timer and record usage now, once.
  const cancelPending = () => {
    if (heldFinishTimer) { clearTimeout(heldFinishTimer); heldFinishTimer = null; }
    if (heldTailTimer) { clearTimeout(heldTailTimer); heldTailTimer = null; }
    heldFinish = null;
    heldTail = null;
    if (finalized) return;
    trackPendingRequest(model, provider, connectionId, false);
    finalizeStream();
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          let output;
          let injectedUsage = false;
          let responsesTerminal = false;

          // Upstream already sent the sentinel; flush() must not append a second one.
          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() === "[DONE]") streamDoneSent = true;

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
            try {
              let parsed = JSON.parse(trimmed.slice(5).trim());

              const idFixed = fixInvalidId(parsed);

              // A fragment that opens a new tool-call index without an id breaks
              // strict OpenAI-compatible clients. Mint/reuse one before the
              // chunk reaches the client.
              const toolCallIdFixed = ensureStreamToolCallIds(parsed, seenToolCallIds);

              // The fingerprint pass renames a colliding caller tool to an alias
              // (read -> read_client). On this path nothing restored it, so the
              // client received a call to a tool it never declared and answered
              // "Model tried to call unavailable tool 'read_client'" (#4986).
              let toolNameRestored = false;
              if (toolNameMap?.size) {
                const restored = restoreToolNames(parsed, toolNameMap);
                if (restored !== parsed) {
                  parsed = restored;
                  toolNameRestored = true;
                }
              }

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;
              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              // Alias lanes: expose thinking as reasoning_content (additive) before
              // the valuable-content check, so reasoning-only chunks survive.
              if (liftAliases && parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice?.delta) {
                    const lifted = liftReasoningAliases(choice.delta);
                    if (lifted !== choice.delta) {
                      choice.delta = lifted;
                      fieldsInjected = true;
                    }
                  }
                }
              }

              // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
              // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in
              // every streaming delta. @ai-sdk/openai-compatible checks
              // `delta.tool_calls != null` — an empty array passes this check,
              // causing premature `reasoning-end` on every chunk.
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
                    delete choice.delta.tool_calls;
                    fieldsInjected = true;
                  }
                }
              }

              if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }

              const delta = parsed.choices?.[0]?.delta;
              const content = delta?.content;
              const reasoning = delta?.reasoning_content;
              if (content && typeof content === "string") {
                totalContentLength += content.length;
                accumulatedContent += content;
              }
              if (reasoning && typeof reasoning === "string") {
                totalContentLength += reasoning.length;
                accumulatedThinking += reasoning;
              }

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = usageEstimated ? extracted : mergeUsage(usage, extracted);
                usageEstimated = false;
              }

              // include_usage trailer: `choices: []` + usage, after the finish chunk.
              const isUsageTrailer = Array.isArray(parsed.choices) && parsed.choices.length === 0 && !!extracted;
              if (isUsageTrailer && heldFinish) emitHeldFinish(controller);
              if (isUsageTrailer && dropUsageTrailer) continue;

              responsesTerminal = isOpenAIResponsesTerminalEvent(currentOpenAIResponsesEvent, parsed);

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk && !hasValidUsage(parsed.usage) && awaitUsageTrailer) {
                // Content (or a tool-call delta) riding on the finish chunk goes out
                // now; only the empty finish waits for the trailer.
                const finishChoice = parsed.choices[0];
                if (finishChoice.delta && Object.keys(finishChoice.delta).length > 0) {
                  const contentNow = { ...parsed, choices: [{ ...finishChoice, finish_reason: null }] };
                  const contentOutput = `data: ${JSON.stringify(contentNow)}\n\n`;
                  reqLogger?.appendConvertedChunk?.(contentOutput);
                  controller.enqueue(sharedEncoder.encode(contentOutput));
                  parsed.choices = [{ ...finishChoice, delta: {} }];
                }
                (heldFinish ||= []).push(parsed);
                // Bounded wait: a stalled upstream must not delay finish_reason.
                // A trailer arriving later still replaces the recorded estimate.
                if (!heldFinishTimer) {
                  heldFinishTimer = setTimeout(() => {
                    heldFinishTimer = null;
                    try { emitHeldFinish(controller); } catch { /* controller already closed */ }
                  }, PENDING_COMPLETION_FLUSH_MS);
                }
                continue;
              } else if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(addBufferToUsage(estimated), FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                usageEstimated = true;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected || toolCallIdFixed || toolNameRestored) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch {
              // Skip non-JSON data lines silently — don't forward garbage to clients.
              // Upstream providers sometimes return plain-text errors (HTML, rate-limit
              // messages) in the SSE stream that would break downstream JSON decoders.
              continue;
            }
          }

          // [DONE] without a usage trailer: release the held finish chunk first.
          const isDoneLine = trimmed.startsWith("data:") && trimmed.slice(5).trim() === "[DONE]";
          if (isDoneLine) {
            emitHeldFinish(controller);
            // The upstream's own [DONE] goes out below; flush() must not add a second.
            streamDoneSent = true;
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          // Responses clients (codex CLI) close on response.completed instead of [DONE]
          if (responsesTerminal) finalizeStream();
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          // A direct Chat-to-Responses translation can defer response.completed
          // while waiting for a usage trailer. [DONE] ends that opportunity even
          // if the upstream keeps the HTTP connection open, so finish now.
          if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES &&
              state.completionPending && !state.completedSent) {
            flushPendingCompletion(controller);
          }
          emitHeldTail(controller);

          // Synthesize response.failed if the Responses stream never sent a terminal event
          if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            openAIResponsesTerminalSeen = true;
            sseEmittedCount++;
          }

          if (keepsOpenAIResponsesFormat && !streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }
          streamDoneSent = true;
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          continue;
        }

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - reasoning
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          totalContentLength += parsed.choices[0].delta.reasoning_content.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) {
          // Keep original usage for logging; a late real trailer replaces an estimate.
          state.usage = usageEstimated ? extracted : mergeUsage(state.usage, extracted);
          usageEstimated = false;
        }

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat);
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          // Responses clients (codex) close on response.completed instead of [DONE]
          if (openAIResponsesTerminalSeen) finalizeStream();
          continue;
        }

        currentOpenAIResponsesEvent = null;

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            if (item === null || item === undefined) continue;
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            if (heldTail) { heldTail.push(item); continue; }
            if (holdClaudeFinish && item.type === "message_delta" && state.finishReason && !hasValidUsage(state.usage)) {
              heldTail = [item];
              heldTailTimer = setTimeout(() => {
                heldTailTimer = null;
                try { emitHeldTail(controller); } catch { /* controller already closed */ }
              }, PENDING_COMPLETION_FLUSH_MS);
              continue;
            }

            applyFinishUsage(item);
            emitTranslated(item, controller);
          }
        }
        // Real usage arrived (the include_usage trailer): release the held finish.
        if (heldTail && extracted && hasValidUsage(state.usage)) emitHeldTail(controller);

        // The completion deferral can outlive the upstream: a broken chat upstream
        // may stall after finish_reason with no usage trailer and no [DONE], holding
        // the connection open. Bound the wait so the client still gets a terminal event.
        if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES &&
            state?.completionPending && !state?.completedSent && !completionFlushTimer) {
          completionFlushTimer = setTimeout(() => {
            completionFlushTimer = null;
            if (state?.completedSent) return;
            try { flushPendingCompletion(controller); } catch { /* controller already closed */ }
          }, PENDING_COMPLETION_FLUSH_MS);
        }
      }
    },

    // Client disconnect (pipeWithDisconnect cancels the reader): flush() never runs.
    cancel() {
      if (completionFlushTimer) { clearTimeout(completionFlushTimer); completionFlushTimer = null; }
      cancelPending();
    },

    flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          // A tail line without its newline may still be the usage trailer.
          if (heldFinish && buffer.trim().startsWith("data:")) {
            try {
              const tail = JSON.parse(buffer.trim().slice(5).trim());
              const extracted = Array.isArray(tail?.choices) && tail.choices.length === 0 ? extractUsage(tail) : null;
              if (extracted) {
                usage = usageEstimated ? extracted : mergeUsage(usage, extracted);
                usageEstimated = false;
                if (dropUsageTrailer) buffer = "";
              }
            } catch { /* not JSON ([DONE] or partial): leave it */ }
          }
          emitHeldFinish(controller);
          // An unterminated trailing "data: [DONE]" is the upstream sentinel: don't
          // forward it raw (it would glue onto the properly framed one appended
          // below, #5592).
          const tailLine = buffer.trim();
          const tailIsDone = tailLine.startsWith("data:") && tailLine.slice(5).trim() === "[DONE]";
          if (!tailIsDone && buffer) {
            let output = buffer;
            if (buffer.startsWith("data:") && !buffer.startsWith("data: ")) {
              output = "data: " + buffer.slice(5);
            }
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }

          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          // Gemini-family clients (Antigravity, Vertex, Gemini) reject this sentinel with 400 syntax errors.
          const isGeminiFamily = provider === "antigravity" || provider === "gemini" || provider === "vertex";
          if (!streamDoneSent && !isGeminiFamily) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }

          finalizeStream();
          return;
        }

        if (buffer.trim()) {
          // Same parse as the transform loop: without targetFormat this only
          // accepts "data: " lines, so an NDJSON provider (Ollama) lost whatever
          // arrived without its closing newline.
          const parsed = parseSSELine(buffer.trim(), targetFormat);
          // parseSSELine turns the SSE sentinel "data: [DONE]" into { done: true },
          // which must not be translated. An Ollama chunk also carries done:true,
          // but it is the real final chunk — it holds finish_reason and the token
          // counts — so it has to go through.
          const isDoneSentinel = parsed?.done && targetFormat !== FORMATS.OLLAMA;
          if (parsed && !isDoneSentinel) {
            // Same accumulation the transform loop does, so finalizeStream() can
            // log a tail chunk's tokens instead of falling back to null.
            const extracted = extractUsage(parsed);
            if (extracted) {
              state.usage = usageEstimated ? extracted : mergeUsage(state.usage, extracted);
              usageEstimated = false;
            }

            const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

            if (translated?._openaiIntermediate) {
              for (const item of translated._openaiIntermediate) {
                const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                reqLogger?.appendOpenAIChunk?.(openaiOutput);
              }
            }

            if (translated?.length > 0) {
              for (const item of translated) {
                if (item === null || item === undefined) continue;
                if (heldTail) { heldTail.push(item); continue; }
                const output = formatSSE(withClientUsageBuffer(item), sourceFormat);
                reqLogger?.appendConvertedChunk?.(output);
                controller.enqueue(sharedEncoder.encode(output));
              }
            }
          }
        }

        emitHeldTail(controller);
        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(withClientUsageBuffer(item), sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
        }

        if (keepsOpenAIResponsesFormat && !openAIResponsesDoneSent && !streamDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
          openAIResponsesDoneSent = true;
          streamDoneSent = true;
        }

        emitOpenAIDone(controller);
        finalizeStream();
      } catch (error) {
        console.log("Error in flush:", error);
        if (heldTailTimer) { clearTimeout(heldTailTimer); heldTailTimer = null; }
        finalizeStream();
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, customToolNames = null, credentials = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    customToolNames,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    credentials
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, streamUsage = null, toolNameMap = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    streamUsage
  });
}
