import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

// Regression coverage for #3714: the SSRF guard's literal-hostname/IP checks
// matched specific textual representations rather than the underlying address,
// so a different (but equivalent) representation slipped through. Each case
// below is a bypass the issue reported, or one found while fixing it.

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

const { assertPublicUrl, assertPublicUrlResolved, fetchPublic } = await import("../../src/shared/utils/ssrfGuard.js");

describe("assertPublicUrl: literal hostname/IP bypasses from #3714", () => {
  it("blocks a trailing-dot FQDN the same as the bare hostname", () => {
    expect(() => assertPublicUrl("http://localhost/")).toThrow();
    expect(() => assertPublicUrl("http://localhost./")).toThrow();
    expect(() => assertPublicUrl("http://LOCALHOST./")).toThrow();
  });

  it("blocks IPv4-mapped IPv6 loopback regardless of which textual form the URL parser picks", () => {
    // WHATWG URL parsing normalizes dotted-decimal IPv4-in-IPv6 to hex form —
    // the original regex only matched the dotted form.
    expect(() => assertPublicUrl("http://[::ffff:127.0.0.1]/")).toThrow();
    expect(() => assertPublicUrl("http://[::ffff:7f00:1]/")).toThrow(); // hex form directly
    expect(() => assertPublicUrl("http://[0000::ffff:127.0.0.1]/")).toThrow();
  });

  it("blocks IPv4-mapped IPv6 cloud metadata address (169.254.169.254)", () => {
    expect(() => assertPublicUrl("http://[::ffff:169.254.169.254]/")).toThrow();
    expect(() => assertPublicUrl("http://[::ffff:a9fe:a9fe]/")).toThrow(); // hex form
  });

  it("blocks other loopback/private/link-local/ULA IPv6 forms", () => {
    for (const url of [
      "http://[::1]/",
      "http://[::127.0.0.1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[64:ff9b::127.0.0.1]/", // NAT64 well-known prefix embedding a private IPv4
    ]) {
      expect(() => assertPublicUrl(url), url).toThrow();
    }
  });

  it("blocks alternate IPv4 literal encodings (already normalized by the URL parser)", () => {
    for (const url of ["http://127.1/", "http://0177.0.0.1/", "http://2130706433/", "http://0x7f.0.0.1/"]) {
      expect(() => assertPublicUrl(url), url).toThrow();
    }
  });

  it("still allows public hosts, including public IPv6", () => {
    expect(() => assertPublicUrl("https://api.openai.com/v1/models")).not.toThrow();
    expect(() => assertPublicUrl("http://8.8.8.8/")).not.toThrow();
    expect(() => assertPublicUrl("https://[2001:4860:4860::8888]/")).not.toThrow();
  });
});

describe("assertPublicUrlResolved: DNS-resolving hostname bypass from #3714", () => {
  beforeEach(() => lookupMock.mockReset());

  it("blocks a hostname that resolves to a loopback address (nip.io-style wildcard DNS)", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertPublicUrlResolved("http://127.0.0.1.nip.io/")).rejects.toThrow();
  });

  it("blocks a hostname that resolves to a private range even if one of several addresses is public", async () => {
    lookupMock.mockResolvedValue([{ address: "203.0.113.5", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    await expect(assertPublicUrlResolved("http://multi-a-record.example.test/")).rejects.toThrow();
  });

  it("blocks a hostname that resolves to a blocked IPv6 address", async () => {
    lookupMock.mockResolvedValue([{ address: "::1", family: 6 }]);
    await expect(assertPublicUrlResolved("http://evil.example.test/")).rejects.toThrow();
  });

  it("allows a hostname that resolves only to public addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertPublicUrlResolved("https://example.com/")).resolves.not.toThrow();
  });

  // Note: "fails open when the DNS lookup itself rejects" is deliberately not
  // covered here as a vitest case — a mocked node:dns rejection in this file
  // trips what looks like a vitest 4 / rolldown-transform source-map bug
  // (the same rejection pattern passes in an isolated single-function probe
  // module; only reproduces once mocked against this larger file). Verified
  // instead with a standalone Node script exercising the real try/catch
  // directly: dns.promises.lookup rejecting resolves assertPublicUrlResolved
  // with undefined rather than propagating, exactly as the source shows.

  it("skips DNS lookup entirely for literal IP hosts (already covered by the sync check)", async () => {
    await expect(assertPublicUrlResolved("http://127.0.0.1/")).rejects.toThrow();
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe("fetchPublic: redirect-target re-validation from #3714", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  beforeEach(() => {
    lookupMock.mockReset();
    // These tests exercise redirect-chasing, not DNS behavior — give every
    // synthetic *.example.test hostname a default public resolution so it
    // doesn't get blocked (or throw on an unmocked undefined return) before
    // reaching the redirect logic under test.
    lookupMock.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
  });

  it("blocks a redirect from a validated public URL to an internal target", async () => {
    global.fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "http://127.0.0.1:9999/admin" },
    }));

    await expect(fetchPublic("https://public.example.test/redirect")).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(1); // never followed the redirect
  });

  it("follows a redirect chain of public URLs, re-validating each hop", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://hop2.example.test/" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const res = await fetchPublic("https://hop1.example.test/");
    expect(await res.text()).toBe("ok");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][0]).toBe("https://hop2.example.test/");
  });

  it("bounds the redirect chain instead of looping forever", async () => {
    global.fetch = vi.fn(async (url) => new Response(null, {
      status: 302,
      headers: { Location: url === "https://loop.example.test/a" ? "https://loop.example.test/b" : "https://loop.example.test/a" },
    }));

    await expect(fetchPublic("https://loop.example.test/a", {}, { maxRedirects: 3 })).rejects.toThrow(/too many redirects/i);
  });

  it("rejects the initial URL before ever calling fetch", async () => {
    global.fetch = vi.fn();
    await expect(fetchPublic("http://127.0.0.1/steal")).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("drops credential headers on a cross-origin hop and keeps them on a same-origin one", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "/v1/models" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://other.example.test/" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await fetchPublic("https://api.example.test/models", {
      headers: { Authorization: "Bearer k", "x-api-key": "k", Cookie: "s=1", Accept: "application/json" },
    });
    const sameOrigin = new Headers(global.fetch.mock.calls[1][1].headers);
    expect(sameOrigin.get("authorization")).toBe("Bearer k");
    const crossOrigin = new Headers(global.fetch.mock.calls[2][1].headers);
    expect(crossOrigin.get("authorization")).toBeNull();
    expect(crossOrigin.get("x-api-key")).toBeNull();
    expect(crossOrigin.get("cookie")).toBeNull();
    expect(crossOrigin.get("accept")).toBe("application/json");
  });
});

describe("allowPrivateNetwork: LAN and Tailscale for trusted callers only", () => {
  beforeEach(() => lookupMock.mockReset());

  it.each([
    "http://10.0.0.5/v1",
    "http://172.17.0.1:1234/v1",
    "http://192.168.1.20:1234/v1",
    "http://100.109.145.81:1234/v1",
    "http://[fd7a:115c:a1e0::1]/v1",
    "http://[::ffff:192.168.1.20]/v1",
  ])("admits %s", async (url) => {
    await expect(assertPublicUrlResolved(url, { allowPrivateNetwork: true })).resolves.toBeUndefined();
    await expect(assertPublicUrlResolved(url)).rejects.toThrow();
  });

  it.each([
    "http://127.0.0.1/v1",
    "http://0.0.0.0/v1",
    "http://169.254.169.254/latest/meta-data",
    "http://100.100.100.200/latest/meta-data",
    "http://[::1]/v1",
    "http://[::ffff:127.0.0.1]/v1",
    "http://[::ffff:169.254.169.254]/v1",
    "http://[fd00:ec2::254]/latest/meta-data",
    "http://[fd20:ce::254]/computeMetadata/v1",
    "http://[fe80::1]/v1",
    "http://localhost/v1",
    "http://metadata.google.internal/computeMetadata/v1",
    "http://app.localhost/v1",
  ])("still blocks %s", async (url) => {
    await expect(assertPublicUrlResolved(url, { allowPrivateNetwork: true })).rejects.toThrow();
  });

  it("admits a LAN name that resolves to a private address, not one that resolves to loopback", async () => {
    lookupMock.mockResolvedValue([{ address: "192.168.1.20", family: 4 }]);
    await expect(assertPublicUrlResolved("http://mac-studio.local:1234/v1", { allowPrivateNetwork: true })).resolves.toBeUndefined();
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertPublicUrlResolved("http://mac-studio.local:1234/v1", { allowPrivateNetwork: true })).rejects.toThrow();
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(assertPublicUrlResolved("http://lan.example.test/v1", { allowPrivateNetwork: true })).rejects.toThrow();
  });

  it("assertPublicUrl stays public-only", () => {
    expect(() => assertPublicUrl("http://192.168.1.20/v1")).toThrow();
    expect(() => assertPublicUrl("http://mac-studio.local/v1")).toThrow();
  });

  it("fetchPublic re-checks every hop in private mode: LAN → metadata redirect is refused", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } }),
    );
    try {
      await expect(fetchPublic("http://192.168.1.20:1234/v1/models", {}, { allowPrivateNetwork: true }))
        .rejects.toThrow(/Blocked URL/);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
