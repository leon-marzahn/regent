import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";

// A request whose upstream certificate fails verification must not be replayed with
// verification off by default: that hands the request (and its provider credentials)
// to whoever presented the bad certificate. The fallback is opt-in.
const certError = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } });

describe("proxyFetch insecure-TLS fallback is opt-in", () => {
  const savedEnv = { ...process.env };
  let fetchMock;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...savedEnv };
    for (const k of ["REGENT_ALLOW_INSECURE_TLS", "STRICT_SSL", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
      delete process.env[k];
    }
    fetchMock = vi.fn()
      .mockRejectedValueOnce(certError())
      .mockResolvedValue(new Response("ok"));
    // proxyFetch sends through the undici package's fetch.
    vi.doMock("undici", async (importOriginal) => ({ ...(await importOriginal()), fetch: fetchMock }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.doUnmock("undici");
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  const load = () => import("../../open-sse/utils/proxyFetch.js");
  const URL_ = "https://api.example-upstream.com/v1/chat/completions";
  const OPTS = { method: "POST", headers: { Authorization: "Bearer sk-secret" }, body: "{}" };

  it("fails closed by default and never replays the request", async () => {
    const { proxyAwareFetch } = await load();
    await expect(proxyAwareFetch(URL_, OPTS)).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(console.warn.mock.calls[0]?.[0])).toMatch(/NODE_EXTRA_CA_CERTS/);
    expect(String(console.warn.mock.calls[0]?.[0])).not.toMatch(/sk-secret/);
  });

  it("gives the fail-closed hint once per host, not once per process", async () => {
    fetchMock.mockReset().mockRejectedValue(certError());
    const { proxyAwareFetch } = await load();
    const hints = () => console.warn.mock.calls.filter((c) => /NODE_EXTRA_CA_CERTS/.test(String(c[0]))).length;
    await proxyAwareFetch(URL_, OPTS).catch(() => {});
    await proxyAwareFetch(`${URL_}?again=1`, OPTS).catch(() => {});
    expect(hints()).toBe(1);
    await proxyAwareFetch("https://other-upstream.example/v1", OPTS).catch(() => {});
    expect(hints()).toBe(2);
  });

  it("bounds the hint's host memory and tolerates unparsable URLs", async () => {
    const { createTlsFailureHint } = await import("../../open-sse/utils/tlsFailureHint.js");
    const warn = vi.fn();
    const hint = createTlsFailureHint({ warn, mask: (s) => s.replace(/key=[^&]+/, "key=[REDACTED]") });
    const err = certError();
    expect(hint("not a url", err)).toBe(true);
    expect(hint("https://h.test/?key=sk-1", err)).toBe(true);
    expect(warn.mock.calls[1][0]).toMatch(/key=\[REDACTED\]/);
    expect(warn.mock.calls[1][0]).toMatch(/SELF_SIGNED_CERT_IN_CHAIN/);
    for (let i = 0; i < 100; i++) hint(`https://h${i}.example/`, err);
    expect(warn).toHaveBeenCalledTimes(64);
  });

  it("retries with an insecure dispatcher only when REGENT_ALLOW_INSECURE_TLS is set", async () => {
    process.env.REGENT_ALLOW_INSECURE_TLS = "1";
    const { proxyAwareFetch } = await load();
    const res = await proxyAwareFetch(URL_, OPTS);
    expect(await res.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].dispatcher).toBeTruthy();
  });

  it("STRICT_SSL and strictTls still veto the opt-in", async () => {
    process.env.REGENT_ALLOW_INSECURE_TLS = "true";
    process.env.STRICT_SSL = "1";
    const { allowInsecureTlsFallback } = await load();
    expect(allowInsecureTlsFallback()).toBe(false);
    delete process.env.STRICT_SSL;
    expect(allowInsecureTlsFallback({ strictTls: true })).toBe(false);
    expect(allowInsecureTlsFallback()).toBe(true);
    process.env.REGENT_ALLOW_INSECURE_TLS = "yes";
    expect(allowInsecureTlsFallback()).toBe(false);
  });
});

// The MITM server is a standalone process that starts listening on load, so guard its
// upstream TLS options at the source: every outbound connection uses the shared flag.
describe("MITM passthrough verifies upstream certificates", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "../../src/mitm/server.js"), "utf8");

  it("never hard-codes rejectUnauthorized: false for upstream connections", () => {
    expect(src).not.toMatch(/rejectUnauthorized:\s*false/);
    expect(src.match(/rejectUnauthorized:\s*VERIFY_UPSTREAM_TLS/g)).toHaveLength(3);
  });

  it("only skips verification on the explicit opt-in, and STRICT_SSL vetoes it", async () => {
    const { verifyUpstreamTls } = await import("../../src/mitm/tlsVerify.js");
    expect(verifyUpstreamTls({})).toBe(true);
    expect(verifyUpstreamTls({ REGENT_ALLOW_INSECURE_TLS: "yes" })).toBe(true);
    expect(verifyUpstreamTls({ REGENT_ALLOW_INSECURE_TLS: "1" })).toBe(false);
    expect(verifyUpstreamTls({ REGENT_ALLOW_INSECURE_TLS: "true", STRICT_SSL: "1" })).toBe(true);
    expect(src).toMatch(/const VERIFY_UPSTREAM_TLS = verifyUpstreamTls\(\);/);
  });
});
