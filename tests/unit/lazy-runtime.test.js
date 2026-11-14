import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";

// lazyRuntime is the fork's replacement for upstream's runtime npm installer:
// it only imports already-installed packages from an allow-list. A name outside
// the list must never reach import(), and a failed import must not be cached
// forever (the next call retries).

describe("loadRuntimeDep", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("wreq-js");
  });

  it("rejects packages outside the allow-list without importing them", async () => {
    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    await expect(loadRuntimeDep("playwright-core")).rejects.toThrow("runtime dependency not allowed: playwright-core");
    await expect(loadRuntimeDep("node:child_process")).rejects.toThrow(/not allowed/);
    await expect(loadRuntimeDep("../../src/lib/db/index.js")).rejects.toThrow(/not allowed/);
  });

  it("returns the module namespace when it exposes createSession", async () => {
    const createSession = vi.fn();
    vi.doMock("wreq-js", () => ({ createSession, default: { other: true } }));
    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    const mod = await loadRuntimeDep("wreq-js");
    expect(mod.createSession).toBe(createSession);
  });

  it("unwraps a CommonJS default export", async () => {
    const createSession = vi.fn();
    // Mocked namespaces throw on unknown keys, so name the missing one explicitly.
    vi.doMock("wreq-js", () => ({ createSession: undefined, default: { createSession } }));
    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    const mod = await loadRuntimeDep("wreq-js");
    expect(mod.createSession).toBe(createSession);
  });

  it("caches a successful import", async () => {
    const factory = vi.fn(() => ({ createSession: vi.fn(), default: undefined }));
    vi.doMock("wreq-js", factory);
    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    const first = loadRuntimeDep("wreq-js");
    expect(loadRuntimeDep("wreq-js")).toBe(first);
    await first;
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("drops a failed import from the cache so the next call retries", async () => {
    let fail = true;
    const createSession = vi.fn();
    vi.doMock("wreq-js", () => {
      if (fail) throw new Error("native binding missing");
      return { createSession, default: undefined };
    });
    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");

    const failed = loadRuntimeDep("wreq-js");
    await expect(failed).rejects.toThrow();

    fail = false;
    vi.resetModules(); // let the mock factory run again; lazyRuntime's own cache is what's under test
    const retried = loadRuntimeDep("wreq-js");
    expect(retried).not.toBe(failed);
    expect((await retried).createSession).toBe(createSession);
  });
});
