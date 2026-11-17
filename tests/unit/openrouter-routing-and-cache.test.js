// OpenRouter: cache_control survives translation (prompt caching on Claude/Vertex), and a
// per-connection `provider` routing object is merged into every request.
import { describe, expect, it } from "vite-plus/test";
import {
  applyProviderRouting,
  normalizeProviderRouting,
  parseProviderSlugs,
  validateProviderRouting,
} from "../../open-sse/config/providerRouting.js";
import { anchorOpenAICache, filterToOpenAIFormat } from "../../open-sse/translator/formats/openai.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { AI_PROVIDERS } from "../../src/shared/constants/providers.js";

const ephemeral = { type: "ephemeral" };

function claudeBody() {
  return {
    model: "anthropic/claude-opus-5.5",
    max_tokens: 100,
    system: [
      { type: "text", text: "stable system prompt", cache_control: ephemeral },
      { type: "text", text: "second block" },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "earlier turn", cache_control: ephemeral }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "Reply with OK" }] },
    ],
  };
}

function cacheMarkers(body) {
  return JSON.stringify(body).split('"cache_control"').length - 1;
}

describe("OpenRouter keeps cache_control markers", () => {
  it("keeps the system and message markers of a Claude client", () => {
    const out = translateRequest("claude", "openai", "anthropic/claude-opus-5.5", claudeBody(), true, null, "openrouter");
    expect(cacheMarkers(out)).toBe(2);
    const system = out.messages.find((m) => m.role === "system");
    expect(system.content.some((p) => p.cache_control?.type === "ephemeral")).toBe(true);
    const firstUser = out.messages.find((m) => m.role === "user");
    expect(firstUser.content[0].cache_control).toEqual(ephemeral);
  });

  it("keeps them for an OpenAI client sending content parts", () => {
    const body = {
      model: "anthropic/claude-opus-5.5",
      messages: [
        { role: "system", content: [{ type: "text", text: "stable", cache_control: ephemeral }] },
        { role: "user", content: "hi" },
      ],
    };
    const out = translateRequest("openai", "openai", body.model, body, true, null, "openrouter");
    expect(out.messages[0].content[0].cache_control).toEqual(ephemeral);
  });

  it("still strips them for providers without the quirk", () => {
    const out = translateRequest("claude", "openai", "llama-3.3-70b", claudeBody(), true, null, "groq");
    expect(cacheMarkers(out)).toBe(0);
  });

  it("caps kept markers at 4, holding the system marker and the newest ones", () => {
    const part = (text) => ({ type: "text", text, cache_control: ephemeral });
    const body = {
      messages: [
        { role: "system", content: [part("system")] },
        ...["u1", "u2", "u3", "u4", "u5"].map((t) => ({ role: "user", content: [part(t)] })),
      ],
    };
    filterToOpenAIFormat(body, { preserveCacheControl: true });
    const kept = body.messages.filter((m) => m.content[0].cache_control).map((m) => m.content[0].text);
    expect(kept).toEqual(["system", "u3", "u4", "u5"]);
  });

  it("leaves 4 or fewer markers alone", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "a", cache_control: ephemeral }] }] };
    filterToOpenAIFormat(body, { preserveCacheControl: true });
    expect(body.messages[0].content[0].cache_control).toEqual(ephemeral);
  });
});

describe("OpenRouter adds cache breakpoints for Anthropic models when the client sends none", () => {
  const executor = new DefaultExecutor("openrouter");
  const send = (model, body) => executor.transformRequest(model, body, true, { apiKey: "sk-test" });
  const markedText = (body) => body.messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((p) => p.cache_control).map((p) => `${m.role}:${p.text ?? p.type}`) : []);

  it("marks the system prompt and the tail of a tool loop", () => {
    const body = {
      model: "anthropic/claude-opus-5.5",
      messages: [
        { role: "system", content: "stable rules" },
        { role: "user", content: "list /a" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "a.txt" },
      ],
    };
    const out = send("anthropic/claude-opus-5.5", body);
    expect(markedText(out)).toEqual(["system:stable rules", "tool:a.txt"]);
    expect(out.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0].content).toBe("stable rules");
  });

  it("skips a trailing turn that cannot carry a marker and uses the last part of array content", () => {
    const out = send("anthropic/claude-opus-5.5", {
      messages: [
        { role: "developer", content: [{ type: "text", text: "rules" }, { type: "text", text: "more rules" }] },
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:x" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      ],
    });
    expect(markedText(out)).toEqual(["developer:more rules", "user:image_url"]);
  });

  it("covers Claude clients using top-level cache_control and the Responses API", () => {
    const claude = translateRequest("claude", "openai", "anthropic/claude-opus-5.5",
      { model: "x", max_tokens: 10, cache_control: { type: "ephemeral" }, system: "rules", messages: [{ role: "user", content: "hi" }] },
      true, null, "openrouter");
    expect(markedText(send("anthropic/claude-opus-5.5", claude))).toEqual(["system:rules", "user:hi"]);

    const responses = translateRequest("openai-responses", "openai", "anthropic/claude-opus-5.5",
      { model: "x", instructions: "rules", input: "hi" }, true, null, "openrouter");
    expect(markedText(send("anthropic/claude-opus-5.5", responses)).length).toBe(2);
  });

  it("leaves the client's own markers alone", () => {
    const out = send("anthropic/claude-opus-5.5", translateRequest("claude", "openai", "anthropic/claude-opus-5.5", claudeBody(), true, null, "openrouter"));
    expect(markedText(out)).toEqual(["system:stable system prompt", "user:earlier turn"]);
  });

  it("does nothing for other models or providers", () => {
    const body = () => ({ messages: [{ role: "system", content: "rules" }, { role: "user", content: "hi" }] });
    expect(markedText(send("openai/gpt-5", body()))).toEqual([]);
    expect(markedText(new DefaultExecutor("groq").transformRequest("anthropic/claude-opus-5.5", body(), true, { apiKey: "k" }))).toEqual([]);
  });

  it("handles bodies with nothing to mark", () => {
    expect(anchorOpenAICache({ messages: [] })).toEqual({ messages: [] });
    expect(anchorOpenAICache({})).toEqual({});
    expect(markedText(anchorOpenAICache({ messages: [{ role: "user", content: "" }, { role: "system", content: "" }] }))).toEqual([]);
  });
});

describe("validateProviderRouting (writes)", () => {
  it("accepts valid input and normalizes it", () => {
    expect(validateProviderRouting({ only: "Google-Vertex/Global, anthropic", allow_fallbacks: false })).toEqual({
      routing: { only: ["google-vertex/global", "anthropic"], allow_fallbacks: false },
      errors: [],
    });
    expect(validateProviderRouting(null)).toEqual({ routing: null, errors: [] });
    expect(validateProviderRouting({ only: [], allow_fallbacks: null })).toEqual({ routing: null, errors: [] });
  });

  it("reports every problem instead of dropping it", () => {
    const cases = [
      ["anthropic", /must be an object/],
      [["anthropic"], /must be an object/],
      [{ only: ["google vertex"] }, /invalid provider slugs: google vertex/],
      [{ only: "google-vertex/global/x" }, /invalid provider slugs/],
      [{ order: 42 }, /invalid provider slugs: 42/],
      [{ only: ["anthropic"], allow_fallbacks: "false" }, /must be true or false/],
      [{ sort: "price" }, /Unknown routing field "sort"/],
      [{ ignore: Array.from({ length: 33 }, (_, i) => `p${i}`) }, /limit is 32/],
    ];
    for (const [value, message] of cases) {
      const { errors } = validateProviderRouting(value);
      expect(errors.join(" "), JSON.stringify(value)).toMatch(message);
    }
  });
});

describe("normalizeProviderRouting", () => {
  it("keeps valid slugs, lowercased and deduplicated, from arrays or strings", () => {
    expect(normalizeProviderRouting({
      only: ["Google-Vertex/Global", "google-vertex/global", "anthropic"],
      order: "amazon-bedrock/us-east-1, deepinfra/fp8\nazure",
      allow_fallbacks: false,
    })).toEqual({
      only: ["google-vertex/global", "anthropic"],
      order: ["amazon-bedrock/us-east-1", "deepinfra/fp8", "azure"],
      allow_fallbacks: false,
    });
  });

  it("drops anything that is not a plain slug", () => {
    expect(parseProviderSlugs([
      "../etc", "a/b/c", "has space", "", " ", "x".repeat(65), "-leading", "ok", 42, { only: "x" }, "q?x=1",
    ])).toEqual(["ok"]);
  });

  it("caps the list length", () => {
    const many = Array.from({ length: 50 }, (_, i) => `p${i}`);
    expect(parseProviderSlugs(many)).toHaveLength(32);
  });

  it("ignores unknown keys and non-boolean allow_fallbacks", () => {
    expect(normalizeProviderRouting({ only: ["anthropic"], allow_fallbacks: "false", sort: "price", __proto__: { x: 1 } }))
      .toEqual({ only: ["anthropic"] });
  });

  it("returns null when nothing usable is set", () => {
    for (const value of [null, undefined, "anthropic", ["anthropic"], {}, { only: [] }, { only: ["bad slug"] }]) {
      expect(normalizeProviderRouting(value)).toBeNull();
    }
  });
});

describe("applyProviderRouting", () => {
  const stored = { only: ["google-vertex/global"], allow_fallbacks: false };

  it("adds the routing to a body without one", () => {
    const body = { model: "m", messages: [] };
    const out = applyProviderRouting(body, stored);
    expect(out.provider).toEqual(stored);
    expect(body.provider).toBeUndefined();
  });

  it("lets the connection win on keys it sets and keeps the client's other keys", () => {
    const body = { provider: { only: ["anthropic"], sort: "price" } };
    expect(applyProviderRouting(body, stored).provider).toEqual({
      only: ["google-vertex/global"],
      allow_fallbacks: false,
      sort: "price",
    });
  });

  it("replaces a non-object client value and leaves the body alone without routing", () => {
    expect(applyProviderRouting({ provider: "anthropic" }, stored).provider).toEqual(stored);
    const body = { provider: { only: ["anthropic"] } };
    expect(applyProviderRouting(body, null)).toBe(body);
    expect(applyProviderRouting(body, { only: ["bad slug"] })).toBe(body);
  });
});

describe("DefaultExecutor applies the stored routing", () => {
  const credentials = { apiKey: "sk-test", providerSpecificData: { providerRouting: { only: ["google-vertex/global"] } } };
  const body = () => ({ model: "anthropic/claude-opus-5.5", messages: [{ role: "user", content: "hi" }], stream: true });

  it("merges it for OpenRouter", () => {
    const out = new DefaultExecutor("openrouter").transformRequest("anthropic/claude-opus-5.5", body(), true, credentials);
    expect(out.provider).toEqual({ only: ["google-vertex/global"] });
  });

  it("re-validates what is stored before sending it", () => {
    const tampered = { apiKey: "sk-test", providerSpecificData: { providerRouting: { only: ["evil slug", "anthropic"], extra: "x" } } };
    const out = new DefaultExecutor("openrouter").transformRequest("anthropic/claude-opus-5.5", body(), true, tampered);
    expect(out.provider).toEqual({ only: ["anthropic"] });
  });

  it("does nothing for providers without the quirk", () => {
    const out = new DefaultExecutor("groq").transformRequest("llama-3.3-70b", body(), true, credentials);
    expect(out.provider).toBeUndefined();
  });

  it("exposes the capability to the dashboard only for OpenRouter", () => {
    expect(AI_PROVIDERS.openrouter.providerRouting).toBe(true);
    expect(AI_PROVIDERS.groq?.providerRouting).toBeUndefined();
  });
});
