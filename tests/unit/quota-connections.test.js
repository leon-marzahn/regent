import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/oauth/providers", () => ({ backfillCodexEmails: vi.fn(async () => {}) }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => [
    {
      id: "c1",
      provider: "codex",
      authType: "oauth",
      email: "me@example.com",
      isActive: true,
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
      apiKey: "sk-secret",
      providerSpecificData: { accountId: "acct", idToken: "secret-id-token", workspaceId: "ws" },
    },
    { id: "c2", provider: "openrouter", authType: "apikey", apiKey: "sk-or-secret" },
    { id: "c3", provider: "minimax-code", authType: "mcode-lease", name: "MiniMax Desktop (Lease)" },
    { id: "c4", provider: "minimax-code", authType: "cookie" },
  ]),
}));

const { listQuotaConnections } = await import("@/lib/quotaConnections");

describe("listQuotaConnections (server-rendered into the Quota page)", () => {
  it("returns only quota-capable connections, without any credentials", async () => {
    const list = await listQuotaConnections();
    expect(list.map((c) => c.id)).toEqual(["c1", "c3"]);
    const json = JSON.stringify(list);
    for (const secret of ["secret-access", "secret-refresh", "sk-secret", "secret-id-token", "sk-or-secret"])
      expect(json).not.toContain(secret);
    expect(list[0]).toMatchObject({ id: "c1", provider: "codex", email: "me@example.com", providerSpecificData: { accountId: "acct" } });
  });
});
