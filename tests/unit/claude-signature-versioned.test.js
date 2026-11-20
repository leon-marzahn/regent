// Current Claude models sign thinking in a versioned form: base64 of
// 0x08 <varint version> 0x12 …, so it starts with "C". The check only knew the
// older E/R forms, so every thinking block in a Claude Code history was dropped
// before reaching Anthropic, and after each tool call the model no longer saw its
// own earlier reasoning (it re-derived it). Built from bytes: a real signature
// wraps the user's encrypted reasoning and does not belong in the repo.
import { describe, it, expect } from "vite-plus/test";
import { isValidClaudeSignature } from "../../open-sse/utils/claudeSignature.js";
import { normalizeClaudePassthrough, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

const b64 = (...bytes) => Buffer.from([...bytes, ...Buffer.from("thinking-payload")]).toString("base64");
// 0x08 0x04 0x12 <len> 0x0a …: the shape every signature in a Claude Code transcript has.
const VERSIONED = b64(0x08, 0x04, 0x12, 0x93, 0x05, 0x0a, 0x10);
// Gemini thought signatures also start with "C" but open with field 1 as bytes (0x0a).
const GEMINI_LIKE = b64(0x0a, 0x24, 0x01, 0x8f);

describe("versioned (C-form) Claude thinking signatures", () => {
  it("accepts the versioned form, including a multi-byte version", () => {
    expect(VERSIONED[0]).toBe("C");
    expect(isValidClaudeSignature(VERSIONED)).toBe(true);
    expect(isValidClaudeSignature(b64(0x08, 0x96, 0x01, 0x12, 0x05))).toBe(true);
  });

  it("still rejects foreign signatures that start with C", () => {
    expect(GEMINI_LIKE[0]).toBe("C");
    expect(isValidClaudeSignature(GEMINI_LIKE)).toBe(false);
    expect(isValidClaudeSignature(b64(0x08, 0x04, 0x1a))).toBe(false);
    expect(isValidClaudeSignature("Cxyz")).toBe(false);
  });

  const thinking = { type: "thinking", thinking: "plan: read the file first", signature: VERSIONED };
  const history = () => ({
    model: "claude-opus-5-5",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ ...thinking }, { type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ],
  });

  it("keeps a versioned thinking block in a passthrough history", () => {
    expect(normalizeClaudePassthrough(history(), "claude-opus-5-5").messages[1].content[0]).toEqual(thinking);
  });

  it("keeps a versioned thinking block on the translated Claude path", () => {
    expect(prepareClaudeRequest(history(), "claude").messages[1].content[0]).toEqual(thinking);
  });
});
