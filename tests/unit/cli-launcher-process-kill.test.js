import { describe, it, expect, vi } from "vite-plus/test";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const lp = require("../../cli/src/cli/utils/launcherProcess.js");

const SELF = 4242;
const IDS = ["regent", "9router"];

describe("forceKillPid", () => {
  it("sends SIGKILL on unix", () => {
    const kill = vi.fn();
    const execFile = vi.fn();
    lp.forceKillPid(77, { isWin: false, kill, execFile });
    expect(kill).toHaveBeenCalledWith(77, "SIGKILL");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("uses taskkill with an argv array on Windows (no shell string)", () => {
    const execFile = vi.fn();
    lp.forceKillPid(77, { isWin: true, execFile });
    expect(execFile).toHaveBeenCalledWith("taskkill", ["/F", "/PID", "77"], expect.objectContaining({ windowsHide: true }));
    lp.forceKillPid(78, { isWin: true, tree: true, execFile });
    expect(execFile).toHaveBeenLastCalledWith("taskkill", ["/F", "/T", "/PID", "78"], expect.any(Object));
  });
});

describe("parseCloudflaredPids", () => {
  const ps = [
    "  PID COMMAND",
    "  101 /usr/bin/cloudflared tunnel --url http://localhost:20128",
    "  102 /usr/bin/cloudflared tunnel --url http://127.0.0.1:20128",
    "  103 /usr/bin/cloudflared tunnel --url http://localhost:3000",
    "  104 vim notes-localhost:20128.txt",
    `  ${SELF} /usr/bin/cloudflared --url localhost:20128`,
    "  12;rm cloudflared localhost:20128",
  ].join("\n");

  it("keeps only cloudflared lines that target the app port, never self or junk PIDs", () => {
    expect(lp.parseCloudflaredPids(ps, 20128, { isWin: false, selfPid: SELF })).toEqual([101, 102]);
  });

  it("parses the WMI CSV and skips its header row", () => {
    const csv = [
      '"ProcessId","CommandLine"',
      '"201","cloudflared.exe tunnel --url http://localhost:20128"',
      '"202","cloudflared.exe tunnel --url http://localhost:9999"',
      '"x1","cloudflared.exe --url localhost:20128"',
    ].join("\n");
    expect(lp.parseCloudflaredPids(csv, 20128, { isWin: true, selfPid: SELF })).toEqual([201]);
  });

  it("returns nothing without output or port", () => {
    expect(lp.parseCloudflaredPids("", 20128)).toEqual([]);
    expect(lp.parseCloudflaredPids(ps, 0)).toEqual([]);
  });
});

describe("parseAppProcessPids", () => {
  it("matches only node processes running our cli (ps aux, pid in column 2)", () => {
    const ps = [
      "USER PID %CPU",
      "me 301 0.0 node /usr/lib/node_modules/regent/cli.js",
      "me 302 0.0 node /opt/9router/server.js",
      "me 303 0.0 next-server (v15.0.0)",
      "me 304 0.0 vim regent-notes.md",
      "me 305 0.0 grep regent",
      `me ${SELF} 0.0 node /usr/lib/node_modules/regent/cli.js`,
      "me abc 0.0 node regent/cli.js",
    ].join("\n");
    expect(lp.parseAppProcessPids(ps, IDS, { isWin: false, selfPid: SELF })).toEqual([301, 302]);
  });

  it("accepts backslash paths only on Windows", () => {
    const csv = [
      '"ProcessId","CommandLine"',
      '"401","node.exe C:\\Users\\me\\AppData\\npm\\regent\\server.js"',
      '"402","Code.exe regent"',
      "",
    ].join("\n");
    expect(lp.parseAppProcessPids(csv, IDS, { isWin: true, selfPid: SELF })).toEqual([401]);
    // A unix ps line with only a backslash path does not count.
    expect(lp.parseAppProcessPids("me 9 0 node C:\\x\\regent\\server.js", IDS, { isWin: false })).toEqual([]);
  });

  it("returns nothing for empty output", () => {
    expect(lp.parseAppProcessPids("", IDS)).toEqual([]);
  });
});

describe("parsePortListenerPid", () => {
  it("takes the first lsof PID", () => {
    expect(lp.parsePortListenerPid("511\n512\n", { isWin: false })).toBe(511);
  });

  it("takes the PID of the first LISTENING netstat row", () => {
    const out = [
      "  TCP    127.0.0.1:20128   127.0.0.1:5000   ESTABLISHED   900",
      "  TCP    0.0.0.0:20128     0.0.0.0:0        LISTENING     611",
    ].join("\n");
    expect(lp.parsePortListenerPid(out, { isWin: true })).toBe(611);
    expect(lp.parsePortListenerPid("  TCP 1 2 ESTABLISHED 900", { isWin: true })).toBeNull();
  });

  it("rejects empty or non-numeric output", () => {
    expect(lp.parsePortListenerPid("", { isWin: false })).toBeNull();
    expect(lp.parsePortListenerPid(undefined, { isWin: false })).toBeNull();
    expect(lp.parsePortListenerPid("12;rm -rf /", { isWin: false })).toBeNull();
  });
});

describe("killCloudflaredForPort", () => {
  it("scans asynchronously and tree-kills matching processes", () => {
    const kill = vi.fn();
    const runAsync = vi.fn((cmd, opts, cb) => cb(null, "  101 cloudflared --url localhost:20128\n  102 cloudflared --url localhost:1"));
    lp.killCloudflaredForPort(20128, { isWin: false, runAsync, kill });
    expect(runAsync.mock.calls[0][0]).toBe("ps -eo pid,command 2>/dev/null");
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(101, { isWin: false, tree: true });
  });

  it("uses a WMI query on Windows and survives kill failures", () => {
    const kill = vi.fn(() => { throw new Error("gone"); });
    const runAsync = vi.fn((cmd, opts, cb) => cb(null, '"h"\n"201","cloudflared --url localhost:20128"\n"202","cloudflared --url 127.0.0.1:20128"'));
    expect(() => lp.killCloudflaredForPort(20128, { isWin: true, runAsync, kill })).not.toThrow();
    expect(runAsync.mock.calls[0][0]).toContain("cloudflared.exe");
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("does nothing without a port or when the scan fails", () => {
    const runAsync = vi.fn((cmd, opts, cb) => cb(new Error("ps missing")));
    const kill = vi.fn();
    lp.killCloudflaredForPort(0, { runAsync, kill });
    expect(runAsync).not.toHaveBeenCalled();
    lp.killCloudflaredForPort(20128, { isWin: false, runAsync, kill });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("killAppProcesses", () => {
  it("kills each matching process and waits for them to exit", async () => {
    const run = vi.fn(() => "me 301 0 node /x/regent/cli.js\nme 302 0 bash");
    const kill = vi.fn(() => { throw new Error("EPERM"); });
    const waitForExit = vi.fn(async () => true);
    const pids = await lp.killAppProcesses(IDS, { isWin: false, run, kill, waitForExit, exitWaitMs: 5 });
    expect(pids).toEqual([301]);
    expect(run.mock.calls[0][0]).toBe("ps aux 2>/dev/null");
    expect(kill).toHaveBeenCalledWith(301, { isWin: false });
    expect(waitForExit).toHaveBeenCalledWith([301], { timeoutMs: 5 });
  });

  it("queries node.exe via WMI on Windows", async () => {
    const run = vi.fn(() => '"h"\n"401","node.exe C:\\regent\\cli.js"');
    const kill = vi.fn();
    const pids = await lp.killAppProcesses(IDS, { isWin: true, run, kill, waitForExit: async () => true });
    expect(run.mock.calls[0][0]).toContain("node.exe");
    expect(pids).toEqual([401]);
  });

  it("resolves without killing or waiting when the scan fails", async () => {
    const kill = vi.fn();
    const waitForExit = vi.fn();
    const pids = await lp.killAppProcesses(IDS, { isWin: false, run: () => { throw new Error("no ps"); }, kill, waitForExit });
    expect(pids).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    expect(waitForExit).not.toHaveBeenCalled();
  });
});

describe("killPortListener", () => {
  it("kills the listener and waits for the port to be released", async () => {
    const run = vi.fn(() => "611\n");
    const kill = vi.fn();
    const waitFree = vi.fn(async () => true);
    const pid = await lp.killPortListener(20128, { isWin: false, run, kill, waitFree, releaseWaitMs: 7, selfPid: SELF });
    expect(pid).toBe(611);
    expect(run.mock.calls[0][0]).toBe("lsof -ti:20128");
    expect(kill).toHaveBeenCalledWith(611, { isWin: false });
    expect(waitFree).toHaveBeenCalledWith(20128, { timeoutMs: 7 });
  });

  it("never kills itself", async () => {
    const kill = vi.fn();
    await lp.killPortListener(20128, { isWin: false, run: () => `${SELF}`, kill, waitFree: async () => true, selfPid: SELF });
    expect(kill).not.toHaveBeenCalled();
  });

  it("uses netstat on Windows", async () => {
    const run = vi.fn(() => "  TCP 0.0.0.0:20128 0.0.0.0:0 LISTENING 611");
    const kill = vi.fn();
    await lp.killPortListener(20128, { isWin: true, run, kill, waitFree: async () => true, selfPid: SELF });
    expect(run.mock.calls[0][0]).toBe("netstat -ano | findstr :20128");
    expect(kill).toHaveBeenCalledWith(611, { isWin: true });
  });

  it("returns null and skips the wait when the port is free", async () => {
    const waitFree = vi.fn();
    const pid = await lp.killPortListener(20128, { isWin: false, run: () => { throw new Error("exit 1"); }, waitFree });
    expect(pid).toBeNull();
    expect(waitFree).not.toHaveBeenCalled();
  });
});

describe("stopPreviousInstance", () => {
  const base = () => ({
    pidFile: "/x/launcher.pid",
    port: 20128,
    exitWaitMs: 9,
    readRecord: vi.fn(() => ({ cliPid: 1, serverPid: 2, exe: "node" })),
    stopRecorded: vi.fn(() => [2, 1]),
    waitForExit: vi.fn(async () => true),
    unlink: vi.fn(),
    portInUse: vi.fn(async () => false),
    killAll: vi.fn(async () => {}),
    killOnPort: vi.fn(async () => {}),
  });

  it("uses the PID record and skips the slow scan once the port is free", async () => {
    const d = base();
    const res = await lp.stopPreviousInstance(d);
    expect(d.readRecord).toHaveBeenCalledWith("/x/launcher.pid");
    expect(d.stopRecorded).toHaveBeenCalledWith({ cliPid: 1, serverPid: 2, exe: "node" });
    expect(d.unlink).toHaveBeenCalledWith("/x/launcher.pid");
    expect(d.waitForExit).toHaveBeenCalledWith([2, 1], { timeoutMs: 9 });
    expect(d.killAll).not.toHaveBeenCalled();
    expect(d.killOnPort).not.toHaveBeenCalled();
    expect(res).toEqual({ killed: [2, 1], scanned: false });
  });

  it("falls back to the machine-wide scan when the port is still taken", async () => {
    const d = base();
    d.stopRecorded = vi.fn(() => []);
    d.unlink = vi.fn(() => { throw new Error("ENOENT"); });
    d.portInUse = vi.fn(async () => true);
    const res = await lp.stopPreviousInstance(d);
    expect(d.waitForExit).not.toHaveBeenCalled();
    expect(d.killAll).toHaveBeenCalledTimes(1);
    expect(d.killOnPort).toHaveBeenCalledWith(20128);
    expect(res.scanned).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("stopRecordedInstance with real processes", () => {
  it("kills a live child named in the record and leaves a mismatched exe alone", async () => {
    const { spawn } = require("child_process");
    const path = require("path");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await new Promise((r) => child.once("spawn", r));
      const exe = path.basename(process.execPath);
      // A record whose exe does not match (PID reuse) must not kill anything.
      expect(lp.stopRecordedInstance({ cliPid: child.pid, serverPid: null, exe: "definitely-not-node" })).toEqual([]);
      expect(lp.isPidAlive(child.pid)).toBe(true);

      const exited = new Promise((r) => child.once("exit", (code, signal) => r(signal)));
      expect(lp.stopRecordedInstance({ cliPid: child.pid, serverPid: null, exe })).toEqual([child.pid]);
      expect(await exited).toBe("SIGKILL");
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("trayStatusCallbacks", () => {
  it("announces the tray only from onReady", () => {
    const log = vi.fn();
    const cb = lp.trayStatusCallbacks({ displayHost: "localhost", port: 20128, log });
    expect(log).not.toHaveBeenCalled();
    cb.onReady();
    expect(log.mock.calls.join("\n")).toContain("running in system tray");
  });

  it("explains a failure, indents multi-line hints and shows the dashboard URL", () => {
    const log = vi.fn();
    const cb = lp.trayStatusCallbacks({ displayHost: "localhost", port: 20128, log });
    cb.onError(new Error("child died\n  missing shared libraries: libx.so"));
    const out = log.mock.calls.map((c) => c[0]);
    expect(out[0]).toContain("No tray icon");
    expect(out[1]).toBe("   child died\n     missing shared libraries: libx.so");
    expect(out[2]).toBe("   Dashboard: http://localhost:20128\n");
    expect(out.join("\n")).not.toContain("running in system tray");
  });

  it("omits the message line when the error has none", () => {
    const log = vi.fn();
    lp.trayStatusCallbacks({ displayHost: "h", port: 1, log }).onError(undefined);
    expect(log).toHaveBeenCalledTimes(2);
  });
});
