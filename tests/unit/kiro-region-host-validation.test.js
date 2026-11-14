import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

// The stored Kiro region (and the region segment of profileArn) is credential
// data that ends up in a hostname receiving a bearer token or client secret.
// A malformed value must never move that request off *.amazonaws.com.
const HOSTILE_REGIONS = ["x.attacker.tld#", "evil.example/", "us-east-1.attacker.tld", "a@attacker.tld"];

const originalFetch = global.fetch;

function okJson(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

// Each case cold-imports the token-refresh graph after vi.resetModules(), which can
// exceed the 5s default under full-suite load (it passes in isolation).
describe("Kiro region host validation", { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
    global.fetch = originalFetch;
  });

  it.each(HOSTILE_REGIONS)("keeps the IDC token refresh on AWS for region %j", async (region) => {
    const proxyAwareFetch = vi.fn().mockResolvedValue(okJson({ accessToken: "a", refreshToken: "r", expiresIn: 3600 }));
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

    const { refreshKiroToken } = await import("../../open-sse/services/tokenRefresh.js");
    await refreshKiroToken(`refresh-${region}`, { authMethod: "idc", clientId: "cid", clientSecret: "secret", region });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const url = new URL(proxyAwareFetch.mock.calls[0][0]);
    expect(url.hostname).toBe("oidc.us-east-1.amazonaws.com");
  });

  it("still uses a well-formed IDC region for the token refresh", async () => {
    const proxyAwareFetch = vi.fn().mockResolvedValue(okJson({ accessToken: "a", refreshToken: "r", expiresIn: 3600 }));
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

    const { refreshKiroToken } = await import("../../open-sse/services/tokenRefresh.js");
    await refreshKiroToken("refresh-eu", { authMethod: "idc", clientId: "cid", clientSecret: "secret", region: "eu-west-1" });

    expect(new URL(proxyAwareFetch.mock.calls[0][0]).hostname).toBe("oidc.eu-west-1.amazonaws.com");
  });

  it.each(HOSTILE_REGIONS)("keeps the model catalog fetch on AWS for profileArn region %j", async (region) => {
    const { resolveKiroModels, clearKiroModelCache } = await import("../../open-sse/services/kiroModels.js");
    // Assigned after import: the import graph installs the proxy-aware global fetch.
    const fetchMock = vi.fn().mockResolvedValue(okJson({ models: [] }));
    global.fetch = fetchMock;
    clearKiroModelCache();
    await resolveKiroModels({
      accessToken: "token",
      providerSpecificData: { profileArn: `arn:aws:codewhisperer:${region}:123456789012:profile/ABC` },
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(new URL(fetchMock.mock.calls[0][0]).hostname).toBe("q.us-east-1.amazonaws.com");
  });
});
