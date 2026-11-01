// Deny-by-default check across every dashboard API route on disk: an unauthenticated
// remote request (no session cookie, no CLI token, requireLogin on) must be refused by
// src/dashboardGuard.js unless the route is on the explicit public allow-list. A new
// route that handles credentials/settings can't silently ship unauthenticated.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ next: Symbol("next") }));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.next),
    json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireLogin: true })),
  validateApiKey: vi.fn(async () => false),
}));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "cli-token-fixture") }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: vi.fn(async (t) => t === "valid-session"),
}));

const { proxy } = await import("../../src/dashboardGuard.js");

// Routes that are public by design (login/OIDC/SAML handshake, health, locale, init).
const PUBLIC = [
  /^\/api\/v1(beta)?(\/|$)/,
  /^\/api\/(health|init|locale)(\/|$)/,
  /^\/api\/auth\/(login|logout|status)(\/|$)/,
  /^\/api\/auth\/oidc\/(?!test)/,
  /^\/api\/auth\/saml\/(?!test)/,
  /^\/api\/settings\/require-login$/,
  // Deliberately public: the customer view authenticates with the caller's own API key
  // in the handler (src/lib/customerView). Covered by tests/unit/customer-view.test.js.
  /^\/api\/customer\/usage$/,
  // Deliberately public: the T3 usage hub checks REGENT_MANAGEMENT_KEY in the handler.
  // Covered by tests/unit/management-hub.test.js.
  /^\/v0\/management\/x$/,
];

function collectRoutes(dir, base = "/api") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const seg = entry.name.replace(/^\[\.\.\.(.+)\]$/, "x").replace(/^\[(.+)\]$/, "x");
      out.push(...collectRoutes(path.join(dir, entry.name), `${base}/${seg}`));
    } else if (entry.name === "route.js" || entry.name === "route.ts") {
      out.push(base);
    }
  }
  return out;
}

// A reverse-proxied deployment: its public name is on the Host allow-list.
process.env.ALLOWED_HOSTS = "regent.example.com";

const apiDir = path.join(import.meta.dirname, "../../src/app/api");
const v0Dir = path.join(import.meta.dirname, "../../src/app/v0");
const routes = [...collectRoutes(apiDir), ...collectRoutes(v0Dir, "/v0")].filter((p) => !PUBLIC.some((re) => re.test(p)));

function request(pathname, { cookie, headers = {} } = {}) {
  return {
    nextUrl: { pathname, searchParams: new URLSearchParams() },
    headers: new Headers({ host: "regent.example.com", ...headers }),
    cookies: { get: vi.fn((name) => (name === "auth_token" && cookie ? { value: cookie } : undefined)) },
    url: `https://regent.example.com${pathname}`,
  };
}

describe("dashboard API auth gate", () => {
  it("discovers the protected routes", () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes).toEqual(expect.arrayContaining(["/api/keys", "/api/keys/x", "/api/providers/x", "/api/settings", "/api/auth/oidc/test"]));
  });

  it.each(routes)("%s refuses an unauthenticated remote caller", async (route) => {
    const res = await proxy(request(route));
    expect(res).not.toBe(mocks.next);
    expect([401, 403]).toContain(res.status);
  });

  it.each(routes)("%s refuses a forged session cookie", async (route) => {
    const res = await proxy(request(route, { cookie: "forged" }));
    expect(res).not.toBe(mocks.next);
  });

  it("a valid session passes non-local-only routes", async () => {
    expect(await proxy(request("/api/keys", { cookie: "valid-session" }))).toBe(mocks.next);
    expect(await proxy(request("/api/providers/x", { cookie: "valid-session" }))).toBe(mocks.next);
  });

  it.each(routes)("%s refuses a valid API key presented as a bearer", async (route) => {
    const localDb = await import("@/lib/localDb");
    localDb.validateApiKey.mockResolvedValue(true);
    try {
      for (const headers of [{ authorization: "Bearer sk-valid" }, { "x-api-key": "sk-valid" }]) {
        const res = await proxy(request(route, { headers }));
        expect(res).not.toBe(mocks.next);
        expect([401, 403]).toContain(res.status);
      }
    } finally {
      localDb.validateApiKey.mockResolvedValue(false);
    }
  });

  it("the customer view is reachable without a session (its handler checks the key)", async () => {
    expect(await proxy(request("/api/customer/usage"))).toBe(mocks.next);
    // Exact path only: neighbours and sub-paths stay behind dashboard auth.
    for (const p of ["/api/customers", "/api/customer", "/api/customer/other", "/api/customer/usage/x"])
      expect(await proxy(request(p))).not.toBe(mocks.next);
  });

  it("local-only routes stay closed to a remote caller even with a valid session", async () => {
    for (const p of ["/api/cli-tools/claude-settings", "/api/mcp/x", "/api/tunnel/enable"]) {
      const res = await proxy(request(p, { cookie: "valid-session" }));
      expect(res.status).toBe(403);
    }
  });
});
