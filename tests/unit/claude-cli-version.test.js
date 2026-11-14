// The live Claude CLI version (open-sse/utils/claudeCliVersion.js): the header
// rewrite, the version floor, and that the npm lookup leaves through the
// request's connection proxy instead of a direct socket.
import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import http from "node:http";

const ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy", "CLAUDE_CLI_VERSION"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
for (const k of ENV_KEYS) delete process.env[k];

const { applyClaudeCliVersion, ensureClaudeCliVersion, getClaudeCliVersion } = await import("../../open-sse/utils/claudeCliVersion.js");
const { CLAUDE_CLI_VERSION } = await import("../../open-sse/providers/shared.js");
const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

let proxyServer, proxyUrl;
const tunnelTargets = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

beforeAll(async () => {
  // A proxy that records every CONNECT target and refuses the tunnel.
  proxyServer = http.createServer((req, res) => { res.statusCode = 403; res.end(); });
  proxyServer.on("connect", (req, socket) => {
    tunnelTargets.push(req.url);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await listen(proxyServer);
  proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((resolve) => proxyServer.close(resolve));
});

describe("claudeCliVersion", () => {
  it("never reports a version below the bundled floor", () => {
    expect(getClaudeCliVersion()).toBe(CLAUDE_CLI_VERSION);
  });

  it("rewrites claude-cli/x.y.z in header objects and Headers", () => {
    const v = getClaudeCliVersion();
    expect(applyClaudeCliVersion({ "User-Agent": "claude-cli/1.0.0 (external, cli)", Other: "x" }))
      .toEqual({ "User-Agent": `claude-cli/${v} (external, cli)`, Other: "x" });
    const h = applyClaudeCliVersion(new Headers({ "user-agent": "claude-cli/2.0.0 (external, sdk-cli)" }));
    expect(h.get("user-agent")).toBe(`claude-cli/${v} (external, sdk-cli)`);
  });

  it("ignores a registry answer that is not a plain x.y.z version", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: "99.0.0; evil=1" }), { status: 200 }));
    await ensureClaudeCliVersion(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://registry.npmjs.org/@anthropic-ai/claude-code/latest", expect.any(Object));
    expect(getClaudeCliVersion()).toBe(CLAUDE_CLI_VERSION);
  });
});

describe("claudeCliVersion lookup transport", () => {
  it("sends the npm lookup through the request's connection proxy", async () => {
    vi.resetModules();
    const fresh = await import("../../open-sse/utils/proxyFetch.js");
    await expect(fresh.proxyAwareFetch("http://127.0.0.1:9/v1/messages", {
      method: "POST",
      headers: { "User-Agent": "claude-cli/1.0.0 (external, cli)" },
      body: "{}",
    }, { enabled: true, url: proxyUrl, strictProxy: true })).rejects.toThrow();

    await vi.waitFor(() => expect(tunnelTargets).toContain("registry.npmjs.org:443"), { timeout: 4000 });
  });
});

// Keep the import used: the main module must load with the version helpers wired in.
void proxyAwareFetch;
