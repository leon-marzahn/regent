// OAuth token refresh must leave through the connection's proxy, the same way
// the connection's upstream calls do. It used to call the global fetch, which
// only knows the global (env) proxy, so a proactive Codex refresh went to
// auth.openai.com over the direct IP while chat traffic used the proxy.
//
// Harness: a fake HTTP proxy records every CONNECT target and refuses the
// tunnel (502), so nothing (and no token) ever reaches a real provider. The
// transport proxyFetch sends through (the undici package's fetch) is wrapped:
// requests on a ProxyAgent (proxied) pass through to the fake proxy, any other
// request (direct: no dispatcher, or the direct Agent) is recorded and
// rejected. Proxied == CONNECT logged; leaked == direct logged.
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const realFetch = globalThis.fetch;
const direct = vi.hoisted(() => []);
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetch: (url, options = {}) => {
      if (options.dispatcher instanceof actual.ProxyAgent) return actual.fetch(url, options);
      direct.push((url instanceof URL ? url : new URL(url)).host);
      return Promise.reject(new Error("direct connection blocked by test"));
    },
  };
});

const pools = new Map();
vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(async (id) => pools.get(id) || null),
}));
vi.mock("../../src/lib/localDb.js", () => ({
  getProviderConnectionById: vi.fn(async () => null),
  updateProviderConnection: vi.fn(async () => ({})),
  getProviderConnections: vi.fn(async () => []),
}));

for (const k of [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
]) {
  delete process.env[k];
}

const connects = [];
const proxy = http.createServer((_req, res) => res.writeHead(405).end());
proxy.on("connect", (req, socket) => {
  connects.push(req.url);
  socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
});
let proxyUrl;
let deadProxyUrl;

beforeAll(async () => {
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  deadProxyUrl = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((r) => dead.close(r));
});
afterAll(async () => {
  await new Promise((r) => proxy.close(r));
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  connects.length = 0;
  direct.length = 0;
  pools.clear();
});

const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
const { runBackgroundTokenRefreshTick } =
  await import("../../src/sse/services/backgroundTokenRefresh.js");
const { refreshTokenByProvider } = await import("../../open-sse/services/tokenRefresh.js");
const { getExecutor } = await import("../../open-sse/executors/index.js");
const { getUsageForProvider } = await import("../../open-sse/services/usage.js");
const { runWithProxyOptions, refreshCredentialsWithProxy } =
  await import("../../open-sse/utils/proxyScope.js");
const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

let seq = 0;
const token = () => `rt-test-${++seq}-${Date.now()}`;
const expired = () => new Date(Date.now() - 60_000).toISOString();
const strictProxy = () => ({
  connectionProxyEnabled: true,
  connectionProxyUrl: proxyUrl,
  strictProxy: true,
});

describe("proactive refresh (checkAndRefreshToken)", () => {
  it("sends a Codex refresh through the legacy per-connection proxy", async () => {
    await checkAndRefreshToken("codex", {
      id: "c1",
      authType: "oauth",
      refreshToken: token(),
      accessToken: "at",
      expiresAt: expired(),
      providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: proxyUrl },
    });
    expect(connects).toContain("auth.openai.com:443");
  });

  it("resolves a pool from a raw DB row and never goes direct when the pool is strict", async () => {
    pools.set("pool-1", { id: "pool-1", isActive: true, proxyUrl, strictProxy: true });
    await checkAndRefreshToken("codex", {
      id: "c2",
      authType: "oauth",
      refreshToken: token(),
      accessToken: "at",
      expiresAt: expired(),
      providerSpecificData: { proxyPoolId: "pool-1" },
    });
    expect(connects).toEqual(["auth.openai.com:443"]);
    expect(direct).toEqual([]);
  });

  it("fails rather than going direct when a strict pool's proxy is down", async () => {
    pools.set("pool-dead", {
      id: "pool-dead",
      isActive: true,
      proxyUrl: deadProxyUrl,
      strictProxy: true,
    });
    const creds = {
      id: "c3",
      authType: "oauth",
      refreshToken: token(),
      accessToken: "old",
      expiresAt: expired(),
      providerSpecificData: { proxyPoolId: "pool-dead" },
    };
    const out = await checkAndRefreshToken("codex", creds);
    expect(out.accessToken).toBe("old");
    expect(direct).toEqual([]);
  });

  it("keeps the non-strict fallback: proxy first, then direct (matches upstream calls)", async () => {
    await checkAndRefreshToken("claude", {
      id: "c4",
      authType: "oauth",
      refreshToken: token(),
      accessToken: "at",
      expiresAt: expired(),
      providerSpecificData: { connectionProxyEnabled: true, connectionProxyUrl: proxyUrl },
    });
    expect(connects).toEqual(["api.anthropic.com:443"]);
    expect(direct).toEqual(["api.anthropic.com"]);
  });

  it("refreshes the Copilot token through the proxy", async () => {
    await checkAndRefreshToken("github", {
      id: "c5",
      authType: "oauth",
      accessToken: "gh",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      providerSpecificData: {
        connectionProxyEnabled: true,
        connectionProxyUrl: proxyUrl,
        strictProxy: true,
        proxyPoolId: "",
      },
    });
    expect(connects).toContain("api.github.com:443");
  });
});

describe("background refresh", () => {
  it("sends due connections through their proxy pool", async () => {
    pools.set("pool-bg", { id: "pool-bg", isActive: true, proxyUrl, strictProxy: true });
    await runBackgroundTokenRefreshTick({
      loadConnections: async () => [
        {
          id: "bg1",
          provider: "codex",
          authType: "oauth",
          refreshToken: token(),
          accessToken: "at",
          expiresAt: expired(),
          providerSpecificData: { proxyPoolId: "pool-bg" },
        },
      ],
      sleep: async () => {},
    });
    expect(connects).toEqual(["auth.openai.com:443"]);
    expect(direct).toEqual([]);
  });
});

describe("every OAuth refresh handler honours proxyOptions", () => {
  // trae is left out: its registry entry is disabled, so its refresh never sends.
  const providers = [
    "claude",
    "codex",
    "gemini",
    "gemini-cli",
    "antigravity",
    "iflow",
    "github",
    "kiro",
    "xai",
    "grok-cli",
    "codebuddy-cn",
    "codebuddy-intl",
    "cline",
    "clinepass",
    "kimi",
    "minimax-code",
    "minimax-code-global",
    "nous",
  ];
  for (const provider of providers) {
    it(provider, async () => {
      await refreshTokenByProvider(
        provider,
        {
          refreshToken: token(),
          accessToken: "at",
          providerSpecificData: {},
        },
        null,
        strictProxy(),
      ).catch(() => null);
      expect(connects.length).toBeGreaterThan(0);
      expect(direct).toEqual([]);
    });
  }
});

describe("refresh on 401 (refreshCredentialsWithProxy)", () => {
  // Executors whose refreshCredentials ignores proxyOptions or calls the global fetch.
  for (const provider of ["codex", "gemini-cli", "minimax-code", "claude", "github"]) {
    it(provider, async () => {
      const executor = getExecutor(provider);
      await refreshCredentialsWithProxy(
        executor,
        {
          refreshToken: token(),
          accessToken: "at",
          providerSpecificData: {},
        },
        null,
        strictProxy(),
      ).catch(() => null);
      expect(connects.length).toBeGreaterThan(0);
      expect(direct).toEqual([]);
    });
  }
});

describe("usage lookups", () => {
  it("routes handlers that use the global fetch through the proxy", async () => {
    await getUsageForProvider({ provider: "minimax-code", accessToken: "at" }, strictProxy()).catch(
      () => null,
    );
    expect(connects.length).toBeGreaterThan(0);
    expect(direct).toEqual([]);
  });
});

describe("proxy scope", () => {
  it("never replaces a dispatcher the caller brought (SSRF-pinned agents)", async () => {
    const { Agent } = await import("undici");
    const dispatcher = new Agent({ connect: { timeout: 1 } });
    await runWithProxyOptions(strictProxy(), () =>
      proxyAwareFetch("http://127.0.0.1:9/", { dispatcher }).catch(() => null),
    );
    expect(connects).toEqual([]);
    await dispatcher.close();
  });

  it("explicit proxyOptions win over the scope", async () => {
    await runWithProxyOptions(
      { connectionProxyEnabled: true, connectionProxyUrl: deadProxyUrl, strictProxy: true },
      () => proxyAwareFetch("https://example.invalid/", {}, strictProxy()).catch(() => null),
    );
    expect(connects).toEqual(["example.invalid:443"]);
  });

  it("does nothing outside a scope", async () => {
    await proxyAwareFetch("https://example.invalid/", {}).catch(() => null);
    expect(connects).toEqual([]);
    expect(direct).toEqual(["example.invalid"]);
  });
});

describe("non-chat upstream calls", () => {
  it("embeddings go through the connection's resolved proxy", async () => {
    const { handleEmbeddingsCore } = await import("../../open-sse/handlers/embeddingsCore.js");
    await handleEmbeddingsCore({
      body: { input: "hi" },
      modelInfo: { provider: "openai", model: "text-embedding-3-small" },
      credentials: {
        apiKey: "sk-test",
        providerSpecificData: {
          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          strictProxy: true,
        },
      },
      log: null,
    });
    expect(connects).toEqual(["api.openai.com:443"]);
    expect(direct).toEqual([]);
  });
});

describe("dashboard usage refresh (refreshAndUpdateCredentials)", () => {
  it("refreshes through the proxy it is given", async () => {
    const { refreshAndUpdateCredentials } =
      await import("../../src/app/api/usage/[connectionId]/route.js");
    await refreshAndUpdateCredentials(
      {
        provider: "codex",
        refreshToken: token(),
        accessToken: "at",
        expiresAt: expired(),
        providerSpecificData: {},
      },
      true,
      strictProxy(),
    ).catch(() => null);
    expect(connects).toEqual(["auth.openai.com:443"]);
    expect(direct).toEqual([]);
  });
});

// ── Review round 2 ─────────────────────────────────────────────────────────

const { runCoreInProxyScope, runOutsideProxyScope } =
  await import("../../open-sse/utils/proxyScope.js");
const { handleSearchCore } = await import("../../open-sse/handlers/search/index.js");
const { PROVIDER_MEDIA } = await import("../../open-sse/providers/index.js");
const { fetchPublic } = await import("../../src/shared/utils/ssrfGuard.js");

// A CONNECT-recording proxy per tag; `mode` decides what it does with the tunnel.
async function startProxy(mode = "refuse") {
  const seen = [];
  const server = http.createServer((_req, res) => res.writeHead(405).end());
  server.on("connect", (req, socket) => {
    seen.push(req.url);
    if (mode === "refuse") return socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    // "reset": accept the tunnel, then drop it once the client starts talking
    // (the request may already be on its way: it must not be replayed).
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () => socket.destroy());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

describe("scope isolation", () => {
  it("keeps concurrent connections on their own proxies", async () => {
    const a = await startProxy();
    const b = await startProxy();
    const opts = (p) => ({
      connectionProxyEnabled: true,
      connectionProxyUrl: p.url,
      strictProxy: true,
    });
    const jobs = [];
    for (let i = 0; i < 15; i++) {
      for (const p of [a, b]) {
        const tag = p === a ? "a" : "b";
        jobs.push(
          runWithProxyOptions(opts(p), async () => {
            await new Promise((r) => setTimeout(r, Math.random() * 20));
            return fetch(`https://${tag}-${i}.example.invalid/`).catch(() => null);
          }),
        );
      }
    }
    await Promise.all(jobs);
    expect(a.seen).toHaveLength(15);
    expect(b.seen).toHaveLength(15);
    expect(a.seen.every((t) => t.startsWith("a-"))).toBe(true);
    expect(b.seen.every((t) => t.startsWith("b-"))).toBe(true);
    expect(direct).toEqual([]);
    await a.close();
    await b.close();
  });
});

describe("side effects run outside the scope", () => {
  it("handler callbacks, and work they start later, never use the connection's proxy", async () => {
    /** @type {Promise<unknown> | undefined} */
    let later;
    await runCoreInProxyScope(
      {
        credentials: {
          providerSpecificData: {
            connectionProxyEnabled: true,
            connectionProxyUrl: proxyUrl,
            strictProxy: true,
          },
        },
        onUsage: () => {
          // e.g. saveRequestUsage -> budgets -> notify: fire-and-forget, after a delay
          later = new Promise((r) => setTimeout(r, 20)).then(() =>
            fetch("https://notify.example.invalid/").catch(() => null),
          );
        },
      },
      async (args) => {
        await fetch("https://upstream.example.invalid/").catch(() => null); // the core's own call
        args.onUsage();
      },
    );
    await later;
    expect(connects).toEqual(["upstream.example.invalid:443"]);
    expect(direct).toEqual(["notify.example.invalid"]);
  });

  it("runOutsideProxyScope leaves the scope", async () => {
    await runWithProxyOptions(strictProxy(), () =>
      runOutsideProxyScope(() => fetch("https://side.example.invalid/").catch(() => null)),
    );
    expect(connects).toEqual([]);
    expect(direct).toEqual(["side.example.invalid"]);
  });
});

describe("refresh never replays a request the proxy may have sent", () => {
  it("falls back to direct when the proxy refused the connection (nothing sent)", async () => {
    await refreshTokenByProvider("codex", { refreshToken: token() }, null, {
      connectionProxyEnabled: true,
      connectionProxyUrl: deadProxyUrl,
    });
    expect(direct).toEqual(["auth.openai.com"]);
  });

  it("falls back to direct when the proxy refused the CONNECT tunnel (nothing sent)", async () => {
    await refreshTokenByProvider("codex", { refreshToken: token() }, null, {
      connectionProxyEnabled: true,
      connectionProxyUrl: proxyUrl,
    });
    expect(connects).toEqual(["auth.openai.com:443"]);
    expect(direct).toEqual(["auth.openai.com"]);
  });

  it("does not go direct once the tunnel was up", async () => {
    const reset = await startProxy("reset");
    await refreshTokenByProvider("codex", { refreshToken: token() }, null, {
      connectionProxyEnabled: true,
      connectionProxyUrl: reset.url,
    });
    expect(reset.seen).toEqual(["auth.openai.com:443"]);
    expect(direct).toEqual([]);
    await reset.close();
  });

  it("ordinary (non-refresh) requests keep the existing non-strict fallback", async () => {
    const reset = await startProxy("reset");
    await proxyAwareFetch(
      "https://api.example.invalid/",
      {},
      { connectionProxyEnabled: true, connectionProxyUrl: reset.url },
    ).catch(() => null);
    expect(direct).toEqual(["api.example.invalid"]);
    await reset.close();
  });
});

describe("proxy errors stay generic", () => {
  it("does not expose the proxy, its address or the internal text", async () => {
    const err = await proxyAwareFetch(
      "https://api.example.invalid/",
      {},
      { connectionProxyEnabled: true, connectionProxyUrl: deadProxyUrl, strictProxy: true },
    ).catch((e) => e);
    expect(err.code).toBe("PROXY_UNAVAILABLE");
    expect(err.message).toMatch(/^Upstream proxy unavailable/);
    expect(err.message).not.toMatch(/ProxyFetch|strictProxy|127\.0\.0\.1/);
  });

  it("refreshCredentialsWithProxy reports a dead strict proxy as such, not as a failed sign-in", async () => {
    const err = await refreshCredentialsWithProxy(
      getExecutor("codex"),
      { refreshToken: token() },
      null,
      { connectionProxyEnabled: true, connectionProxyUrl: deadProxyUrl, strictProxy: true },
    ).catch((e) => e);
    expect(err?.code).toBe("PROXY_UNAVAILABLE");
  });
});

describe("dashboard usage with a dead strict proxy", () => {
  it("answers 503 proxy-unavailable instead of 401 sign-in expired", async () => {
    const { getProviderConnectionById } = await import("../../src/lib/localDb.js");
    pools.set("pool-dead2", {
      id: "pool-dead2",
      isActive: true,
      proxyUrl: deadProxyUrl,
      strictProxy: true,
    });
    const conn = {
      id: "u1",
      provider: "codex",
      authType: "oauth",
      refreshToken: token(),
      expiresAt: expired(),
      providerSpecificData: { proxyPoolId: "pool-dead2" },
    };
    getProviderConnectionById.mockImplementation(async () => conn);
    try {
      const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
      const res = await GET(new Request("http://localhost/api/usage/u1"), {
        params: Promise.resolve({ connectionId: "u1" }),
      });
      expect(res.status).toBe(503);
      expect((await res.json()).proxyUnavailable).toBe(true);
      expect(direct).toEqual([]);
    } finally {
      getProviderConnectionById.mockImplementation(async () => null);
    }
  });
});

describe("stored settings never receive the resolved proxy", () => {
  it("merges refreshed fields onto the stored providerSpecificData", async () => {
    const { getProviderConnectionById, updateProviderConnection } =
      await import("../../src/lib/localDb.js");
    const { updateProviderCredentials } = await import("../../src/sse/services/tokenRefresh.js");
    getProviderConnectionById.mockImplementation(async () => ({
      providerSpecificData: {
        proxyPoolId: "p1",
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
      },
    }));
    updateProviderConnection.mockClear();
    try {
      await updateProviderCredentials("c9", {
        accessToken: "at",
        providerSpecificData: { copilotToken: "cp" },
        existingProviderSpecificData: {
          proxyPoolId: "p1",
          connectionProxyEnabled: true,
          connectionProxyUrl: "http://user:pass@pool-proxy:8080",
          connectionNoProxy: "",
          connectionProxyPoolId: "p1",
          vercelRelayUrl: "",
          strictProxy: true,
        },
      });
      expect(updateProviderConnection.mock.calls[0][1].providerSpecificData).toEqual({
        proxyPoolId: "p1",
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        copilotToken: "cp",
      });
    } finally {
      getProviderConnectionById.mockImplementation(async () => null);
    }
  });
});

describe("search", () => {
  it("refuses a client-chosen base URL, so the operator's key never leaves for it", async () => {
    const result = await handleSearchCore({
      body: { query: "hello", provider_options: { baseUrl: "https://attacker.example.com" } },
      provider: { id: "serper" },
      providerConfig: PROVIDER_MEDIA.serper.searchConfig,
      credentials: { apiKey: "serper-demo-key-000", providerSpecificData: {} },
      log: null,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(connects).toEqual([]);
    expect(direct).toEqual([]);
  });

  it("keeps the SSRF guard inside a proxy scope: a name only the proxy could resolve is refused", async () => {
    const err = await runWithProxyOptions(strictProxy(), () =>
      fetchPublic("https://secret-internal.invalid/admin").catch((e) => e),
    );
    expect(String(err?.message)).toMatch(/does not resolve/);
    expect(connects).toEqual([]);
    expect(direct).toEqual([]);
  });

  it("still refuses internal literals inside a proxy scope", async () => {
    const err = await runWithProxyOptions(strictProxy(), () =>
      fetchPublic("http://127.0.0.1:9/").catch((e) => e),
    );
    expect(String(err?.message)).toMatch(/Blocked URL/);
    expect(connects).toEqual([]);
  });
});

describe("other connection calls", () => {
  it("the translator sends through the connection's proxy", async () => {
    const { getProviderConnections } = await import("../../src/lib/localDb.js");
    getProviderConnections.mockImplementation(async () => [
      {
        id: "t1",
        provider: "openai",
        isActive: true,
        apiKey: "sk-test",
        providerSpecificData: {
          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          strictProxy: true,
        },
      },
    ]);
    process.env.ENABLE_TRANSLATOR = "true";
    try {
      const { POST } = await import("../../src/app/api/translator/send/route.js");
      await POST(
        new Request("http://localhost/api/translator/send", {
          method: "POST",
          body: JSON.stringify({
            provider: "openai",
            model: "gpt-4o-mini",
            body: { messages: [{ role: "user", content: "hi" }], stream: false },
          }),
        }),
      );
      expect(connects).toContain("api.openai.com:443");
    } finally {
      delete process.env.ENABLE_TRANSLATOR;
      getProviderConnections.mockImplementation(async () => []);
    }
  }, 30_000);

  it("systemone runs in the connection's scope", async () => {
    const { handleSystemoneCore } = await import("../../open-sse/handlers/systemoneCore.js");
    await handleSystemoneCore({
      body: { messages: [] },
      modelInfo: { provider: "no-such-provider", model: "m" },
      credentials: {
        providerSpecificData: {
          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          strictProxy: true,
          baseUrl: "https://systemone.example.invalid",
        },
      },
      log: null,
    }).catch(() => null);
    expect(direct).toEqual([]);
  });
});

// ── Review round 3 ─────────────────────────────────────────────────────────

const { refreshProxyOptions } = await import("../../open-sse/utils/proxyScope.js");
const { refreshWithRetry } = await import("../../open-sse/services/tokenRefresh.js");
const { default: cloudflareAi } =
  await import("../../open-sse/handlers/imageProviders/cloudflareAi.js");
const { default: huggingface } =
  await import("../../open-sse/handlers/imageProviders/huggingface.js");

// A token endpoint that accepts the request and then drops the connection
// (response lost after the provider may have spent the refresh token), and a
// proxy that tunnels to it. Loopback only.
async function startDroppingTokenEndpoint() {
  let hits = 0;
  const endpoint = http.createServer((req) => {
    hits++;
    setTimeout(() => req.socket.destroy(), 50);
  });
  await new Promise((r) => endpoint.listen(0, "127.0.0.1", r));
  const net = await import("node:net");
  const tunnel = http.createServer();
  tunnel.on("connect", (req, sock) => {
    const [h, p] = req.url.split(":");
    const up = net.connect(Number(p), h, () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on("error", () => sock.destroy());
  });
  await new Promise((r) => tunnel.listen(0, "127.0.0.1", r));
  return {
    hits: () => hits,
    tokenUrl: `http://127.0.0.1:${endpoint.address().port}/oauth/token`,
    proxyUrl: `http://127.0.0.1:${tunnel.address().port}`,
    close: async () => {
      endpoint.closeAllConnections?.();
      tunnel.closeAllConnections?.();
      await new Promise((r) => endpoint.close(r));
      await new Promise((r) => tunnel.close(r));
    },
  };
}

describe("every refresh is connect-only, whatever the call site", () => {
  it("a refresh without explicit options inside a core scope is sent once", async () => {
    const t = await startDroppingTokenEndpoint();
    try {
      const credentials = {
        providerSpecificData: {
          connectionProxyEnabled: true,
          connectionProxyUrl: t.proxyUrl,
          strictProxy: false,
        },
      };
      // video/embeddings/image 401 path shape: refresh called with no proxy options
      await runCoreInProxyScope({ credentials }, () =>
        refreshWithRetry(
          () =>
            runWithProxyOptions(refreshProxyOptions(null), () =>
              proxyAwareFetch(t.tokenUrl, { method: "POST", body: "grant_type=refresh_token" }),
            ),
          3,
          null,
        ),
      );
      expect(t.hits()).toBe(1);
      expect(direct).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("refreshProxyOptions(null) is null outside any scope", () => {
    expect(refreshProxyOptions(null)).toBeNull();
  });

  it("refreshWithRetry stops after a proxy-unavailable error", async () => {
    let calls = 0;
    const out = await refreshWithRetry(
      async () => {
        calls++;
        throw Object.assign(new Error("Upstream proxy unavailable"), { code: "PROXY_UNAVAILABLE" });
      },
      3,
      null,
    );
    expect(out).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("client-supplied image URLs go through the SSRF guard", () => {
  it("cloudflare-ai refuses internal image and mask URLs without fetching them", async () => {
    let hits = 0;
    const internal = http.createServer((_req, res) => {
      hits++;
      res.end("secret");
    });
    await new Promise((r) => internal.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${internal.address().port}/admin.png`;
    try {
      for (const body of [
        { prompt: "x", image: url },
        { prompt: "x", mask: url },
      ]) {
        await expect(
          runWithProxyOptions(strictProxy(), () =>
            cloudflareAi.buildBody("@cf/test/json-model", body),
          ),
        ).rejects.toThrow(/rejected/);
      }
      expect(hits).toBe(0);
      expect(connects).toEqual([]);
    } finally {
      await new Promise((r) => internal.close(r));
    }
  });

  it("huggingface image-to-image refuses an internal source image", async () => {
    await expect(
      huggingface.buildBody("black-forest-labs/FLUX.1-Kontext-dev", {
        prompt: "x",
        image: "http://169.254.169.254/latest/meta-data",
      }),
    ).rejects.toThrow(/rejected/);
    expect(connects).toEqual([]);
    expect(direct).toEqual([]);
  });
});
