// OpenRouter: cache_control survives translation (prompt caching on Claude/Vertex), and a
// per-connection `provider` routing object is merged into every request.
import { describe, expect, it } from "vite-plus/test";
import {
  applyProviderRouting,
  normalizeProviderRouting,
  parseProviderSlugs,
} from "../../open-sse/config/providerRouting.js";
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
