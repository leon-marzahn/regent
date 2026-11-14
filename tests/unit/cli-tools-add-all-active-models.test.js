import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { buildModelGroups, collectModelValues, NO_AUTH_PROVIDER_IDS } from "@/shared/utils/selectableModels.js";
import { loadActiveModelValues } from "@/app/(dashboard)/dashboard/cli-tools/connect/activeModels";
import { initPiExtra, piBody } from "@/app/(dashboard)/dashboard/cli-tools/connect/piCaps";

// Regression: "+ Add All Active Models" on /dashboard/cli-tools/pi used to walk the
// static provider registry over connection rows only, so it dropped every model the
// picker could still offer — most visibly OpenCode Free (`oc`), a no-auth provider
// that never owns a connection row and whose usable ids come from /api/models/custom.
describe("buildModelGroups / collectModelValues for Add All Active Models", () => {
  it("includes a no-auth free provider that has no connection row", () => {
    expect(NO_AUTH_PROVIDER_IDS).toContain("opencode");

    const values = collectModelValues(
      buildModelGroups({
        connections: [],
        allConnections: [],
        modelAliases: {},
        customModels: [],
        disabledModels: {},
      })
    );

    // Static registry entries for OpenCode Free must survive with zero connections.
    // (jev-1.13-free is kind: "systemone", so the LLM view hides it — picker parity.)
    expect(values).toContain("oc/union-alpha");
    expect(values).toContain("oc/muse-spark-1.2-contributor-free");
    expect(values).not.toContain("oc/jev-1.13-free");
  });

  it("includes custom models registered under the provider alias", () => {
    const customModels = [
      { providerAlias: "oc", id: "big-pickle", type: "llm", name: "big-pickle" },
      { providerAlias: "oc", id: "glm-5.3-flash-free", type: "llm", name: "glm-5.3-flash-free" },
    ];

    const values = collectModelValues(
      buildModelGroups({ connections: [], allConnections: [], modelAliases: {}, customModels, disabledModels: {} })
    );

    expect(values).toContain("oc/big-pickle");
    expect(values).toContain("oc/glm-5.3-flash-free");
  });

  it("includes user aliases for a passthrough provider", () => {
    const values = collectModelValues(
      buildModelGroups({
        connections: [],
        allConnections: [],
        modelAliases: { "oc/beam-free": "oc/beam-free" },
        customModels: [],
        disabledModels: {},
      })
    );

    expect(values).toContain("oc/beam-free");
  });

  it("skips models disabled for the provider", () => {
    const values = collectModelValues(
      buildModelGroups({
        connections: [],
        allConnections: [],
        modelAliases: {},
        customModels: [{ providerAlias: "oc", id: "big-pickle", type: "llm" }],
        disabledModels: { oc: ["big-pickle", "union-alpha"] },
      })
    );

    expect(values).not.toContain("oc/big-pickle");
    expect(values).not.toContain("oc/union-alpha");
    expect(values).toContain("oc/muse-spark-1.2-contributor-free");
  });

  it("routes connections through their provider alias", () => {
    const values = collectModelValues(
      buildModelGroups({
        connections: [{ id: "c1", provider: "opencode", isActive: true }],
        allConnections: [{ id: "c1", provider: "opencode", isActive: true }],
        modelAliases: {},
        customModels: [],
        disabledModels: {},
      })
    );

    // No-auth providers are always offered, so assert the connection's own models
    // resolve under the routing alias rather than that they are the only entries.
    expect(values).toContain("oc/muse-spark-1.2-contributor-free");
    expect(values).toContain("oc/union-alpha");
    expect(values.filter((value) => value.startsWith("oc/")).length).toBeGreaterThan(1);
  });

  it("drops providers whose connections are all deactivated", () => {
    const values = collectModelValues(
      buildModelGroups({
        connections: [],
        allConnections: [{ id: "c1", provider: "gemini", isActive: false }],
        modelAliases: {},
        customModels: [],
        disabledModels: {},
      })
    );

    expect(values.some((value) => value.startsWith("gemini/"))).toBe(false);
  });

  it("returns unique values only", () => {
    const customModels = [
      { providerAlias: "oc", id: "jev-1.13-free", type: "llm" },
      { providerAlias: "oc", id: "jev-1.13-free", type: "llm" },
    ];
    const values = collectModelValues(
      buildModelGroups({ connections: [], allConnections: [], modelAliases: {}, customModels, disabledModels: {} })
    );

    expect(values.filter((value) => value === "oc/jev-1.13-free")).toHaveLength(1);
  });

  it("tolerates empty and missing inputs", () => {
    expect(collectModelValues(buildModelGroups())).toEqual(expect.any(Array));
    expect(collectModelValues({})).toEqual([]);
  });
});

// Our Pi page is the shared connect panel: "Add all active" calls loadActiveModelValues.
describe("loadActiveModelValues (connect panel's Add all active)", () => {
  const responses = (overrides = {}) => ({
    "/api/providers": { connections: [] },
    "/api/models/alias": { aliases: {} },
    "/api/models/custom": { models: [] },
    "/api/models/disabled": { disabled: {} },
    ...overrides,
  });
  const stubFetch = (map) => {
    const calls = [];
    vi.stubGlobal("fetch", async (url) => {
      calls.push(url);
      const body = map[url];
      return body === undefined
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => body };
    });
    return calls;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("resolves at click time from providers, aliases, custom and disabled models", async () => {
    const calls = stubFetch(responses({
      "/api/models/custom": { models: [{ providerAlias: "oc", id: "big-pickle", type: "llm" }] },
      "/api/models/disabled": { disabled: { oc: ["union-alpha"] } },
    }));
    const values = await loadActiveModelValues();
    expect(calls).toEqual(expect.arrayContaining(["/api/providers", "/api/models/alias", "/api/models/custom", "/api/models/disabled"]));
    // No connection rows at all: the no-auth provider is still offered.
    expect(values).toContain("oc/muse-spark-1.2-contributor-free");
    expect(values).toContain("oc/big-pickle");
    expect(values).not.toContain("oc/union-alpha");
  });

  it("reads live per-account catalogs for active connections only", async () => {
    const calls = stubFetch(responses({
      "/api/providers": { connections: [
        { id: "c1", provider: "cursor", isActive: true },
        { id: "c2", provider: "cursor", isActive: false },
      ] },
      "/api/providers/c1/models": { models: [{ id: "cursor-live-1", name: "Cursor Live" }] },
    }));
    const values = await loadActiveModelValues();
    expect(calls).toContain("/api/providers/c1/models");
    expect(calls).not.toContain("/api/providers/c2/models");
    // The live catalog replaces the static registry rows.
    expect(values.filter((v) => v.startsWith("cu/"))).toEqual(["cu/cursor-live-1"]);
  });

  it("survives failing endpoints", async () => {
    stubFetch({});
    await expect(loadActiveModelValues()).resolves.toEqual(expect.any(Array));
  });
});

describe("Pi body keeps per-model caps", () => {
  const base = { baseUrl: "http://localhost:20128/v1", apiKey: "", slots: {}, options: {}, scope: "" };

  it("sends picked caps and leaves unknown models to the route's merge", () => {
    const extra = initPiExtra({ modelCaps: { "cc/a": { contextWindow: 1000000, maxTokens: 128000 }, "cc/b": { contextWindow: 16384120000 } } });
    const body = piBody({ ...base, models: ["cc/a", "cc/b", "cc/new"], extra });
    expect(body.models).toEqual([
      { id: "cc/a", name: "cc/a", contextWindow: 1000000, maxTokens: 128000 },
      // Corrupt value from models.json falls back to the default instead of being written back.
      { id: "cc/b", name: "cc/b", contextWindow: 200000, maxTokens: 64000 },
      { id: "cc/new", name: "cc/new" },
    ]);
  });
});
