// proxyAwareFetch routing guarantees around protocol adapters (directFetch) and
// the MITM-bypass hosts, plus the direct-dispatcher cache:
// - a proxy-capable adapter gets the proxy URL and its failure is never replayed
//   outside the proxy;
// - an adapter that is not proxy-capable is skipped when a proxy is set, so it
//   cannot leave over the direct interface;
// - the routing log names only scheme://host:port and the target host, never
//   proxy credentials or the request path/query;
// - a strict proxy on a MITM-bypass host refuses the direct DNS-bypass path.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  getDirectDispatcher,
  proxyAwareFetch,
  resetDirectDispatchersForTests,
} from "../../open-sse/utils/proxyFetch.js";
import { PROXY_UNAVAILABLE } from "../../open-sse/utils/proxyScope.js";

// Port 1 on loopback refuses immediately: a dead proxy without network access.
const DEAD_PROXY = "http://127.0.0.1:1";

function adapter(impl) {
  const fn = vi.fn(impl);
  fn.proxyCapable = true;
  return fn;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetDirectDispatchersForTests();
});

describe("proxy-capable directFetch adapters", () => {
  it("hands the proxy URL to the adapter and logs a credential-free route", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const directFetch = adapter(async () => new Response("ok", { status: 201 }));
    const proxy = "http://alice:s3cret@proxy.test:8080";

    const res = await proxyAwareFetch(
      "https://api.example.com/v1/chat?key=QUERY_SECRET",
      { method: "POST", directFetch },
      { enabled: true, url: proxy },
    );

    expect(res.status).toBe(201);
    expect(directFetch).toHaveBeenCalledTimes(1);
    const [, init, proxyArg] = directFetch.mock.calls[0];
    expect(init.proxyUrl).toBe(proxy);
    expect(proxyArg).toBe(proxy);

    const line = log.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("PROXY ROUTING VERIFIED"));
    expect(line).toContain("| api.example.com |");
    expect(line).toContain("proxy=http://proxy.test:8080");
    expect(line).toContain("status=201");
    expect(line).not.toContain("s3cret");
    expect(line).not.toContain("QUERY_SECRET");
  });

  it("labels an unparseable proxy and target instead of echoing them", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const directFetch = adapter(async () => new Response("ok"));

    await proxyAwareFetch("not a url", { directFetch }, { enabled: true, url: "bad host:secret" });

    const line = log.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("PROXY ROUTING VERIFIED"));
    expect(line).toContain("| unparseable-url |");
    expect(line).toContain("proxy=unparseable-proxy-url");
    expect(line).not.toContain("secret");
  });

  it("rethrows an adapter failure without retrying directly (non-strict)", async () => {
    const boom = new Error("tunnel reset");
    const directFetch = adapter(async () => {
      throw boom;
    });
    await expect(
      proxyAwareFetch("https://api.example.com/x", { directFetch }, { enabled: true, url: DEAD_PROXY }),
    ).rejects.toBe(boom);
    expect(directFetch).toHaveBeenCalledTimes(1);
  });

  it("turns an adapter failure into PROXY_UNAVAILABLE under strictProxy, with credentials redacted", async () => {
    const onProxyUnavailable = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const directFetch = adapter(async () => {
      throw new Error("connect failed via http://bob:hunter2@proxy.test:3128");
    });
    const err = await proxyAwareFetch(
      "https://api.example.com/x",
      { directFetch },
      { enabled: true, url: "http://bob:hunter2@proxy.test:3128", strictProxy: true, onProxyUnavailable },
    ).catch((e) => e);

    expect(err.code).toBe(PROXY_UNAVAILABLE);
    expect(err.message).not.toContain("hunter2");
    expect(onProxyUnavailable).toHaveBeenCalledWith(err);
    expect(directFetch).toHaveBeenCalledTimes(1);
  });

  it("passes an abort through untouched even under strictProxy", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const directFetch = adapter(async () => {
      throw abort;
    });
    await expect(
      proxyAwareFetch("https://api.example.com/x", { directFetch }, { enabled: true, url: DEAD_PROXY, strictProxy: true }),
    ).rejects.toBe(abort);
  });

  it("does not use an adapter that is not proxy-capable when a proxy is set", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const directFetch = vi.fn(async () => new Response("direct!"));
    const err = await proxyAwareFetch(
      "https://api.example.com/x",
      { directFetch },
      { enabled: true, url: DEAD_PROXY, strictProxy: true },
    ).catch((e) => e);

    expect(err.code).toBe(PROXY_UNAVAILABLE);
    expect(directFetch).not.toHaveBeenCalled();
  });
});

describe("MITM-bypass hosts", () => {
  it("refuses the direct DNS-bypass path when a strict proxy fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = await proxyAwareFetch(
      "https://api2.cursor.sh/aiserver.v1.ChatService/StreamChat",
      { method: "POST" },
      { enabled: true, url: DEAD_PROXY, strictProxy: true },
    ).catch((e) => e);
    expect(err.code).toBe(PROXY_UNAVAILABLE);
  });
});

describe("direct dispatcher cache", () => {
  it("shares one agent per TLS mode and keep-alive setting", async () => {
    const secure = await getDirectDispatcher();
    expect(await getDirectDispatcher()).toBe(secure);
    expect(await getDirectDispatcher(true)).not.toBe(secure);
    vi.stubEnv("FETCH_KEEPALIVE_TIMEOUT_MS", "12345");
    expect(await getDirectDispatcher()).not.toBe(secure);
  });

  it("evicts the oldest agent once the cache is full", async () => {
    vi.stubEnv("FETCH_KEEPALIVE_TIMEOUT_MS", "1000");
    const first = await getDirectDispatcher();
    // proxyDispatchersMaxSize (20) distinct keep-alive keys push the first out.
    for (let i = 1; i <= 20; i++) {
      vi.stubEnv("FETCH_KEEPALIVE_TIMEOUT_MS", String(1000 + i));
      await getDirectDispatcher();
    }
    vi.stubEnv("FETCH_KEEPALIVE_TIMEOUT_MS", "1000");
    expect(await getDirectDispatcher()).not.toBe(first);
  });
});
