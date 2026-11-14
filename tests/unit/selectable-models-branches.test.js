import { describe, it, expect } from "vite-plus/test";
import { buildModelGroups, collectModelValues } from "@/shared/utils/selectableModels.js";

// Branch coverage for buildModelGroups beyond the Add-All-Active-Models cases:
// typed kinds on passthrough providers, compatible (custom) nodes, providers
// without a static catalog, and the per-connection enabledModels filter.
// Fake provider ids keep these independent of the real registry.

const PT = "fake-passthrough";
const PLAIN = "fake-plain";
const COMPAT = "openai-compatible-chat-test";

const providers = {
  [PT]: { name: "Fake Passthrough", color: "#111", passthroughModels: true, serviceKinds: ["llm", "tts"] },
  [PLAIN]: { name: "Fake Plain", color: "#222", serviceKinds: ["llm", "tts"] },
  [COMPAT]: { name: "Compat", color: "#333" },
};

const groupsFor = (input) => buildModelGroups({ providers, ...input });
// No-auth providers (e.g. OpenCode Free) are always present; look at one group.
const valuesOf = (groups, id) => collectModelValues({ [id]: groups[id] });

describe("buildModelGroups — passthrough providers with a typed kind", () => {
  it("returns registered models of that kind, not LLM aliases", () => {
    const groups = groupsFor({
      connections: [{ provider: PT }],
      kindFilter: "tts",
      modelAliases: { chat: `${PT}/chat-1` },
      customModels: [
        { providerAlias: PT, id: "voice-1", type: "tts" },
        { providerAlias: PT, id: "chat-2", type: "llm" },
      ],
    });
    expect(valuesOf(groups, PT)).toEqual([`${PT}/voice-1`]);
    expect(groups[PT].models[0]).toMatchObject({ id: "voice-1", kind: "tts", isCustom: true });
  });

  it("merges static typed models with registered ones without duplicates (venice images)", () => {
    const groups = buildModelGroups({
      connections: [{ provider: "venice" }],
      kindFilter: "image",
      customModels: [
        { providerAlias: "venice", id: "flux-2-pro", type: "image", name: "My Flux" },
        { providerAlias: "venice", id: "my-image", type: "image" },
      ],
    });
    const values = valuesOf(groups, "venice");
    expect(values.slice(0, 2)).toEqual(["venice/flux-2-pro", "venice/my-image"]);
    expect(values).toContain("venice/venice-sd35");
    expect(values.filter((v) => v === "venice/flux-2-pro")).toHaveLength(1);
    expect(values).not.toContain("venice/text-embedding-3-large");
    expect(values).not.toContain("venice/llama-3.3-70b");
    expect(groups.venice.models[0].name).toBe("My Flux");
  });

  it("falls back to provider-as-model when the provider supports the kind but has no models", () => {
    const groups = groupsFor({ connections: [{ provider: PT }], kindFilter: "tts" });
    expect(groups[PT].models).toEqual([{ id: PT, name: "Fake Passthrough", value: PT }]);
  });

  it("has no fallback when the provider does not support the kind", () => {
    const groups = groupsFor({ connections: [{ provider: PT }], kindFilter: "image" });
    expect(groups[PT]).toBeUndefined();
  });

  it("uses the provider node's display name when one matches", () => {
    const groups = groupsFor({
      connections: [{ provider: PT }],
      modelAliases: { chat: `${PT}/chat-1` },
      providerNodes: [{ id: PT, name: "Renamed Node" }],
    });
    expect(groups[PT].name).toBe("Renamed Node");
  });
});

describe("buildModelGroups — compatible (custom) providers", () => {
  it("routes aliases and registered models through the connection prefix", () => {
    const groups = groupsFor({
      connections: [{ provider: COMPAT, name: "My Relay", providerSpecificData: { prefix: "relay" } }],
      modelAliases: { glm: `${COMPAT}/glm-4.7` },
      customModels: [
        { providerAlias: COMPAT, id: "glm-4.7" }, // duplicate of the alias: deduped
        { providerAlias: COMPAT, id: "qwen-3", name: "Qwen 3" },
      ],
    });
    const group = groups[COMPAT];
    expect(group).toMatchObject({ name: "My Relay", alias: "relay", isCustom: true, hasModels: true });
    expect(valuesOf(groups, COMPAT)).toEqual(["relay/glm-4.7", "relay/qwen-3"]);
    expect(group.models[1]).toMatchObject({ name: "Qwen 3", isCustom: true });
  });

  it("shows a placeholder when the connected node has no models yet", () => {
    const groups = groupsFor({ connections: [{ provider: COMPAT }] });
    const group = groups[COMPAT];
    expect(group.hasModels).toBe(false);
    expect(group.alias).toBe(COMPAT);
    expect(group.models).toEqual([
      { id: `__placeholder__${COMPAT}`, name: `${COMPAT}/model-id`, value: `${COMPAT}/model-id`, isPlaceholder: true },
    ]);
  });

  it("prefers the provider node's name and prefix when no connection carries them", () => {
    const groups = groupsFor({
      connections: [],
      providerNodes: [{ id: COMPAT, name: "Local Ollama", prefix: "ollama" }],
      customModels: [{ providerAlias: COMPAT, id: "llama3" }],
    });
    expect(groups[COMPAT]).toMatchObject({ name: "Local Ollama", alias: "ollama" });
    expect(valuesOf(groups, COMPAT)).toEqual(["ollama/llama3"]);
  });

  it("is skipped for typed media kinds", () => {
    const groups = groupsFor({ connections: [{ provider: COMPAT }], kindFilter: "image" });
    expect(groups[COMPAT]).toBeUndefined();
  });
});

describe("buildModelGroups — providers without a static catalog", () => {
  it("shows every alias for the provider plus registered custom models", () => {
    const groups = groupsFor({
      connections: [{ provider: PLAIN }],
      modelAliases: { "my-name": `${PLAIN}/m1`, other: "elsewhere/m9" },
      customModels: [
        { providerAlias: PLAIN, id: "m2", name: "Model Two" },
        { providerAlias: PLAIN, id: "m1" }, // already an alias: not duplicated
      ],
    });
    expect(valuesOf(groups, PLAIN)).toEqual([`${PLAIN}/m1`, `${PLAIN}/m2`]);
    expect(groups[PLAIN].models[0]).toMatchObject({ id: "m1", name: "my-name", isCustom: true });
  });

  it("falls back to provider-as-model for a supported fallback kind", () => {
    const groups = groupsFor({ connections: [{ provider: PLAIN }], kindFilter: "tts" });
    expect(groups[PLAIN].models).toEqual([{ id: PLAIN, name: "Fake Plain", value: PLAIN }]);
  });

  it("never falls back for embedding (it always needs a model)", () => {
    const groups = groupsFor({ connections: [{ provider: PLAIN }], kindFilter: "embedding" });
    expect(groups[PLAIN]).toBeUndefined();
  });
});

describe("buildModelGroups — enabledModels on a connection", () => {
  const base = {
    modelAliases: { a: `${PLAIN}/a`, b: `${PLAIN}/b`, c: `${PLAIN}/c` },
  };

  it("keeps only the models a connection explicitly enables (by id or full value)", () => {
    const groups = groupsFor({
      ...base,
      connections: [
        { provider: PLAIN, providerSpecificData: { enabledModels: ["a"] } },
        { provider: PLAIN, providerSpecificData: { enabledModels: [`${PLAIN}/c`] } },
      ],
    });
    expect(valuesOf(groups, PLAIN)).toEqual([`${PLAIN}/a`, `${PLAIN}/c`]);
  });

  it("drops the group when nothing it offers is enabled", () => {
    const groups = groupsFor({
      ...base,
      connections: [{ provider: PLAIN, providerSpecificData: { enabledModels: ["zzz"] } }],
    });
    expect(groups[PLAIN]).toBeUndefined();
  });

  it("ignores an empty enabledModels list", () => {
    const groups = groupsFor({ ...base, connections: [{ provider: PLAIN, providerSpecificData: { enabledModels: [] } }] });
    expect(valuesOf(groups, PLAIN)).toHaveLength(3);
  });
});
