// Tray start-status reporting: initTray must only call onReady once the tray
// process really registered an icon, and report every failure through onError.
// tray.js is CommonJS and requires its deps lazily, so the fakes are injected by
// intercepting Module._load and loading a fresh copy of tray.js per test.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { createRequire } from "module";
import Module from "module";

const require = createRequire(import.meta.url);
const TRAY = require.resolve("../../cli/src/cli/tray/tray.js");
const realChildProcess = require("child_process");

let fakes;
let origLoad;
let origPlatform;
let origDisplay;

function setPlatform(value) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function loadTray() {
  delete require.cache[TRAY];
  return require(TRAY);
}

class FakeSysTray {
  constructor(opts) {
    this.opts = opts;
    this._binPath = "/fake/traybin/tray_linux_release";
    FakeSysTray.last = this;
  }
  onClick(fn) { this.clickHandler = fn; }
  sendAction(a) { this.lastAction = a; }
  ready() { return FakeSysTray.readyImpl(); }
  kill() {}
}

beforeEach(() => {
  origPlatform = process.platform;
  origDisplay = process.env.DISPLAY;
  FakeSysTray.readyImpl = () => Promise.resolve();
  fakes = {
    systray2: { default: FakeSysTray },
    "./autostart": { isAutoStartEnabled: () => false },
    "./trayWin": { initWinTray: vi.fn(() => ({ updateItem: vi.fn(), kill: vi.fn() })) },
    child_process: { ...realChildProcess, execFileSync: vi.fn(() => "") },
  };
  origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === TRAY && Object.prototype.hasOwnProperty.call(fakes, request)) {
      if (fakes[request] instanceof Error) throw fakes[request];
      return fakes[request];
    }
    return origLoad.call(this, request, parent, isMain);
  };
});

afterEach(() => {
  Module._load = origLoad;
  setPlatform(origPlatform);
  if (origDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = origDisplay;
  vi.useRealTimers();
  delete require.cache[TRAY];
});

function callbacks() {
  return { port: 20128, onReady: vi.fn(), onError: vi.fn() };
}

describe("initTray start status", () => {
  it("reports a missing graphical session on Linux instead of pretending", () => {
    setPlatform("linux");
    delete process.env.DISPLAY;
    const opts = callbacks();
    expect(loadTray().initTray(opts)).toBeNull();
    expect(opts.onReady).not.toHaveBeenCalled();
    expect(opts.onError.mock.calls[0][0].message).toMatch(/no graphical session/);
  });

  it("calls onReady once systray2 completes its handshake", async () => {
    setPlatform("darwin");
    const opts = callbacks();
    const tray = loadTray().initTray(opts);
    expect(tray).toBeInstanceOf(FakeSysTray);
    await vi.waitFor(() => expect(opts.onReady).toHaveBeenCalledTimes(1));
    expect(opts.onError).not.toHaveBeenCalled();
    expect(tray.opts.menu.tooltip).toBe("Elizabeth's Proxy - Port 20128");
  });

  it("fails after the handshake timeout when the tray child never answers", async () => {
    vi.useFakeTimers();
    setPlatform("darwin");
    FakeSysTray.readyImpl = () => new Promise(() => {});
    const opts = callbacks();
    loadTray().initTray(opts);
    expect(opts.onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(opts.onError).toHaveBeenCalledTimes(1);
    expect(opts.onError.mock.calls[0][0].message).toMatch(/no handshake from the tray process within 3000ms/);
    expect(opts.onReady).not.toHaveBeenCalled();
  });

  it("ignores a late handshake after the timeout already reported failure", async () => {
    vi.useFakeTimers();
    setPlatform("darwin");
    let resolveReady;
    FakeSysTray.readyImpl = () => new Promise((r) => { resolveReady = r; });
    const opts = callbacks();
    loadTray().initTray(opts);
    await vi.advanceTimersByTimeAsync(3000);
    resolveReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(opts.onError).toHaveBeenCalledTimes(1);
    expect(opts.onReady).not.toHaveBeenCalled();
  });

  it("adds an actionable libappindicator hint when the Linux tray binary can't load", async () => {
    setPlatform("linux");
    process.env.DISPLAY = ":0";
    fakes.child_process.execFileSync = vi.fn(() =>
      [
        "\tlinux-vdso.so.1 (0x00007ffc)",
        "\tlibappindicator3.so.1 => not found",
        "\tlibgtk-3.so.0 => /usr/lib/libgtk-3.so.0 (0x0000)",
        "\tlibdbusmenu-gtk3.so.4 => not found",
      ].join("\n"));
    FakeSysTray.readyImpl = () => Promise.reject(new Error("tray child exited with code 127"));
    const opts = callbacks();
    loadTray().initTray(opts);
    await vi.waitFor(() => expect(opts.onError).toHaveBeenCalledTimes(1));
    const msg = opts.onError.mock.calls[0][0].message;
    expect(fakes.child_process.execFileSync).toHaveBeenCalledWith("ldd", ["/fake/traybin/tray_linux_release"], expect.any(Object));
    expect(msg).toContain("tray child exited with code 127");
    expect(msg).toContain("missing shared libraries: libappindicator3.so.1, libdbusmenu-gtk3.so.4");
    expect(msg).toContain("libayatana");
    expect(opts.onReady).not.toHaveBeenCalled();
  });

  it("lists other missing libraries without the libayatana advice", async () => {
    setPlatform("linux");
    process.env.DISPLAY = ":0";
    fakes.child_process.execFileSync = vi.fn(() => "\tlibfoo.so.2 => not found\n");
    FakeSysTray.readyImpl = () => Promise.reject(new Error("boom"));
    const opts = callbacks();
    loadTray().initTray(opts);
    await vi.waitFor(() => expect(opts.onError).toHaveBeenCalledTimes(1));
    const msg = opts.onError.mock.calls[0][0].message;
    expect(msg).toBe("boom\n  missing shared libraries: libfoo.so.2");
  });

  it("passes the original error through when ldd finds nothing or fails", async () => {
    setPlatform("linux");
    process.env.DISPLAY = ":0";
    fakes.child_process.execFileSync = vi.fn(() => { throw new Error("no ldd"); });
    const err = new Error("EACCES");
    FakeSysTray.readyImpl = () => Promise.reject(err);
    const opts = callbacks();
    loadTray().initTray(opts);
    await vi.waitFor(() => expect(opts.onError).toHaveBeenCalledWith(err));
  });

  it("forwards the legacy systray onReady event when systray2 is unavailable", () => {
    setPlatform("darwin");
    fakes.systray2 = new Error("Cannot find module 'systray2'");
    let readyCb;
    fakes.systray = {
      default: class {
        onClick() {}
        onReady(cb) { readyCb = cb; }
        onError() {}
      },
    };
    const opts = callbacks();
    expect(loadTray().initTray(opts)).not.toBeNull();
    expect(opts.onReady).not.toHaveBeenCalled();
    readyCb();
    expect(opts.onReady).toHaveBeenCalledTimes(1);
  });

  it("reports a constructor crash through onError", () => {
    setPlatform("darwin");
    fakes.systray2 = { default: class { constructor() { throw new Error("spawn EBADARCH"); } } };
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const opts = callbacks();
    try {
      expect(loadTray().initTray(opts)).toBeNull();
    } finally {
      write.mockRestore();
    }
    expect(opts.onError.mock.calls[0][0].message).toBe("spawn EBADARCH");
  });

  it("reports ready immediately for the Windows NotifyIcon tray", () => {
    setPlatform("win32");
    const opts = callbacks();
    expect(loadTray().initTray(opts)).not.toBeNull();
    expect(fakes["./trayWin"].initWinTray).toHaveBeenCalledTimes(1);
    expect(opts.onReady).toHaveBeenCalledTimes(1);
    expect(opts.onError).not.toHaveBeenCalled();
  });

  it("reports a Windows tray failure through onError", () => {
    setPlatform("win32");
    fakes["./trayWin"] = new Error("powershell missing");
    const opts = callbacks();
    expect(loadTray().initTray(opts)).toBeNull();
    expect(opts.onError.mock.calls[0][0].message).toBe("powershell missing");
    expect(opts.onReady).not.toHaveBeenCalled();
  });
});
