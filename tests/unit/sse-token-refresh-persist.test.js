import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

// src/sse/services/tokenRefresh.js: request-path refresh + persistence of rotated credentials.
const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  refreshProviderCredentials: vi.fn(),
  shouldRefreshCredentials: vi.fn(),
  refreshCopilotToken: vi.fn(),
  refreshGitHubToken: vi.fn(),
  invalidateProjectId: vi.fn(),
  getProjectIdForConnection: vi.fn(),
  removeConnection: vi.fn(),
}));

vi.mock("../../src/sse/utils/logger.js", () => ({ info() {}, debug() {}, warn() {}, error() {} }));
vi.mock("../../src/lib/localDb.js", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: mocks.getProjectIdForConnection,
  invalidateProjectId: mocks.invalidateProjectId,
  removeConnection: mocks.removeConnection,
}));
vi.mock("open-sse/services/oauthCredentialManager.js", () => ({
  refreshProviderCredentials: mocks.refreshProviderCredentials,
  shouldRefreshCredentials: mocks.shouldRefreshCredentials,
}));
vi.mock("open-sse/services/tokenRefresh.js", async (orig) => ({
  ...(await orig()),
  refreshCopilotToken: mocks.refreshCopilotToken,
  refreshGitHubToken: mocks.refreshGitHubToken,
}));

const tr = await import("../../src/sse/services/tokenRefresh.js");

describe("updateProviderCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateProviderConnection.mockResolvedValue({ id: "c1" });
  });

  it("writes only present fields and derives expiresAt from expiresIn", async () => {
    const before = Date.now();
    expect(await tr.updateProviderCredentials("c1", { accessToken: "a", expiresIn: 3600, refreshToken: "" })).toBe(true);
    const [id, updates] = mocks.updateProviderConnection.mock.calls[0];
    expect(id).toBe("c1");
    expect(Object.keys(updates).sort()).toEqual(["accessToken", "expiresAt", "expiresIn"]);
    const exp = Date.parse(updates.expiresAt);
    expect(exp).toBeGreaterThanOrEqual(before + 3600_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 3600_000);
  });

  it("normalizes absolute expiresAt and merges providerSpecificData over existing", async () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    await tr.updateProviderCredentials("c1", {
      expiresAt: future,
      providerSpecificData: { b: 2 },
      existingProviderSpecificData: { a: 1, b: 1 },
      copilotToken: "cp",
      copilotTokenExpiresAt: 99,
    });
    const updates = mocks.updateProviderConnection.mock.calls[0][1];
    expect(updates.expiresAt).toBe(future);
    expect(updates.expiresIn).toBeGreaterThan(100);
    expect(updates.providerSpecificData).toEqual({ a: 1, b: 2, copilotToken: "cp", copilotTokenExpiresAt: 99 });
  });

  it("never persists a token borrowed from the MiniMax Code desktop broker", async () => {
    await tr.updateProviderCredentials("c1", { accessToken: "leased", leasedToken: true, testStatus: "active" });
    const updates = mocks.updateProviderConnection.mock.calls[0][1];
    expect(updates).not.toHaveProperty("accessToken");
    expect(JSON.stringify(updates)).not.toContain("leased");
  });

  it("returns false instead of throwing when the DB write fails", async () => {
    mocks.updateProviderConnection.mockRejectedValue(new Error("disk full"));
    expect(await tr.updateProviderCredentials("c1", { accessToken: "a" })).toBe(false);
  });
});

describe("checkAndRefreshToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateProviderConnection.mockResolvedValue({ id: "c1" });
    mocks.getProviderConnectionById.mockResolvedValue(null);
    mocks.shouldRefreshCredentials.mockReturnValue(false);
  });

  it("returns credentials untouched when no refresh is due", async () => {
    const creds = { id: "c1", accessToken: "a", refreshToken: "r" };
    const out = await tr.checkAndRefreshToken("claude", creds);
    expect(out).toMatchObject({ connectionId: "c1", accessToken: "a", refreshToken: "r" });
    expect(mocks.refreshProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("adopts a newer rotated refresh token from the DB before refreshing", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      refreshToken: "r2",
      accessToken: "a2",
      lastRefreshAt: "2026-01-02T00:00:00Z",
    });
    mocks.shouldRefreshCredentials.mockReturnValue(true);
    mocks.refreshProviderCredentials.mockResolvedValue({ accessToken: "a3", refreshToken: "r3", expiresIn: 60 });

    const out = await tr.checkAndRefreshToken("codex", {
      connectionId: "c1",
      refreshToken: "r1",
      accessToken: "a1",
      lastRefreshAt: "2026-01-01T00:00:00Z",
    });
    expect(mocks.refreshProviderCredentials.mock.calls[0][1].refreshToken).toBe("r2");
    expect(out).toMatchObject({ accessToken: "a3", refreshToken: "r3" });
    expect(mocks.updateProviderConnection.mock.calls[0][1]).toMatchObject({ accessToken: "a3", refreshToken: "r3" });
  });

  it("keeps its own tokens when the DB copy is older", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({ refreshToken: "old", lastRefreshAt: "2025-01-01T00:00:00Z" });
    mocks.shouldRefreshCredentials.mockReturnValue(true);
    mocks.refreshProviderCredentials.mockResolvedValue(null);
    const out = await tr.checkAndRefreshToken("codex", {
      connectionId: "c1",
      refreshToken: "mine",
      lastRefreshAt: "2026-01-01T00:00:00Z",
    });
    expect(mocks.refreshProviderCredentials.mock.calls[0][1].refreshToken).toBe("mine");
    expect(out.refreshToken).toBe("mine");
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("force=true refreshes even when not near expiry", async () => {
    mocks.refreshProviderCredentials.mockResolvedValue({ accessToken: "fresh" });
    const out = await tr.checkAndRefreshToken("claude", { connectionId: "c1", accessToken: "a" }, { force: true });
    expect(out.accessToken).toBe("fresh");
  });

  it("refreshes a missing GitHub Copilot token and persists it", async () => {
    mocks.refreshCopilotToken.mockResolvedValue({ token: "cp", expiresAt: 123 });
    const out = await tr.checkAndRefreshToken("github", {
      connectionId: "c1",
      accessToken: "gh",
      providerSpecificData: { keep: true },
    });
    expect(mocks.refreshCopilotToken.mock.calls[0][0]).toBe("gh");
    expect(out.copilotToken).toBe("cp");
    expect(out.providerSpecificData).toEqual({ keep: true, copilotToken: "cp", copilotTokenExpiresAt: 123 });
    expect(mocks.updateProviderConnection).toHaveBeenCalledTimes(1);
  });

  it("does not refresh a GitHub Copilot token that is still valid", async () => {
    const later = Math.floor(Date.now() / 1000) + 3600;
    await tr.checkAndRefreshToken("github", {
      connectionId: "c1",
      accessToken: "gh",
      providerSpecificData: { copilotToken: "cp", copilotTokenExpiresAt: later },
    });
    expect(mocks.refreshCopilotToken).not.toHaveBeenCalled();
  });
});

describe("refreshGitHubAndCopilotTokens", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns GitHub creds alone if the Copilot exchange fails", async () => {
    mocks.refreshGitHubToken.mockResolvedValue({ accessToken: "gh2" });
    mocks.refreshCopilotToken.mockResolvedValue(null);
    expect(await tr.refreshGitHubAndCopilotTokens({ refreshToken: "r" })).toEqual({ accessToken: "gh2" });
  });

  it("merges a fresh Copilot token into providerSpecificData", async () => {
    mocks.refreshGitHubToken.mockResolvedValue({ accessToken: "gh2" });
    mocks.refreshCopilotToken.mockResolvedValue({ token: "cp", expiresAt: 5 });
    expect(await tr.refreshGitHubAndCopilotTokens({ refreshToken: "r" })).toEqual({
      accessToken: "gh2",
      providerSpecificData: { copilotToken: "cp", copilotTokenExpiresAt: 5 },
    });
  });

  it("skips the Copilot exchange when GitHub refresh fails", async () => {
    mocks.refreshGitHubToken.mockResolvedValue(null);
    expect(await tr.refreshGitHubAndCopilotTokens({ refreshToken: "r" })).toBe(null);
    expect(mocks.refreshCopilotToken).not.toHaveBeenCalled();
  });
});
