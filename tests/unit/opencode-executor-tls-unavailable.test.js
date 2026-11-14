// wreq-js is optional. Without it the OpenCode executor must still send direct
// requests (native fetch), but never let a proxied request fall off the proxy.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const { tlsFetchMock, Unavailable, nativeFetch } = vi.hoisted(() => {
  class Unavailable extends Error {}
  return { tlsFetchMock: vi.fn(), Unavailable, nativeFetch: vi.fn() };
});
// The proxy-aware fetch sends through the undici package's fetch.
vi.mock("undici", async (importOriginal) => ({ ...(await importOriginal()), fetch: nativeFetch }));
vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: tlsFetchMock,
  OpencodeTlsUnavailableError: Unavailable,
}));
vi.mock("../../open-sse/utils/opencodeCliRunner.js", () => ({
  findOpencodeBinary: () => null,
  formatOpencodeCliPrompt: () => "",
  executeOpencodeCli: vi.fn(),
}));

const ARGS = {
  model: "oc/gpt-oss-120b",
  body: { messages: [{ role: "user", content: "hi" }] },
  stream: false,
  credentials: {},
};

// The proxied case runs through the executor's retry backoff (~9s).
describe("opencode executor without wreq-js", { timeout: 30_000 }, () => {
  beforeEach(() => {
    tlsFetchMock.mockReset().mockRejectedValue(new Unavailable("wreq-js unavailable"));
    nativeFetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
  });

  it("falls back to native fetch on the direct path", async () => {
    const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
    const exec = new OpenCodeExecutor("opencode", { baseUrl: "https://opencode.ai" });
    const warn = vi.fn();
    const result = await exec.execute({ ...ARGS, log: { warn, debug: vi.fn(), info: vi.fn() } });

    expect(tlsFetchMock).toHaveBeenCalled();
    expect(nativeFetch.mock.calls.some(([u]) => String(u).startsWith("https://opencode.ai"))).toBe(true);
    expect(result.response.status).toBe(200);
    expect(warn).toHaveBeenCalledWith("OPENCODE", expect.stringMatching(/native fetch/));
  });

  it("does not leave the proxy when one is selected", async () => {
    const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
    const exec = new OpenCodeExecutor("opencode", { baseUrl: "https://opencode.ai" });
    let outcome;
    try {
      outcome = await exec.execute({
        ...ARGS,
        proxyOptions: { connectionProxyEnabled: true, connectionProxyUrl: "socks5://127.0.0.1:9050" },
      });
    } catch (e) {
      outcome = e;
    }

    expect(tlsFetchMock.mock.calls[0][2].proxyUrl).toBe("socks5://127.0.0.1:9050");
    expect(nativeFetch.mock.calls.some(([u]) => String(u).startsWith("https://opencode.ai"))).toBe(false);
    expect(outcome?.response?.ok).not.toBe(true);
  });
});
