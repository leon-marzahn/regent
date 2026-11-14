// MiniMax Code lease auth mode — named-pipe broker protocol (frame codec,
// endpoint resolution), the in-process lease cache, and the executor wiring
// that borrows desktop tokens for authType "mcode-lease" connections.
// Protocol ported from MiniMax-AI/minimax-code packages/oauth-lease-protocol (MIT).
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import path from "node:path";

// ── pure protocol module (no app deps) ───────────────────────────────────────
import {
  AUTH_LEASE_MAX_FRAME_BYTES,
  AuthLeaseError,
  DEFAULT_MCODE_DATA_DIR,
  assertLeasePlatformSupported,
  assertOwnedByCurrentUser,
  validateLeaseResult,
  FrameDecoder,
  createTokenManager,
  encodeFrame,
  isLeaseConnection,
  resolveLeaseEndpoint,
  resolveMcodeDataDir,
  requestLease,
} from "../../open-sse/services/minimaxCodeLease.js";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";

// ── executor under test (stub base + mocked refresh/lease imports) ───────────
class StubBase {
  constructor(provider) { this.provider = provider; }
  async execute(args) {
    StubBase.lastArgs = args;
    return { response: new Response("{}", { status: 200 }) };
  }
}
vi.mock("../../open-sse/executors/default.js", () => ({ DefaultExecutor: StubBase }));

const refreshMiniMaxMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshMiniMaxCodeToken: refreshMiniMaxMock,
}));

// Partial mock: keep the real protocol/codec/helpers, replace only the broker
// I/O the executor touches.
const getLeaseTokenMock = vi.hoisted(() => vi.fn());
const invalidateLeaseTokenMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/services/minimaxCodeLease.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getLeaseToken: getLeaseTokenMock,
  invalidateLeaseToken: invalidateLeaseTokenMock,
}));

const { MinimaxCodeExecutor } = await import("../../open-sse/executors/minimax-code.js");

describe("lease wire protocol: frame codec", () => {
  it("round-trips a JSON payload through the 4-byte length prefix", () => {
    const frame = encodeFrame({ version: 1, method: "lease", minValidityMs: 300000 });
    expect(frame.length).toBe(4 + frame.length - 4);
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);

    const decoder = new FrameDecoder();
    expect(decoder.push(frame)).toEqual([{ version: 1, method: "lease", minValidityMs: 300000 }]);
  });

  it("reassembles frames split across chunks and concatenates siblings", () => {
    const decoder = new FrameDecoder();
    const a = encodeFrame({ ok: true });
    const b = encodeFrame({ ok: false, error: { code: "AUTH_REQUIRED" } });

    expect(decoder.push(a.subarray(0, 2))).toEqual([]);
    expect(decoder.push(Buffer.concat([a.subarray(2), b.subarray(0, 5)]))).toEqual([{ ok: true }]);
    expect(decoder.push(b.subarray(5))).toEqual([{ ok: false, error: { code: "AUTH_REQUIRED" } }]);
  });

  it("rejects out-of-bounds payloads and non-JSON frames", () => {
    expect(() => encodeFrame({ big: "x".repeat(AUTH_LEASE_MAX_FRAME_BYTES) })).toThrow(AuthLeaseError);

    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(0, 0);
    expect(() => new FrameDecoder().push(bad)).toThrow(/invalid frame length/);

    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(AUTH_LEASE_MAX_FRAME_BYTES + 1, 0);
    expect(() => new FrameDecoder().push(oversized)).toThrow(/invalid frame length/);

    const notJson = Buffer.alloc(4 + 4);
    notJson.writeUInt32BE(4, 0);
    notJson.write("nope", 4);
    expect(() => new FrameDecoder().push(notJson)).toThrow(/non-JSON/);
  });
});

describe("lease endpoint resolution", () => {
  it("hashes the normalized, lowercased win32 data dir into the pipe name", () => {
    const forward = resolveLeaseEndpoint("C:/Users/u/.MiniMax", "win32");
    const backward = resolveLeaseEndpoint("C:\\Users\\u\\.MiniMax\\", "win32");
    expect(forward).toEqual(backward);

    const digest = createHash("sha256").update("c:\\users\\u\\.minimax").digest("hex").slice(0, 16);
    expect(forward.endpoint).toBe(`\\\\.\\pipe\\mcode-auth-lease-${digest}`);
    expect(forward.capabilityFile).toBe("C:\\Users\\u\\.MiniMax\\run\\mcode-auth-lease-v1.cap");
  });

  it("puts the unix socket and capability file under <dataDir>/run", () => {
    const ep = resolveLeaseEndpoint("/home/u/.minimax", "linux");
    expect(ep.transport).toBe("unix");
    // path.join follows the host — on a Linux broker host this is the posix form.
    expect(ep.endpoint).toBe(path.join("/home/u/.minimax", "run", "mcode-auth-lease-v1.sock"));
    expect(ep.capabilityFile).toBe(path.join("/home/u/.minimax", "run", "mcode-auth-lease-v1.cap"));
  });

  it("refuses relative data dirs", () => {
    expect(() => resolveLeaseEndpoint("relative/path", "win32")).toThrow(AuthLeaseError);
    expect(() => resolveLeaseEndpoint("relative/path", "linux")).toThrow(AuthLeaseError);
  });
});

// Windows named pipes can't be ownership-checked, so a squatter could receive the
// capability secret: lease mode is refused there before anything is read or sent.
describe("lease platform gate", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  afterEach(() => Object.defineProperty(process, "platform", realPlatform));

  it("allows macOS and Linux and refuses Windows", () => {
    expect(() => assertLeasePlatformSupported("darwin")).not.toThrow();
    expect(() => assertLeasePlatformSupported("linux")).not.toThrow();
    let err;
    try { assertLeasePlatformSupported("win32"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AuthLeaseError);
    expect(err.code).toBe("UNSUPPORTED_PLATFORM");
    expect(err.message).toMatch(/macOS and Linux/);
  });

  it("rejects a lease on Windows without reading the capability file or connecting", async () => {
    const readSpy = vi.spyOn(fs, "readFileSync");
    const connectSpy = vi.spyOn(net, "connect");
    Object.defineProperty(process, "platform", { ...realPlatform, value: "win32" });
    await expect(requestLease("C:\\Users\\u\\.minimax")).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
    expect(readSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
    readSpy.mockRestore();
    connectSpy.mockRestore();
  });
});

describe("lease token manager", () => {
  beforeEach(() => vi.clearAllMocks());

  function managerWith(tokens, delayMs = 0) {
    let calls = 0;
    const leaseFn = vi.fn(async () => {
      calls += 1;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return tokens[Math.min(calls - 1, tokens.length - 1)];
    });
    return { manager: createTokenManager({ requestLease: leaseFn }), leaseFn };
  }

  const fresh = (token) => ({ accessToken: token, expiresAtMs: Date.now() + 5 * 60 * 1000, generation: 1 });

  it("caches a lease while it stays fresh (60s margin)", async () => {
    const { manager, leaseFn } = managerWith([fresh("t1")]);
    await manager.getToken("/data");
    await manager.getToken("/data");
    expect(leaseFn).toHaveBeenCalledTimes(1);
  });

  it("re-leases once the remaining validity drops under the margin", async () => {
    const { manager, leaseFn } = managerWith([{ accessToken: "t1", expiresAtMs: Date.now() + 30 * 1000, generation: 1 }, fresh("t2")]);
    await manager.getToken("/data");
    await manager.getToken("/data");
    expect(leaseFn).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent requests into a single lease (single-flight)", async () => {
    const { manager, leaseFn } = managerWith([fresh("t1")], 20);
    const [a, b] = await Promise.all([manager.getToken("/data"), manager.getToken("/data")]);
    expect(a.accessToken).toBe("t1");
    expect(b.accessToken).toBe("t1");
    expect(leaseFn).toHaveBeenCalledTimes(1);
  });

  it("drops the cache on invalidate and leases anew", async () => {
    const { manager, leaseFn } = managerWith([fresh("t1"), fresh("t2")]);
    await manager.getToken("/data");
    manager.invalidate("upstream 401");
    const next = await manager.getToken("/data");
    expect(next.accessToken).toBe("t2");
    expect(leaseFn).toHaveBeenCalledTimes(2);
  });
});

describe("mcode data dir + mode helpers", () => {
  const ORIGINAL_ENV = process.env.MINIMAX_DESKTOP_DATA_DIR;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.MINIMAX_DESKTOP_DATA_DIR;
    else process.env.MINIMAX_DESKTOP_DATA_DIR = ORIGINAL_ENV;
  });

  it("isLeaseConnection keys on the mcode-lease authType", () => {
    expect(isLeaseConnection({ authType: "mcode-lease" })).toBe(true);
    expect(isLeaseConnection({ authType: "oauth", refreshToken: "r" })).toBe(false);
    expect(isLeaseConnection(null)).toBe(false);
  });

  it("resolves the data dir from server config only: env > default, never the connection", () => {
    process.env.MINIMAX_DESKTOP_DATA_DIR = "/env/dir";
    // resolve() normalizes per host — compare against the same call.
    expect(resolveMcodeDataDir({ providerSpecificData: { mcodeDataDir: "/conn/dir" } })).toBe(path.resolve("/env/dir"));
    expect(resolveMcodeDataDir({ providerSpecificData: {} })).toBe(path.resolve("/env/dir"));
    delete process.env.MINIMAX_DESKTOP_DATA_DIR;
    expect(resolveMcodeDataDir({ providerSpecificData: { mcodeDataDir: "/var/run" } })).toBe(DEFAULT_MCODE_DATA_DIR);
    expect(resolveMcodeDataDir({})).toBe(DEFAULT_MCODE_DATA_DIR);
  });
});

describe("broker trust checks (POSIX)", () => {
  const stat = (over = {}) => ({
    uid: 501,
    mode: 0o700,
    isDirectory: () => over.kind === "dir",
    isSocket: () => over.kind === "socket",
    isFile: () => over.kind === "file",
    ...over,
  });
  const check = (entry, kind, s) => assertOwnedByCurrentUser(entry, kind, { uid: 501, lstat: () => s });

  it("accepts entries of the right kind owned by this user", () => {
    expect(() => check("/d", "dir", stat({ kind: "dir" }))).not.toThrow();
    expect(() => check("/s", "socket", stat({ kind: "socket", mode: 0o755 }))).not.toThrow();
    expect(() => check("/c", "file", stat({ kind: "file", mode: 0o600 }))).not.toThrow();
  });

  it("rejects another user's entry, group/world-writable modes and a wrong kind (symlink)", () => {
    expect(() => check("/s", "socket", stat({ kind: "socket", uid: 0 }))).toThrow(/not owned by this user/);
    expect(() => check("/d", "dir", stat({ kind: "dir", mode: 0o777 }))).toThrow(AuthLeaseError);
    expect(() => check("/d", "dir", stat({ kind: "dir", mode: 0o720 }))).toThrow(AuthLeaseError);
    expect(() => check("/c", "file", stat({ kind: "symlink" }))).toThrow(AuthLeaseError);
  });

  it("reports a missing broker without the path", () => {
    const missing = () => assertOwnedByCurrentUser("/home/u/.minimax/run", "dir", {
      uid: 501,
      lstat: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); },
    });
    expect(missing).toThrow(/ENOENT/);
    try { missing(); } catch (error) {
      expect(error.code).toBe("BROKER_UNAVAILABLE");
      expect(error.message).not.toContain("/home/u");
    }
  });
});

describe("lease reply validation", () => {
  const exp = Date.now() + 300000;
  it("accepts a printable token with a numeric expiry", () => {
    expect(validateLeaseResult({ accessToken: "eyJ.abc-_", expiresAtMs: exp, generation: 2 }))
      .toEqual({ accessToken: "eyJ.abc-_", expiresAtMs: exp, generation: 2 });
  });

  it("rejects missing, oversized, header-breaking tokens and a bad expiry", () => {
    for (const accessToken of [undefined, "", 42, "a b", "a\r\nX-Evil: 1", "x".repeat(16 * 1024 + 1)]) {
      expect(() => validateLeaseResult({ accessToken, expiresAtMs: exp })).toThrow(AuthLeaseError);
    }
    expect(() => validateLeaseResult({ accessToken: "t", expiresAtMs: "soon" })).toThrow(/expiry/);
  });
});

describe("minimax-code executor lease wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    StubBase.lastArgs = null;
  });

  it("borrows a leased token for lease connections before calling upstream", async () => {
    getLeaseTokenMock.mockResolvedValue({ accessToken: "leased-1", expiresAtMs: Date.now() + 300000, generation: 3 });
    const ex = new MinimaxCodeExecutor("minimax-code");

    await ex.execute({ model: "MiniMax-M3", body: {}, credentials: { authType: "mcode-lease" } });

    expect(getLeaseTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ authType: "mcode-lease" }),
      undefined,
    );
    expect(StubBase.lastArgs.credentials.accessToken).toBe("leased-1");
  });

  it("leaves stored-token (oauth) credentials untouched", async () => {
    const ex = new MinimaxCodeExecutor("minimax-code");
    const creds = { authType: "oauth", accessToken: "stored-1", refreshToken: "r1" };

    await ex.execute({ model: "MiniMax-M3", body: {}, credentials: creds });

    expect(getLeaseTokenMock).not.toHaveBeenCalled();
    expect(StubBase.lastArgs.credentials.accessToken).toBe("stored-1");
  });

  it("refreshes a lease connection by invalidating and re-leasing (no refresh token)", async () => {
    getLeaseTokenMock.mockResolvedValue({ accessToken: "leased-2", expiresAtMs: Date.now() + 300000, generation: 4 });
    const ex = new MinimaxCodeExecutor("minimax-code");

    const out = await ex.refreshCredentials({ authType: "mcode-lease" });

    expect(invalidateLeaseTokenMock).toHaveBeenCalled();
    // leasedToken keeps updateProviderCredentials from persisting the borrowed token.
    expect(out).toEqual({ accessToken: "leased-2", leasedToken: true });
    expect(refreshMiniMaxMock).not.toHaveBeenCalled();
  });

  it("returns null (fail over) when the desktop broker is unreachable", async () => {
    getLeaseTokenMock.mockRejectedValue(new AuthLeaseError("BROKER_UNAVAILABLE"));
    const ex = new MinimaxCodeExecutor("minimax-code");

    const out = await ex.refreshCredentials({ authType: "mcode-lease" });

    expect(out).toBeNull();
  });

  it("keeps the single-use refresh-token handler for oauth connections", async () => {
    refreshMiniMaxMock.mockResolvedValue({ accessToken: "a", refreshToken: "r2" });
    const ex = new MinimaxCodeExecutor("minimax-code");

    const out = await ex.refreshCredentials({ authType: "oauth", refreshToken: "r1" });

    expect(out).toEqual({ accessToken: "a", refreshToken: "r2" });
    expect(refreshMiniMaxMock).toHaveBeenCalledWith("minimax-code", "r1", undefined);
    expect(getLeaseTokenMock).not.toHaveBeenCalled();
  });
});

// Real socket round-trip against a fake broker in a temp data dir (POSIX only).
describe.skipIf(process.platform === "win32")("requestLease over a unix socket", () => {
  const CAP = "A".repeat(43);
  let dataDir;
  let server;

  async function startBroker(reply) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcl-"));
    fs.chmodSync(dataDir, 0o700);
    const run = path.join(dataDir, "run");
    fs.mkdirSync(run, { mode: 0o700 });
    fs.writeFileSync(path.join(run, "mcode-auth-lease-v1.cap"), CAP, { mode: 0o600 });
    const sock = path.join(run, "mcode-auth-lease-v1.sock");
    server = net.createServer((conn) => {
      const decoder = new FrameDecoder();
      conn.on("data", (chunk) => {
        for (const req of decoder.push(chunk)) conn.write(reply(req));
      });
    });
    await new Promise((resolve) => server.listen(sock, resolve));
    fs.chmodSync(sock, 0o700);
  }

  async function stopBroker() {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  }

  afterEach(stopBroker);

  it("sends the capability and returns the validated lease", async () => {
    let seen;
    await startBroker((req) => {
      seen = req;
      return encodeFrame({ ok: true, result: { accessToken: "tok-1", expiresAtMs: Date.now() + 300000, generation: 7 } });
    });
    const lease = await requestLease(dataDir);
    expect(lease).toMatchObject({ accessToken: "tok-1", generation: 7 });
    expect(seen).toMatchObject({ capability: CAP, method: "lease", version: 1 });
    expect(seen.requestId).toMatch(/^regent-lease-/);
  });

  it("rejects an oversized frame header from the broker", async () => {
    await startBroker(() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(AUTH_LEASE_MAX_FRAME_BYTES + 1, 0);
      return b;
    });
    await expect(requestLease(dataDir)).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
  });

  it("maps broker error codes and rejects a token-less success", async () => {
    await startBroker(() => encodeFrame({ ok: false, error: { code: "AUTH_REQUIRED" } }));
    await expect(requestLease(dataDir)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await stopBroker();
    await startBroker(() => encodeFrame({ ok: true, result: { expiresAtMs: 1 } }));
    await expect(requestLease(dataDir)).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
  });

  it("refuses a run dir other users can write to", async () => {
    await startBroker(() => encodeFrame({ ok: true, result: { accessToken: "t", expiresAtMs: Date.now() + 300000 } }));
    fs.chmodSync(path.join(dataDir, "run"), 0o777);
    await expect(requestLease(dataDir)).rejects.toMatchObject({ code: "BROKER_UNTRUSTED" });
  });
});
