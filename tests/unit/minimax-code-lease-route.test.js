// /api/oauth/minimax-code*/lease-{status,connect}: local-only inside the handler too,
// data dir from server config only (never the request), and the created connection
// stores no token.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  isLocalRequest: vi.fn(),
  hasValidCliToken: vi.fn(),
  requestLease: vi.fn(),
  requestStatus: vi.fn(),
  createProviderConnection: vi.fn(async (d) => ({ id: "conn-1", ...d })),
  getProviderConnections: vi.fn(async () => []),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body }),
  },
}));
vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(),
  generateAuthData: vi.fn(),
  exchangeTokens: vi.fn(),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));
vi.mock("@/models", () => ({ createProviderConnection: mocks.createProviderConnection }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: mocks.getProviderConnections }));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: mocks.isLocalRequest }));
vi.mock("@/lib/auth/cliToken", () => ({ hasValidCliToken: mocks.hasValidCliToken }));
vi.mock("@/lib/oauth/utils/server", () => {
  const out = {};
  for (const name of ["Codex", "Xai", "Trae", "Windsurf", "Zed", "XiaomiMimo"]) {
    for (const fn of [`start${name}Proxy`, `stop${name}Proxy`, `register${name}Session`, `get${name}SessionStatus`, `clear${name}Session`]) {
      out[fn] = () => null;
    }
  }
  return out;
});
vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));
vi.mock("open-sse/shared/mimoAccount.js", () => ({ readDesktopPassToken: vi.fn() }));
vi.mock("open-sse/services/minimaxCodeLease.js", async (orig) => ({
  ...(await orig()),
  requestLease: mocks.requestLease,
  requestStatus: mocks.requestStatus,
}));

const { GET, POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
const { DEFAULT_MCODE_DATA_DIR } = await import("../../open-sse/services/minimaxCodeLease.js");

const connect = (provider = "minimax-code", body = {}) =>
  POST(
    new Request(`http://localhost/api/oauth/${provider}/lease-connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ provider, action: "lease-connect" }) },
  );
const status = (query = "") =>
  GET(new Request(`http://localhost/api/oauth/minimax-code/lease-status${query}`), {
    params: Promise.resolve({ provider: "minimax-code", action: "lease-status" }),
  });

describe("MiniMax Code lease routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MINIMAX_DESKTOP_DATA_DIR;
    mocks.isLocalRequest.mockReturnValue(true);
    mocks.hasValidCliToken.mockResolvedValue(false);
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.requestLease.mockResolvedValue({ accessToken: "leased-secret", expiresAtMs: Date.now() + 300000 });
    mocks.requestStatus.mockResolvedValue({ status: "ready", generation: 1, expiresAtMs: 1 });
  });

  it("refuses non-local callers without a CLI token, even if the guard were skipped", async () => {
    mocks.isLocalRequest.mockReturnValue(false);
    expect((await connect()).status).toBe(403);
    expect((await status()).status).toBe(403);
    expect(mocks.requestLease).not.toHaveBeenCalled();
    expect(mocks.requestStatus).not.toHaveBeenCalled();
  });

  it("allows the local CLI token", async () => {
    mocks.isLocalRequest.mockReturnValue(false);
    mocks.hasValidCliToken.mockResolvedValue(true);
    expect((await connect()).status).toBe(200);
  });

  it("rejects other providers", async () => {
    expect((await connect("openai")).status).toBe(400);
  });

  it("ignores a caller-supplied data dir", async () => {
    await connect("minimax-code", { dataDir: "/var/run/docker.sock/.." });
    expect(mocks.requestLease).toHaveBeenCalledWith(DEFAULT_MCODE_DATA_DIR);
    await status("?data_dir=/tmp/evil");
    expect(mocks.requestStatus).toHaveBeenCalledWith(DEFAULT_MCODE_DATA_DIR);
  });

  it("creates a token-free connection and never echoes the leased token", async () => {
    const res = await connect();
    expect(res.status).toBe(200);
    const created = mocks.createProviderConnection.mock.calls[0][0];
    expect(created).toMatchObject({ provider: "minimax-code", authType: "mcode-lease" });
    for (const key of ["accessToken", "refreshToken", "apiKey", "providerSpecificData"]) {
      expect(created).not.toHaveProperty(key);
    }
    expect(JSON.stringify(res.body)).not.toContain("leased-secret");
  });

  it("reuses an existing lease connection", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "old", provider: "minimax-code", authType: "mcode-lease" }]);
    const res = await connect();
    expect(res.body).toMatchObject({ reused: true, connection: { id: "old" } });
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("maps non-lease errors to a generic message", async () => {
    mocks.requestLease.mockRejectedValue(new Error("EACCES /home/u/secret"));
    const res = await connect();
    expect(res.status).toBe(409);
    expect(res.body.error).not.toContain("/home/u");
  });

  it("lease-status does not report the data dir", async () => {
    const res = await status();
    expect(res.body).toEqual({ found: true, status: "ready", generation: 1, expiresAtMs: 1 });
  });
});
