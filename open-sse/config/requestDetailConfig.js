import { FORMATS } from "../translator/formats.js";

// Which body fields the Usage request detail keeps from the client's request.
// The detail is built from a snapshot of the client body in its own wire
// format, taken before translation; each format lists where it carries the
// prompt. Gemini-native /v1beta clients are converted to OpenAI before chatCore,
// so the Gemini entries only cover Gemini-shaped bodies sent to /v1/*.
// Only listed fields are stored: anything else in the body (unknown keys a
// client might put a key in) is dropped.

// Prompt/content fields per client wire format.
export const REQUEST_CONTENT_FIELDS = {
  [FORMATS.OPENAI]: ["messages", "input"], // Cursor CLI sends `input` to /v1/chat/completions
  [FORMATS.OPENAI_RESPONSES]: ["instructions", "input"],
  [FORMATS.CLAUDE]: ["system", "messages"],
  [FORMATS.GEMINI]: ["systemInstruction", "contents"],
  [FORMATS.GEMINI_CLI]: ["request"],
  [FORMATS.ANTIGRAVITY]: ["request"],
  [FORMATS.OLLAMA]: ["system", "messages", "prompt"],
};

// Generation/control parameters across those formats.
export const REQUEST_DETAIL_PARAMS = [
  "temperature",
  "top_p",
  "top_k",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "thinking",
  "output_config",
  "context_management",
  "reasoning",
  "reasoning_effort",
  "enable_thinking",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "stop",
  "stop_sequences",
  "tools",
  "tool_choice",
  "response_format",
  "text",
  "prediction",
  "store",
  "metadata",
  "n",
  "logprobs",
  "top_logprobs",
  "logit_bias",
  "user",
  "parallel_tool_calls",
  "previous_response_id",
  "include",
  "truncation",
  "service_tier",
  "generationConfig",
  "safetySettings",
  "toolConfig",
  "cachedContent",
];

// A body only carries its own format's fields, so the union is safe to read
// without knowing the source format.
export const REQUEST_DETAIL_FIELDS = [
  ...new Set([...Object.values(REQUEST_CONTENT_FIELDS).flat(), ...REQUEST_DETAIL_PARAMS]),
];
