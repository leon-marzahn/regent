import { FORMATS } from "../formats.js";
import { fromOpenAIFinish } from "./finishReason.js";
import { CLAUDE_BLOCK, MODEL_FALLBACK, RESPONSES_ITEM, ROLE } from "../schema/index.js";

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function openAICompletionToClaudeMessage(responseBody) {
  if (!responseBody?.choices?.[0]) return responseBody;
  const choice = responseBody.choices[0];
  const message = choice.message || {};
  const content = [];

  // `reasoning` (string) is the vendor alias some OpenAI-compatible upstreams use (SenseNova, OpenRouter).
  const reasoning = message.reasoning_content
    || message.provider_specific_fields?.reasoning_content
    || (typeof message.reasoning === "string" ? message.reasoning : "");
  if (reasoning || message.reasoning_signature) {
    content.push({
      type: CLAUDE_BLOCK.THINKING,
      thinking: reasoning,
      ...(message.reasoning_signature ? { signature: message.reasoning_signature } : {}),
    });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: CLAUDE_BLOCK.TEXT, text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    content.push({
      type: CLAUDE_BLOCK.TOOL_USE,
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseToolArguments(fn.arguments || toolCall.arguments),
    });
  }
  if (content.length === 0) content.push({ type: CLAUDE_BLOCK.TEXT, text: "" });

  const usage = responseBody.usage || {};
  return {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: RESPONSES_ITEM.MESSAGE,
    role: ROLE.ASSISTANT,
    model: responseBody.model || MODEL_FALLBACK,
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: claudeUsageFromOpenAI(usage),
  };
}

// Claude contract: input_tokens EXCLUDES cache read/creation (clients sum all three).
// OpenAI prompt_tokens includes cache, so subtract it; an already Claude-shaped
// input_tokens is passed through as is.
function claudeUsageFromOpenAI(usage) {
  const cacheRead = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  const cacheCreation = usage.cache_creation_input_tokens ?? usage.prompt_tokens_details?.cache_creation_tokens;
  const inputTokens = usage.prompt_tokens != null
    ? Math.max(0, usage.prompt_tokens - (cacheRead || 0) - (cacheCreation || 0))
    : usage.input_tokens || 0;
  return {
    input_tokens: inputTokens,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    ...(typeof cacheRead === "number" ? { cache_read_input_tokens: cacheRead } : {}),
    ...(typeof cacheCreation === "number" ? { cache_creation_input_tokens: cacheCreation } : {}),
  };
}
