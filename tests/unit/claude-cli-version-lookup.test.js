// claudeCliVersion: a valid npm answer above the floor becomes the live version
// and is cached for the TTL; failed lookups back off; header arrays are rewritten.
import { describe, it, expect, vi, beforeAll, afterAll } from "vite-plus/test";

const saved = process.env.CLAUDE_CLI_VERSION;
delete process.env.CLAUDE_CLI_VERSION;
const mod = await import("../../open-sse/utils/claudeCliVersion.js");
const { applyClaudeCliVersion, ensureClaudeCliVersion, getClaudeCliVersion, setClaudeCliFallback } = mod;

afterAll(() => {
  if (saved === undefined) delete process.env.CLAUDE_CLI_VERSION;
  else process.env.CLAUDE_CLI_VERSION = saved;
  vi.useRealTimers();
});

const ok = (version) => async () => new Response(JSON.stringify({ version }), { status: 200 });

describe("claudeCliVersion lookup", () => {
  beforeAll(() => vi.useFakeTimers({ toFake: ["Date"] }));

  it("backs off after a failed lookup and keeps the floor", async () => {
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const before = getClaudeCliVersion();
    const failing = vi.fn(async () => new Response("nope", { status: 503 }));
    expect(await ensureClaudeCliVersion(failing)).toBe(before);
    expect(failing).toHaveBeenCalledTimes(1);

    // Inside the 10-minute retry window no new request goes out.
    const next = vi.fn(ok("999.0.0"));
    vi.setSystemTime(new Date("2026-11-01T00:05:00Z"));
    expect(await ensureClaudeCliVersion(next)).toBe(before);
    expect(next).not.toHaveBeenCalled();
  });

  it("adopts a newer registry version, then serves it from cache within the TTL", async () => {
    vi.setSystemTime(new Date("2026-11-01T00:11:00Z"));
    const fetchImpl = vi.fn(ok("999.1.2"));
    expect(await ensureClaudeCliVersion(fetchImpl)).toBe("999.1.2");
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers).toEqual({ Accept: "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    vi.setSystemTime(new Date("2026-11-01T05:00:00Z"));
    const again = vi.fn(ok("999.9.9"));
    expect(await ensureClaudeCliVersion(again)).toBe("999.1.2");
    expect(again).not.toHaveBeenCalled();
  });

  it("a raised fallback above the live version wins; invalid fallbacks are ignored", () => {
    setClaudeCliFallback("not-a-version");
    expect(getClaudeCliVersion()).toBe("999.1.2");
    setClaudeCliFallback("1000.0.0");
    expect(getClaudeCliVersion()).toBe("1000.0.0");
  });

  it("rewrites header arrays and passes null headers through", () => {
    expect(applyClaudeCliVersion(null)).toBeNull();
    expect(applyClaudeCliVersion([["user-agent", "claude-cli/1.2.3 (external)"], ["x-n", 5]])).toEqual([
      ["user-agent", "claude-cli/1000.0.0 (external)"],
      ["x-n", 5],
    ]);
  });
});
