// Opt-in wreq-js TLS impersonation: per-connection config, fail-open fallback to
// native fetch, and SSE streaming through the real binding when installed.
import http from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

// The native path is the undici package's fetch (proxyFetch's transport).
const nativeFetch = vi.hoisted(() => vi.fn(async () => new Response("native", { status: 200 })));
vi.mock("undici", async (importOriginal) => ({ ...(await importOriginal()), fetch: nativeFetch }));

const { wreqFetch, __setWreqLoaderForTests } =
  await import("../../open-sse/utils/tlsImpersonation.js");
const { normalizeTlsImpersonation } = await import("../../open-sse/config/tlsImpersonation.js");
const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

const CHROME = { browser: "chrome", os: "macos" };

function fakeWreq(impl) {
  const fetch = vi.fn(impl);
  __setWreqLoaderForTests(async () => ({ fetch }));
  return fetch;
}

afterEach(() => {
  __setWreqLoaderForTests(null);
  nativeFetch.mockClear();
  vi.restoreAllMocks();
});

describe("normalizeTlsImpersonation", () => {
  it("is off for missing, non-object or disabled values", () => {
    expect(normalizeTlsImpersonation(undefined)).toBeNull();
    expect(normalizeTlsImpersonation("chrome")).toBeNull();
    expect(normalizeTlsImpersonation({ enabled: false, browser: "chrome" })).toBeNull();
  });

  it("keeps known profile/os and defaults unknown ones", () => {
    expect(normalizeTlsImpersonation({ browser: "firefox", os: "windows" })).toEqual({
      browser: "firefox",
      os: "windows",
    });
    expect(normalizeTlsImpersonation({ browser: "--evil", os: 1 })).toEqual(CHROME);
  });
});

describe("wreqFetch", () => {
  it("passes profile, proxy, signal and only our headers; disables wreq timeout", async () => {
    const wfetch = fakeWreq(
      async () =>
        new Response("ok", { status: 201, headers: { "content-encoding": "gzip", "x-a": "1" } }),
    );
    const signal = new AbortController().signal;
    const res = await wreqFetch(
      "https://api.example.com/v1",
      { method: "POST", headers: new Headers({ authorization: "Bearer t" }), body: "{}", signal },
      CHROME,
      "http://user:pw@proxy:8080",
    );
    const [, init] = wfetch.mock.calls[0];
    expect(init).toMatchObject({
      method: "POST",
      body: "{}",
      signal,
      browser: "chrome",
      os: "macos",
      proxy: "http://user:pw@proxy:8080",
      disableDefaultHeaders: true,
      timeout: 0,
    });
    expect(init.headers).toEqual({ authorization: "Bearer t" });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(201);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("x-a")).toBe("1");
    expect(await res.text()).toBe("ok");
  });

  it("returns null and logs once when the binding fails to load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __setWreqLoaderForTests(async () => {
      throw new Error("no prebuild");
    });
    expect(await wreqFetch("https://a.test", {}, CHROME)).toBeNull();
    expect(await wreqFetch("https://a.test", {}, CHROME)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns null on transport error without leaking proxy credentials", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeWreq(async () => {
      throw new Error("connect failed via http://user:secret@proxy:8080");
    });
    expect(
      await wreqFetch("https://a.test", {}, CHROME, "http://user:secret@proxy:8080"),
    ).toBeNull();
    expect(warn.mock.calls[0][0]).not.toContain("secret");
  });

  it("rethrows aborts instead of falling back", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    fakeWreq(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(wreqFetch("https://a.test", { signal: ctrl.signal }, CHROME)).rejects.toThrow(
      "aborted",
    );
  });

  it("skips non-replayable stream bodies", async () => {
    const wfetch = fakeWreq(async () => new Response("x"));
    expect(await wreqFetch("https://a.test", { body: new ReadableStream() }, CHROME)).toBeNull();
    expect(wfetch).not.toHaveBeenCalled();
  });
});

describe("proxyAwareFetch transport selection", () => {
  it("uses native fetch when impersonation is not requested", async () => {
    const wfetch = fakeWreq(async () => new Response("wreq"));
    const res = await proxyAwareFetch("https://a.test", {}, {});
    expect(await res.text()).toBe("native");
    expect(wfetch).not.toHaveBeenCalled();
  });

  it("uses wreq-js when proxyOptions.tlsImpersonation is set", async () => {
    fakeWreq(async () => new Response("wreq"));
    const res = await proxyAwareFetch("https://a.test", {}, { tlsImpersonation: CHROME });
    expect(await res.text()).toBe("wreq");
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("falls back to native fetch when wreq-js errors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeWreq(async () => {
      throw new Error("boom");
    });
    const res = await proxyAwareFetch("https://a.test", {}, { tlsImpersonation: CHROME });
    expect(await res.text()).toBe("native");
  });

  it("hands the resolved connection proxy to wreq-js", async () => {
    const wfetch = fakeWreq(async () => new Response("wreq"));
    await proxyAwareFetch(
      "https://a.test",
      {},
      {
        tlsImpersonation: CHROME,
        connectionProxyEnabled: true,
        connectionProxyUrl: "127.0.0.1:7890",
      },
    );
    expect(wfetch.mock.calls[0][1].proxy).toBe("http://127.0.0.1:7890");
  });
});

let realWreq = null;
beforeAll(async () => {
  realWreq = await import("wreq-js").catch(() => null);
});

describe("real wreq-js binding", () => {
  it("streams SSE chunks incrementally", async (ctx) => {
    if (!realWreq) ctx.skip();
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      setTimeout(() => {
        res.write("data: 2\n\n");
        res.end();
      }, 150);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${server.address().port}/sse`;
      const res = await wreqFetch(url, { method: "GET" }, CHROME);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const first = await reader.read();
      expect(dec.decode(first.value)).toContain("data: 1");
      let rest = "";
      for (let c = await reader.read(); !c.done; c = await reader.read())
        rest += dec.decode(c.value);
      expect(rest).toContain("data: 2");
    } finally {
      server.close();
    }
  });
});
