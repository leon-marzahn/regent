import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

// The "remote" fixtures model a reverse-proxied deployment whose names are allow-listed.
process.env.ALLOWED_HOSTS = "regent.example.com, router.example.com";

const { proxy, __test__ } = await import("../../src/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture";

function request(pathname, headers = {}) {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
  };
}

// A request that actually came through custom-server.js: peer IP stamped from the TCP
// socket and proven by the per-process secret.
function localRequest(pathname, headers = {}) {
  return request(pathname, { "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "127.0.0.1", ...headers });
}

describe("dashboard guard public LLM API access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("allows loopback public LLM API without API key", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote Host-spoof when real peer IP is non-loopback", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", {
      host: "localhost",
      "x-9r-real-ip": "10.204.111.34",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback peer IP regardless of Host", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", {
      host: "localhost:20128",
      "x-9r-real-ip": "127.0.0.1",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote rewritten public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1/chat/completions", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback rewritten public LLM API without API key", async () => {
    const response = await proxy(localRequest("/api/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote beta public LLM API without API key", async () => {
    const response = await proxy(request("/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote rewritten beta public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote codex rewrite without API key", async () => {
    const response = await proxy(request("/codex/x", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote /responses rewrite without API key", async () => {
    const response = await proxy(request("/responses", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows remote /responses rewrite with a valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/responses", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote codex rewrite with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/codex/x", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid bearer API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1/chat/completions", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid x-api-key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1/web/fetch", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote rewritten beta public LLM API with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1beta/models", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google API key header", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models", {
      host: "router.example.com",
      "x-goog-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google key query parameter", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models?key=sk-valid", {
      host: "router.example.com",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });
});

describe("dashboard guard local-only access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("rejects local-only route from non-loopback host without CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("rejects local-only route on loopback when requireLogin=true and no JWT", async () => {
    const response = await proxy(localRequest("/api/mcp/filesystem/sse", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("allows local-only route on loopback when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(localRequest("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route from tunnel host even when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("rejects local-only route when Origin is non-loopback (CSRF block)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(localRequest("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://evil.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("allows local-only route with valid CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": "cli-token",
    }));

    expect(response).toBe(mocks.nextResponse);
  });
});

describe("dashboard guard cli-tools routes are local-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
  });

  const routes = [
    "/api/cli-tools/claude-settings",
    "/api/cli-tools/codex-profiles",
    "/api/cli-tools/hermes-profiles",
    "/api/cli-tools/cowork-mcp-tools",
    "/api/cli-tools/cowork-mcp-registry",
    "/api/cli-tools/restore",
    "/api/cli-tools/deepseek-tui-settings",
    "/api/cli-tools/all-statuses",
  ];

  for (const route of routes) {
    it(`rejects ${route} from a logged-in remote (tunnel) user`, async () => {
      const req = request(route, { host: "router.example.com" });
      req.cookies.get = vi.fn(() => ({ value: "jwt" }));
      const response = await proxy(req);
      expect(response.status).toBe(403);
    });

    it(`allows ${route} on loopback with a session`, async () => {
      const req = localRequest(route, { host: "localhost:20128", origin: "http://localhost:20128" });
      req.cookies.get = vi.fn(() => ({ value: "jwt" }));
      expect(await proxy(req)).toBe(mocks.nextResponse);
    });
  }

  it("allows cli-tools remotely with the CLI token", async () => {
    const response = await proxy(request("/api/cli-tools/claude-settings", {
      host: "router.example.com",
      "x-9r-cli-token": "cli-token",
    }));
    expect(response).toBe(mocks.nextResponse);
  });
});

describe("dashboard guard request detail access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("requires dashboard authentication to read request payloads when login is enabled", async () => {
    const response = await proxy(request("/api/usage/request-details"));
    expect(response.status).toBe(401);
  });

  it("allows an authenticated dashboard session to inspect request payloads", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    expect(await proxy(request("/api/usage/request-details"))).toBe(mocks.nextResponse);
  });

  it("does not let a valid API key in x-goog-api-key or ?key= open dashboard routes", async () => {
    mocks.validateApiKey.mockResolvedValue(true);
    for (const r of [
      request("/api/usage/request-details", { host: "router.example.com", "x-goog-api-key": "sk-valid" }),
      request("/api/settings?key=sk-valid", { host: "router.example.com" }),
      localRequest("/api/settings", { host: "localhost:20128", "x-goog-api-key": "sk-valid" }),
    ]) {
      expect((await proxy(r)).status).toBe(401);
    }
  });
});

describe("dashboard guard helpers", () => {
  it("extracts bearer API keys before x-api-key", () => {
    const apiRequest = request("/v1/chat/completions", {
      authorization: "Bearer bearer-key",
      "x-api-key": "header-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("bearer-key");
  });

  it("extracts Google API keys after x-api-key", () => {
    const apiRequest = request("/v1beta/models?key=query-key", {
      "x-api-key": "header-key",
      "x-goog-api-key": "google-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("header-key");
  });
});

describe("SSO test endpoints", () => {
  it("are not public even though the rest of /api/auth/oidc and /api/auth/saml is", async () => {
    const { __test__ } = await import("../../src/dashboardGuard.js");
    expect(__test__.isPublicApi("/api/auth/oidc/callback")).toBe(true);
    expect(__test__.isPublicApi("/api/auth/saml/acs")).toBe(true);
    expect(__test__.isPublicApi("/api/auth/oidc/test")).toBe(false);
    expect(__test__.isPublicApi("/api/auth/saml/test")).toBe(false);
  });
});


describe("dashboard guard headroom process routes are local-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
  });

  // These run pip or spawn the proxy process.
  for (const route of ["/api/headroom/extras", "/api/headroom/restart", "/api/headroom/start"]) {
    it(`rejects ${route} from a logged-in remote (tunnel) user`, async () => {
      const req = request(route, { host: "router.example.com" });
      req.cookies.get = vi.fn(() => ({ value: "jwt" }));
      expect((await proxy(req)).status).toBe(403);
    });

    it(`allows ${route} on loopback with a session`, async () => {
      const req = localRequest(route, { host: "localhost:20128", origin: "http://localhost:20128" });
      req.cookies.get = vi.fn(() => ({ value: "jwt" }));
      expect(await proxy(req)).toBe(mocks.nextResponse);
    });
  }
});

describe("dashboard guard auto-import routes (host credential readers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  const withJwt = (req) => {
    req.cookies.get = vi.fn(() => ({ value: "jwt" }));
    return req;
  };

  for (const path of [
    "/api/oauth/xiaomi-mimo/auto-import",
    "/api/oauth/cursor/auto-import",
    "/api/oauth/kiro/auto-import",
    "/api/oauth/zed/auto-import",
    "/api/oauth/some-new-ide/auto-import",
  ]) {
    it(`${path}: remote session gets 403, loopback without session 401 even with requireLogin off`, async () => {
      mocks.verifyDashboardAuthToken.mockResolvedValue(true);
      expect((await proxy(withJwt(request(path, { host: "regent.example.com" })))).status).toBe(403);

      mocks.verifyDashboardAuthToken.mockResolvedValue(false);
      mocks.getSettings.mockResolvedValue({ requireLogin: false });
      expect((await proxy(localRequest(path, { host: "localhost:20128" }))).status).toBe(401);

      mocks.verifyDashboardAuthToken.mockResolvedValue(true);
      mocks.getSettings.mockResolvedValue({ requireLogin: true });
      expect(await proxy(withJwt(localRequest(path, { host: "localhost:20128" })))).toBe(mocks.nextResponse);
    });
  }
});

// MiniMax Code desktop lease actions reach a broker socket in the host's home dir.
describe("dashboard guard MiniMax Code lease routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
  });

  const withJwt = (req) => {
    req.cookies.get = vi.fn(() => ({ value: "jwt" }));
    return req;
  };

  for (const path of [
    "/api/oauth/minimax-code/lease-connect",
    "/api/oauth/minimax-code/lease-status",
    "/api/oauth/minimax-code-global/lease-connect",
    "/api/oauth/minimax-code-global/lease-status",
  ]) {
    it(`${path}: local-only and login required even with requireLogin off`, async () => {
      // Remote with a valid session: local-only.
      mocks.verifyDashboardAuthToken.mockResolvedValue(true);
      mocks.getSettings.mockResolvedValue({ requireLogin: true });
      expect((await proxy(withJwt(request(path, { host: "regent.example.com" })))).status).toBe(403);

      // Loopback without a session, requireLogin off: still needs the session.
      mocks.verifyDashboardAuthToken.mockResolvedValue(false);
      mocks.getSettings.mockResolvedValue({ requireLogin: false });
      expect((await proxy(localRequest(path, { host: "localhost:20128" }))).status).toBe(401);

      // Loopback, cross-site Origin (CSRF), with a session: refused.
      mocks.verifyDashboardAuthToken.mockResolvedValue(true);
      mocks.getSettings.mockResolvedValue({ requireLogin: true });
      expect(
        (await proxy(withJwt(localRequest(path, { host: "localhost:20128", origin: "https://evil.example" })))).status,
      ).toBe(403);

      // Loopback with a session: allowed.
      expect(await proxy(withJwt(localRequest(path, { host: "localhost:20128" })))).toBe(mocks.nextResponse);
    });
  }
});

// The guard once kept an unused PROTECTED_API_PATHS list; deny-by-default for /api/*
// is what actually protects these. Pin that so removing the list hid nothing.
describe("dashboard guard formerly-listed protected API paths", () => {
  const PATHS = [
    "/api/settings", "/api/keys", "/api/providers", "/api/provider-nodes", "/api/proxy-pools",
    "/api/combos", "/api/models", "/api/usage", "/api/oauth/codex/authorize", "/api/cloud",
    "/api/media-providers", "/api/pricing", "/api/tags", "/api/cli-tools/all-statuses",
    "/api/mcp/x", "/api/translator", "/api/tunnel",
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  for (const path of PATHS) {
    it(`${path} rejects a request without a session, remote and loopback`, async () => {
      for (const req of [request(path), localRequest(path, { host: "localhost:20128" })]) {
        const res = await proxy(req);
        expect(res).not.toBe(mocks.nextResponse);
        expect([401, 403]).toContain(res.status);
      }
    });
  }
});

// requireLogin=false waives login only for a browser on this machine, and the Host
// allow-list blocks DNS rebinding for every dashboard and /api route.
describe("dashboard guard requireLogin off and Host allow-list", () => {
  const withJwt = (req) => {
    req.cookies.get = vi.fn(() => ({ value: "jwt" }));
    return req;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    process.env.ALLOWED_HOSTS = "regent.example.com, router.example.com";
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.BASE_URL;
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("lets a loopback peer read /api/keys without a session", async () => {
    expect(await proxy(localRequest("/api/keys", { host: "localhost:20128" }))).toBe(mocks.nextResponse);
    expect(await proxy(localRequest("/api/keys", { host: "[::1]:20128", "x-9r-real-ip": "::1" }))).toBe(mocks.nextResponse);
    expect(await proxy(localRequest("/dashboard", { host: "127.0.0.1:20128" }))).toBe(mocks.nextResponse);
  });

  it("makes a remote peer log in", async () => {
    const res = await proxy(localRequest("/api/keys", { host: "192.168.1.10:20128", "x-9r-real-ip": "192.168.1.20" }));
    expect(res.status).toBe(401);
    const page = await proxy(localRequest("/dashboard", { host: "192.168.1.10:20128", "x-9r-real-ip": "192.168.1.20" }));
    expect(page.status).toBe(307);
  });

  it("ignores a spoofed X-Forwarded-For and an unproven x-9r-real-ip from a remote caller", async () => {
    // custom-server.js strips X-Forwarded-For from untrusted peers and stamps the socket IP.
    const spoof = localRequest("/api/keys", {
      host: "localhost:20128", "x-9r-real-ip": "10.0.0.5", "x-forwarded-for": "127.0.0.1",
    });
    expect((await proxy(spoof)).status).toBe(401);
    const noProof = request("/api/keys", { host: "localhost:20128", "x-9r-real-ip": "127.0.0.1" });
    expect((await proxy(noProof)).status).toBe(401);
  });

  it("treats tunnel traffic (forwarding headers on a loopback socket) as remote", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false, tunnelUrl: "https://abc.trycloudflare.com" });
    const tunnel = () => localRequest("/api/keys", { host: "abc.trycloudflare.com", "x-9r-via-proxy": "1" });
    expect((await proxy(tunnel())).status).toBe(401);
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    expect(await proxy(withJwt(tunnel()))).toBe(mocks.nextResponse);
  });

  it("refuses a loopback request with a foreign Origin", async () => {
    const res = await proxy(localRequest("/api/keys", { host: "localhost:20128", origin: "http://evil.com:20128" }));
    expect(res.status).toBe(401);
  });

  it("rejects a DNS-rebinding Host with 421, with or without a session", async () => {
    const rebind = { host: "evil.com:20128", origin: "http://evil.com:20128" };
    expect((await proxy(localRequest("/api/keys", rebind))).status).toBe(421);
    expect((await proxy(localRequest("/api/keys", { host: "evil.com:20128" }))).status).toBe(421);
    expect((await proxy(localRequest("/dashboard", { host: "evil.com" }))).status).toBe(421);
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    expect((await proxy(withJwt(localRequest("/api/keys", { host: "evil.com" })))).status).toBe(421);
    expect((await proxy(withJwt(request("/api/settings", { host: "evil.com" })))).status).toBe(421);
  });

  it("allows loopback names, IP literals, base URL, tunnel, Tailscale and ALLOWED_HOSTS", async () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://router.lan:8443";
    process.env.ALLOWED_HOSTS = "Proxy.Example.org:443, https://other.example.net/";
    const settings = { tunnelUrl: "https://abc.trycloudflare.com", tailscaleUrl: "https://box.tail1234.ts.net" };
    const ok = (host) => __test__.isAllowedHost(request("/api/keys", { host }), settings);
    for (const h of ["localhost", "localhost:20128", "127.0.0.1:1", "[::1]:20128", "192.168.1.10:20128",
      "[fd00::1]:20128", "router.lan", "proxy.example.org", "other.example.net:80",
      "abc.trycloudflare.com", "box.tail1234.ts.net"]) {
      expect(ok(h), h).toBe(true);
    }
    for (const h of ["evil.com", "localhost.evil.com", "127.0.0.1.nip.io", "regent.example.com", "a b"]) {
      expect(ok(h), h).toBe(false);
    }
    expect(__test__.isAllowedHost(request("/api/keys"), settings)).toBe(true);
  });

  it("serves an ALLOWED_HOSTS name to a session but not without one", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    expect((await proxy(request("/api/keys", { host: "regent.example.com" }))).status).toBe(401);
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    expect(await proxy(withJwt(request("/api/keys", { host: "regent.example.com" })))).toBe(mocks.nextResponse);
  });

  it("leaves keyed /v1 traffic alone on any Host and keeps the keyless bypass to allowed hosts", async () => {
    mocks.validateApiKey.mockResolvedValue(true);
    const keyed = request("/v1/chat/completions", { host: "llm.unlisted.example", authorization: "Bearer sk-ok" });
    expect(await proxy(keyed)).toBe(mocks.nextResponse);
    mocks.validateApiKey.mockResolvedValue(false);
    expect(await proxy(localRequest("/v1/models", { host: "localhost:20128" }))).toBe(mocks.nextResponse);
    expect((await proxy(localRequest("/v1/models", { host: "evil.com:20128" }))).status).toBe(401);
  });

  it("exports an isAuthenticated that applies the same rules (mimo login branch)", async () => {
    const { isAuthenticated } = await import("../../src/dashboardGuard.js");
    expect(await isAuthenticated(localRequest("/fe/x", { host: "localhost:20128" }))).toBe(true);
    expect(await isAuthenticated(localRequest("/fe/x", { host: "evil.com" }))).toBe(false);
    expect(await isAuthenticated(request("/fe/x", { host: "regent.example.com" }))).toBe(false);
  });
});

// Review follow-ups: proxies on this machine, malformed Host, a 421 that says what to do.
describe("dashboard guard loopback proxies and malformed Host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    process.env.ALLOWED_HOSTS = "regent.example.com";
    process.env.NEXT_PUBLIC_BASE_URL = "https://router.lan";
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  // The reviewer's three curl repros with requireLogin off, as the guard sees them after
  // custom-server.js: socket 127.0.0.1, forwarding headers turned into x-9r-via-proxy.
  it("needs login for a loopback proxy forwarding an allowed name, with or without XFF", async () => {
    const withXff = localRequest("/api/keys", { host: "regent.example.com", "x-9r-via-proxy": "1" });
    expect((await proxy(withXff)).status).toBe(401);
    const noXff = localRequest("/api/keys", { host: "regent.example.com" });
    expect((await proxy(noXff)).status).toBe(401);
    expect((await proxy(localRequest("/api/keys", { host: "router.lan" }))).status).toBe(401);
    expect((await proxy(localRequest("/dashboard", { host: "regent.example.com" }))).status).toBe(307);
  });

  it("cannot tell nginx's bare proxy_pass (Host 127.0.0.1, no forwarding headers) from a local browser", async () => {
    // Documented: login off is unsafe behind a proxy that adds no forwarding headers.
    expect(await proxy(localRequest("/api/keys", { host: "127.0.0.1:20128" }))).toBe(mocks.nextResponse);
  });

  it("does not waive login for an IP-literal Host even on a loopback socket", async () => {
    expect((await proxy(localRequest("/api/keys", { host: "192.168.1.10:20128" }))).status).toBe(401);
  });

  it.each(["localhost@evil.com", "evil.com/localhost", "localhost\\evil.com", "localhost#x", "local host", "localhost\tx"])(
    "rejects malformed Host %j",
    async (host) => {
      expect(__test__.isAllowedHost(request("/api/keys", { host: "x" }), {})).toBe(false);
      const req = request("/api/keys");
      req.headers = { get: (n) => (n.toLowerCase() === "host" ? host : null) };
      expect(__test__.isAllowedHost(req, {})).toBe(false);
    },
  );

  it("names ALLOWED_HOSTS and the host in the 421 body", async () => {
    const res = await proxy(localRequest("/api/keys", { host: "other.example.com:8080" }));
    expect(res.status).toBe(421);
    expect(res.body.error).toContain("ALLOWED_HOSTS=other.example.com");
  });
});
