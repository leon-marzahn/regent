import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

// The single-curve ClientHello (X25519) beats ISP DPI on api.anthropic.com, but a
// peer without X25519 (some corporate TLS-inspecting proxies) fails the handshake,
// so it must only reach the Anthropic hosts unless the operator opts in globally.
describe("proxyFetch ECDH curve scope", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...savedEnv };
    delete process.env.REGENT_TLS_ECDH_CURVE;
    delete process.env.NINEROUTER_TLS_ECDH_CURVE;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.doUnmock("undici");
  });

  it("curves only the Anthropic hosts by default", async () => {
    const { ecdhCurveFor } = await import("../../open-sse/utils/proxyFetch.js");
    expect(ecdhCurveFor("https://api.anthropic.com/v1/messages")).toBe("X25519");
    expect(ecdhCurveFor(new URL("https://console.anthropic.com/v1/oauth/token"))).toBe("X25519");
    expect(ecdhCurveFor("https://claude.ai/oauth/authorize")).toBe("X25519");
    expect(ecdhCurveFor("https://api.openai.com/v1/chat/completions")).toBeNull();
    expect(ecdhCurveFor("https://evil.api.anthropic.com.example/x")).toBeNull();
    expect(ecdhCurveFor("not a url")).toBeNull();
  });

  it("applies an operator-set curve list to every host", async () => {
    process.env.REGENT_TLS_ECDH_CURVE = "X25519:P-256";
    const { ecdhCurveFor } = await import("../../open-sse/utils/proxyFetch.js");
    expect(ecdhCurveFor("https://api.openai.com/v1")).toBe("X25519:P-256");
    expect(ecdhCurveFor("https://api.anthropic.com/v1")).toBe("X25519:P-256");
  });

  it("still reads the upstream NINEROUTER_TLS_ECDH_CURVE", async () => {
    process.env.NINEROUTER_TLS_ECDH_CURVE = "P-256";
    const { ecdhCurveFor } = await import("../../open-sse/utils/proxyFetch.js");
    expect(ecdhCurveFor("https://api.openai.com/v1")).toBe("P-256");
  });

  it("builds direct agents with the curve only for curved hosts, as separate pooled agents", async () => {
    const agents = [];
    vi.doMock("undici", async (importOriginal) => {
      const actual = await importOriginal();
      class Agent {
        constructor(opts) { this.opts = opts; agents.push(opts); }
      }
      return { ...actual, Agent };
    });
    const { getDirectDispatcher, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests?.();

    const plain = await getDirectDispatcher(false, null);
    const curved = await getDirectDispatcher(false, "X25519");
    expect(curved).not.toBe(plain);
    expect(plain.opts.connect).not.toHaveProperty("ecdhCurve");
    expect(curved.opts.connect.ecdhCurve).toBe("X25519");
    expect(await getDirectDispatcher(false, "X25519")).toBe(curved);
  });
});
