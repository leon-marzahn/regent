// A used-up Claude subscription window (5h / weekly) locks the whole account until
// Anthropic's reported reset, instead of a short per-model backoff that keeps retrying it.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");

const NOW = new Date("2026-11-20T12:00:00.000Z");
const IN_10_MIN = Math.floor(NOW.getTime() / 1000) + 600;

const rejected = (status, headers) => ({ status, headers: new Headers(headers) });
const limitHeaders = (reset = IN_10_MIN) => ({
  "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-reset": String(reset),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dbMocks.getProviderConnections.mockResolvedValue([{ id: "cc-a", provider: "claude", name: "cc-a" }]);
  return () => vi.useRealTimers();
});

describe("Claude parseError", () => {
  const claude = new DefaultExecutor("claude");

  it("reads the window reset from a rejected 429", () => {
    const parsed = claude.parseError(rejected(429, limitHeaders()), '{"error":{"message":"limit"}}');
    expect(parsed.resetsAtMs).toBe(IN_10_MIN * 1000);
    expect(parsed.status).toBe(429);
  });

  it("ignores a 429 that is not a rejected subscription window", () => {
    const headers = { ...limitHeaders(), "anthropic-ratelimit-unified-status": "allowed" };
    expect(claude.parseError(rejected(429, headers), "x").resetsAtMs).toBeUndefined();
  });

  it("ignores a missing, garbage or past reset", () => {
    for (const reset of ["", "soon", String(IN_10_MIN - 1200)]) {
      expect(claude.parseError(rejected(429, limitHeaders(reset)), "x").resetsAtMs).toBeUndefined();
    }
  });

  it("leaves other providers and statuses alone", () => {
    expect(new DefaultExecutor("openai").parseError(rejected(429, limitHeaders()), "x").resetsAtMs).toBeUndefined();
    expect(claude.parseError(rejected(500, limitHeaders()), "x").resetsAtMs).toBeUndefined();
  });
});

describe("Claude window lock", () => {
  it("locks every model on the account until the reset", async () => {
    await markAccountUnavailable("cc-a", 429, "limit", "claude", "claude-opus-5-5", IN_10_MIN * 1000);
    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update.modelLock___all).toBe(new Date(IN_10_MIN * 1000).toISOString());
    expect(update).not.toHaveProperty("modelLock_claude-opus-5-5");
  });

  it("keeps a Claude 429 without a reset model-scoped", async () => {
    await markAccountUnavailable("cc-a", 429, "rate limit", "claude", "claude-opus-5-5");
    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).toHaveProperty("modelLock_claude-opus-5-5");
    expect(update).not.toHaveProperty("modelLock___all");
  });

  it("keeps other providers' precise resets model-scoped", async () => {
    await markAccountUnavailable("cc-a", 429, "limit", "codex", "gpt-5", IN_10_MIN * 1000);
    expect(dbMocks.updateProviderConnection.mock.calls[0][1]).toHaveProperty("modelLock_gpt-5");
  });
});
