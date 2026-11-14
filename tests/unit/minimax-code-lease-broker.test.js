// MiniMax Code lease broker client: capability-file validation, broker failure
// modes (unreachable, silent), the status call, and the per-data-dir lease
// cache behind getLeaseToken/invalidateLeaseToken. Real unix sockets against a
// fake broker in a temp data dir (POSIX only).
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  FrameDecoder,
  encodeFrame,
  getLeaseManager,
  getLeaseToken,
  invalidateLeaseToken,
  readCapability,
  requestLease,
  requestStatus,
} from "../../open-sse/services/minimaxCodeLease.js";

const CAP = "B".repeat(43);
const SOCK = "mcode-auth-lease-v1.sock";
const CAP_FILE = "mcode-auth-lease-v1.cap";

describe.skipIf(process.platform === "win32")("minimaxCodeLease broker client", () => {
  let dataDir;
  let servers = [];

  function makeDataDir(cap = CAP) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mclb-"));
    fs.chmodSync(dataDir, 0o700);
    fs.mkdirSync(path.join(dataDir, "run"), { mode: 0o700 });
    if (cap !== null) fs.writeFileSync(path.join(dataDir, "run", CAP_FILE), cap, { mode: 0o600 });
    return dataDir;
  }

  async function listen(sockPath, onConnection) {
    const server = net.createServer(onConnection);
    // Track peers so teardown can drop a connection the broker left open.
    server.peers = new Set();
    server.on("connection", (conn) => {
      server.peers.add(conn);
      conn.on("close", () => server.peers.delete(conn));
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(sockPath, resolve));
    fs.chmodSync(sockPath, 0o700);
    return server;
  }

  async function startBroker(reply) {
    makeDataDir();
    const seen = [];
    await listen(path.join(dataDir, "run", SOCK), (conn) => {
      const decoder = new FrameDecoder();
      conn.on("data", (chunk) => {
        for (const req of decoder.push(chunk)) {
          seen.push(req);
          conn.write(reply(req));
        }
      });
    });
    return seen;
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const server of servers) {
      for (const conn of server.peers) conn.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    servers = [];
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  describe("readCapability", () => {
    it("returns a well-formed capability", () => {
      makeDataDir(`${CAP}\n`);
      expect(readCapability(dataDir)).toBe(CAP);
    });

    it("reports a missing capability file as BROKER_UNAVAILABLE with the errno", () => {
      makeDataDir(null);
      expect(() => readCapability(dataDir)).toThrow(/capability file.*ENOENT/s);
      try {
        readCapability(dataDir);
      } catch (error) {
        expect(error.code).toBe("BROKER_UNAVAILABLE");
      }
    });

    it.each([
      ["too short", "abc"],
      ["too long", "C".repeat(44)],
      ["bad characters", `${"D".repeat(42)}!`],
      ["embedded whitespace", `${"E".repeat(21)} ${"E".repeat(21)}`],
    ])("rejects capability content that is %s", (_label, cap) => {
      makeDataDir(cap);
      expect(() => readCapability(dataDir)).toThrow("Capability file has unexpected content.");
    });

    it("refuses to send a malformed capability to the broker", async () => {
      const seen = await startBroker(() => encodeFrame({ ok: true, result: { status: "ready" } }));
      fs.writeFileSync(path.join(dataDir, "run", CAP_FILE), "not-a-capability", { mode: 0o600 });
      await expect(requestStatus(dataDir)).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
      expect(seen).toHaveLength(0);
    });
  });

  describe("requestStatus", () => {
    it("sends a status request with the capability and returns the bounded result", async () => {
      const seen = await startBroker(() =>
        encodeFrame({ ok: true, result: { status: "x".repeat(100), generation: 3, expiresAtMs: 1234 } }),
      );
      const status = await requestStatus(dataDir);
      expect(status).toEqual({ status: "x".repeat(64), generation: 3, expiresAtMs: 1234 });
      expect(seen[0]).toMatchObject({ method: "status", capability: CAP, version: 1 });
      expect(seen[0].requestId).toMatch(/^regent-status-/);
    });

    it("normalizes missing or mistyped status fields", async () => {
      await startBroker(() => encodeFrame({ ok: true, result: { status: 42, generation: "7" } }));
      expect(await requestStatus(dataDir)).toEqual({ status: "unknown", generation: null, expiresAtMs: null });
    });

    it("reports an unreachable broker (stale socket, nobody listening)", async () => {
      makeDataDir();
      // A hard link keeps the socket inode after the server unlinks its own path on close.
      const tmpSock = path.join(dataDir, "tmp.sock");
      const server = await listen(tmpSock, () => {});
      fs.linkSync(tmpSock, path.join(dataDir, "run", SOCK));
      await new Promise((resolve) => server.close(() => resolve()));
      servers = servers.filter((s) => s !== server);

      await expect(requestStatus(dataDir)).rejects.toMatchObject({
        code: "BROKER_UNAVAILABLE",
        message: expect.stringMatching(/Cannot reach the MiniMax Code desktop auth broker \(E[A-Z]+\)/),
      });
    });

    it("times out when the broker never answers", async () => {
      makeDataDir();
      await listen(path.join(dataDir, "run", SOCK), () => {});
      await expect(requestStatus(dataDir, 50)).rejects.toMatchObject({
        code: "BROKER_UNAVAILABLE",
        message: "Broker did not respond within 50ms.",
      });
    });
  });

  describe("lease cache", () => {
    const leaseReply = (token) => () =>
      encodeFrame({ ok: true, result: { accessToken: token, expiresAtMs: Date.now() + 300000, generation: 1 } });

    it("keeps one manager per data dir", () => {
      const a = getLeaseManager("/tmp/mcl-a");
      expect(getLeaseManager("/tmp/mcl-a")).toBe(a);
      expect(getLeaseManager("/tmp/mcl-b")).not.toBe(a);
    });

    it("leases from the env-configured data dir, caches, and re-leases after invalidate", async () => {
      const seen = await startBroker(leaseReply("tok-cached"));
      vi.stubEnv("MINIMAX_DESKTOP_DATA_DIR", dataDir);
      // The connection record cannot redirect the client to another data dir.
      const credentials = { authType: "mcode-lease", providerSpecificData: { dataDir: "/elsewhere" } };

      const first = await getLeaseToken(credentials);
      expect(first.accessToken).toBe("tok-cached");
      expect((await getLeaseToken(credentials)).accessToken).toBe("tok-cached");
      expect(seen.filter((r) => r.method === "lease")).toHaveLength(1);

      const log = { debug: vi.fn() };
      invalidateLeaseToken(credentials, "upstream 401", log);
      await getLeaseToken(credentials);
      expect(seen.filter((r) => r.method === "lease")).toHaveLength(2);
    });

    it("propagates broker failures from requestLease", async () => {
      await startBroker(() => encodeFrame({ ok: false, error: { code: "CAPABILITY_REJECTED" } }));
      await expect(requestLease(dataDir)).rejects.toMatchObject({ code: "CAPABILITY_REJECTED" });
    });
  });
});
