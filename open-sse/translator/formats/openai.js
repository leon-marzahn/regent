// OpenAI helper functions for translator
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK, VALID_OPENAI_CONTENT_TYPES, VALID_OPENAI_MESSAGE_TYPES } from "../schema/index.js";

// Re-export valid-type lists (moved to schema/blocks.js) to keep existing importers working.
export { VALID_OPENAI_CONTENT_TYPES, VALID_OPENAI_MESSAGE_TYPES };

// Anthropic-backed upstreams (OpenRouter → Anthropic/Vertex/Bedrock) reject a request
// with more than 4 cache_control markers.
const MAX_CACHE_CONTROL_MARKERS = 4;

// Trim kept markers to the budget: the last marked system part is held (the stable
// prefix that makes caching worth it), the remaining slots go to the tail-most markers.
function capCacheControlParts(messages) {
  const marked = [];
  let head = null;
  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue;
    for (const part of msg.content) {
      if (!part?.cache_control) continue;
      marked.push(part);
      if (msg.role === ROLE.SYSTEM) head = part;
    }
  }
  if (marked.length <= MAX_CACHE_CONTROL_MARKERS) return;
  const rest = marked.filter((p) => p !== head);
  const keep = MAX_CACHE_CONTROL_MARKERS - (head ? 1 : 0);
  for (const part of rest.slice(0, rest.length - keep)) delete part.cache_control;
}

const CACHE_CONTROL_5M = { type: "ephemeral" };
const CACHEABLE_PART_TYPES = new Set([OPENAI_BLOCK.TEXT, OPENAI_BLOCK.IMAGE_URL]);

function hasCacheControl(messages) {
  return messages.some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.cache_control));
}

const isSystemRole = (msg) => msg?.role === ROLE.SYSTEM || msg?.role === ROLE.DEVELOPER;

// Copy of `msg` with a breakpoint on its last cacheable part (string content becomes one
// text part), or null when it has nothing that can carry one (e.g. an assistant turn that
// only holds tool_calls).
function withBreakpoint(msg, marker) {
  if (typeof msg?.content === "string") {
    if (!msg.content) return null;
    return { ...msg, content: [{ type: OPENAI_BLOCK.TEXT, text: msg.content, cache_control: { ...marker } }] };
  }
  if (!Array.isArray(msg?.content)) return null;
  for (let i = msg.content.length - 1; i >= 0; i--) {
    const part = msg.content[i];
    if (!CACHEABLE_PART_TYPES.has(part?.type) || (part.type === OPENAI_BLOCK.TEXT && !part.text)) continue;
    const content = [...msg.content];
    content[i] = { ...part, cache_control: { ...marker } };
    return { ...msg, content };
  }
  return null;
}

// A client's top-level cache_control (OpenRouter/Anthropic automatic caching) sets the TTL.
function breakpointFor(body) {
  const top = body?.cache_control;
  return top && typeof top === "object" && typeof top.ttl === "string" ? { ...CACHE_CONTROL_5M, ttl: top.ttl } : CACHE_CONTROL_5M;
}

// Prompt caching for clients that send no cache_control of their own (most OpenAI-format
// clients, the Responses API, Claude's top-level `cache_control`). Anthropic-backed
// upstreams behind an aggregator (OpenRouter -> Anthropic/Vertex/Bedrock) cache only up to
// explicit breakpoints, so without any every turn pays full input price. Up to two:
// - head: the last system message of the leading run (tools + system), the prefix every
//   request shares. A system message later in the conversation (a per-turn reminder) is
//   volatile and never marked;
// - tail: the last non-system message that can carry one, i.e. the conversation so far.
//   The next request extends it and Anthropic's lookback finds this breakpoint. Only once
//   an assistant turn exists: a one-shot request (title, summary, classify) would pay the
//   cache-write premium on a tail nothing ever reads back.
// A client that placed its own markers keeps them untouched. Returns a new body.
export function anchorOpenAICache(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || !messages.length || hasCacheControl(messages)) return body;
  // Markers on tools are the client's own caching too (and adding ours could pass the
  // 4-marker limit or put a longer TTL after a shorter one).
  if (Array.isArray(body.tools) && body.tools.some((t) => t?.cache_control)) return body;
  const marker = breakpointFor(body);
  const out = [...messages];
  let head = -1;
  while (head + 1 < out.length && isSystemRole(out[head + 1])) head++;
  if (head >= 0) out[head] = withBreakpoint(out[head], marker) ?? out[head];
  if (out.some((m) => m?.role === ROLE.ASSISTANT)) {
    for (let i = out.length - 1; i > head; i--) {
      if (isSystemRole(out[i])) continue;
      const marked = withBreakpoint(out[i], marker);
      if (marked) { out[i] = marked; break; }
    }
  }
  return { ...body, messages: out };
}

// Whether an upstream model id falls under one of the quirk's prefixes. OpenRouter ids
// may carry a `~` "latest" alias and are matched case-insensitively.
export function matchesModelPrefix(model, prefixes) {
  if (typeof model !== "string" || !Array.isArray(prefixes)) return false;
  const id = model.toLowerCase().replace(/^~/, "");
  return prefixes.some((p) => typeof p === "string" && id.startsWith(p.toLowerCase()));
}

// Filter messages to OpenAI standard format
// Remove: thinking, redacted_thinking, signature, and other non-OpenAI blocks
// opts.preserveCacheControl: keep cache_control on content blocks (e.g. for DashScope/alicode),
// capped at MAX_CACHE_CONTROL_MARKERS
export function filterToOpenAIFormat(body, opts = {}) {
  if (!body.messages || !Array.isArray(body.messages)) return body;
  const keepCache = !!opts.preserveCacheControl;

  function stripBlock(block) {
    const { signature, cache_control, ...rest } = block;
    return keepCache && cache_control ? { ...rest, cache_control } : rest;
  }

  body.messages = body.messages.map(msg => {
    // Normalize developer role to system (many providers don't support developer)
    if (msg.role === ROLE.DEVELOPER) msg = { ...msg, role: ROLE.SYSTEM };

    // Keep tool messages as-is (OpenAI format)
    if (msg.role === ROLE.TOOL) return msg;

    // Keep assistant messages with tool_calls as-is
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls) return msg;

    // Handle string content
    if (typeof msg.content === "string") return msg;

    // Handle array content
    if (Array.isArray(msg.content)) {
      const filteredContent = [];

      for (const block of msg.content) {
        // Skip thinking blocks
        if (block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING) continue;

        // Only keep valid OpenAI content types
        if (VALID_OPENAI_CONTENT_TYPES.includes(block.type)) {
          filteredContent.push(stripBlock(block));
        } else if (block.type === CLAUDE_BLOCK.TOOL_USE) {
          // Convert tool_use to tool_calls format (handled separately)
          continue;
        } else if (block.type === CLAUDE_BLOCK.TOOL_RESULT) {
          // Keep tool_result but clean it
          filteredContent.push(stripBlock(block));
        }
      }
      
      // If all content was filtered, add empty text
      if (filteredContent.length === 0) {
        filteredContent.push({ type: OPENAI_BLOCK.TEXT, text: "" });
      }
      
      return { ...msg, content: filteredContent };
    }
    
    return msg;
  });
  
  // Filter out messages with only empty text (but NEVER filter tool messages)
  body.messages = body.messages.filter(msg => {
    // Always keep tool messages
    if (msg.role === ROLE.TOOL) return true;
    // Always keep assistant messages with tool_calls
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls) return true;
    
    if (typeof msg.content === "string") return msg.content.trim() !== "";
    if (Array.isArray(msg.content)) {
      return msg.content.some(b => 
        (b.type === OPENAI_BLOCK.TEXT && b.text?.trim()) ||
        b.type !== OPENAI_BLOCK.TEXT
      );
    }
    return true;
  });

  if (keepCache) capCacheControlParts(body.messages);

  // Remove empty tools array (some providers like QWEN reject it)
  if (body.tools && Array.isArray(body.tools) && body.tools.length === 0) {
    delete body.tools;
  }

  // Normalize tools to OpenAI format (from Claude, Gemini, etc.)
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    body.tools = body.tools.map(tool => {
      // Already OpenAI format
      if (tool.type === OPENAI_BLOCK.FUNCTION && tool.function) return tool;
      
      // Claude format: {name, description, input_schema}
      if (tool.name && (tool.input_schema || tool.description)) {
        return {
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name: tool.name,
            description: String(tool.description || ""),
            parameters: tool.input_schema || { type: "object", properties: {} }
          }
        };
      }
      
      // Gemini format: {functionDeclarations: [{name, description, parameters}]}
      if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
        return tool.functionDeclarations.map(fn => ({
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name: fn.name,
            description: String(fn.description || ""),
            parameters: fn.parameters || { type: "object", properties: {} }
          }
        }));
      }
      
      return tool;
    }).flat();
  }

  // Normalize tool_choice to OpenAI format
  if (body.tool_choice && typeof body.tool_choice === "object") {
    const choice = body.tool_choice;
    // Claude format: {type: "auto|any|tool", name?: "..."}
    if (choice.type === "auto") {
      body.tool_choice = "auto";
    } else if (choice.type === "any") {
      body.tool_choice = "required";
    } else if (choice.type === "tool" && choice.name) {
      body.tool_choice = { type: OPENAI_BLOCK.FUNCTION, function: { name: choice.name } };
    }
  }

  return body;
}

