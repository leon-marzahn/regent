// Locks edge cases flagged in docs 11 §1/§4 that were only covered indirectly.
import { describe, it, expect } from "vite-plus/test";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { parseDataUri, encodeDataUri } from "../../open-sse/translator/concerns/image.js";

describe("normalizeClaudePassthrough — haiku adaptive thinking (docs 11 §1)", () => {
  it("downgrades adaptive thinking to enabled+budget for haiku models", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-haiku-4-5");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
  });

  it("keeps adaptive thinking for sonnet/opus", () => {
    const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-sonnet-4-6");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  // Folded into the neighbouring user turn (not hoisted into body.system) to keep the prefix cache stable.
  it("folds mid-conversation system messages into the neighbouring user turn", () => {
    const out = normalizeClaudePassthrough({
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "be brief" },
      ],
    });
    expect(out.system).toBeUndefined();
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "be brief" }] },
    ]);
  });
});

describe("parseDataUri / encodeDataUri (docs 11 §4)", () => {
  it("parses a base64 data uri", () => {
    expect(parseDataUri("data:image/png;base64,AAAB")).toEqual({ mimeType: "image/png", base64: "AAAB" });
  });

  it("tolerates newlines inside base64 payload", () => {
    expect(parseDataUri("data:image/jpeg;base64,AA\nBB")?.base64).toBe("AA\nBB");
  });

  it("returns null for http urls and non-strings", () => {
    expect(parseDataUri("https://x/y.png")).toBeNull();
    expect(parseDataUri(null)).toBeNull();
  });

  it("encode/parse roundtrip", () => {
    const uri = encodeDataUri("image/webp", "ZZZ");
    expect(parseDataUri(uri)).toEqual({ mimeType: "image/webp", base64: "ZZZ" });
  });

  it("corrects a mislabeled image mime from magic bytes (Tavo sends webp as jpeg)", () => {
    const webp = Buffer.from("RIFF\0\0\0\0WEBPVP8 ").toString("base64");
    expect(parseDataUri(`data:image/jpeg;base64,${webp}`)?.mimeType).toBe("image/webp");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");
    expect(parseDataUri(`data:image/png;base64,${jpeg}`)?.mimeType).toBe("image/jpeg");
  });
});
