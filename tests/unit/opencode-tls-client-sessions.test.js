import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

// Session lifecycle of the impersonated-TLS client: the per-proxy cache is
// bounded (oldest identity evicted and closed), reset closes everything, and a
// transport error that is not an Error instance is passed through unchanged.
const { createSessionMock, loadRuntimeDepMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  loadRuntimeDepMock: vi.fn(),
}));

vi.mock("../../open-sse/services/lazyRuntime.js", () => ({
  loadRuntimeDep: loadRuntimeDepMock,
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("opencodeTlsClient session cache", () => {
  let sessions;

  beforeEach(() => {
    vi.resetModules();
    sessions = [];
    createSessionMock.mockReset();
    loadRuntimeDepMock.mockReset();
    loadRuntimeDepMock.mockResolvedValue({ createSession: createSessionMock });
    createSessionMock.mockImplementation(async (options) => {
      const session = {
        options,
        close: vi.fn(),
        fetch: vi.fn(async () => new Response("ok", { status: 200 })),
      };
      sessions.push(session);
      return session;
    });
  });

  it("evicts and closes the oldest proxy session once eight are cached", async () => {
    const { opencodeTlsFetch, __test__ } = await import("../../open-sse/services/opencodeTlsClient.js");
    for (let i = 0; i < 8; i++) {
      await opencodeTlsFetch("https://opencode.ai/x", {}, { proxyUrl: `http://user:pw@proxy${i}.test:8080` });
    }
    expect(__test__.sessionsByProxy.size).toBe(8);
    expect(sessions[0].close).not.toHaveBeenCalled();

    await opencodeTlsFetch("https://opencode.ai/x", {}, { proxyUrl: "http://proxy8.test:8080" });
    await flush();

    expect(__test__.sessionsByProxy.size).toBe(8);
    expect(__test__.sessionsByProxy.has("http://user:pw@proxy0.test:8080")).toBe(false);
    expect(sessions[0].close).toHaveBeenCalledTimes(1);
    expect(sessions[1].close).not.toHaveBeenCalled();
  });

  it("resetOpencodeTlsSession closes cached sessions and the next call builds a new one", async () => {
    const { opencodeTlsFetch, resetOpencodeTlsSession, __test__ } = await import(
      "../../open-sse/services/opencodeTlsClient.js"
    );
    await opencodeTlsFetch("https://opencode.ai/a", {});
    await opencodeTlsFetch("https://opencode.ai/a", {}, { proxyUrl: "socks5://p.test:1080" });
    expect(createSessionMock).toHaveBeenCalledTimes(2);

    resetOpencodeTlsSession();
    await flush();
    expect(__test__.sessionsByProxy.size).toBe(0);
    expect(sessions[0].close).toHaveBeenCalledTimes(1);
    expect(sessions[1].close).toHaveBeenCalledTimes(1);

    await opencodeTlsFetch("https://opencode.ai/a", {});
    expect(createSessionMock).toHaveBeenCalledTimes(3);
  });

  it("reports a wreq-js build without createSession as unavailable and retries next time", async () => {
    loadRuntimeDepMock.mockResolvedValueOnce({});
    const { opencodeTlsFetch, OpencodeTlsUnavailableError, __test__ } = await import(
      "../../open-sse/services/opencodeTlsClient.js"
    );
    const err = await opencodeTlsFetch("https://opencode.ai/a", {}).catch((e) => e);
    expect(err).toBeInstanceOf(OpencodeTlsUnavailableError);
    expect(err.message).toContain("wreq-js runtime is missing createSession");
    expect(__test__.sessionsByProxy.size).toBe(0);

    const res = await opencodeTlsFetch("https://opencode.ai/a", {});
    expect(res.status).toBe(200);
  });

  it("rethrows a non-Error rejection from a proxied fetch as-is", async () => {
    createSessionMock.mockImplementation(async () => ({
      close: vi.fn(),
      fetch: vi.fn(async () => {
        throw "socket hang up";
      }),
    }));
    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await expect(
      opencodeTlsFetch("https://opencode.ai/a", {}, { proxyUrl: "http://u:secret@p.test:1" })
    ).rejects.toBe("socket hang up");
  });
});
