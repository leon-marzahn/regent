// Fast previous-instance detection for the launcher.
//
// The launcher records its own PID and its server's PID in <dataDir>/launcher.pid.
// The next launch stops exactly those processes instead of scanning every process
// on the machine (a PowerShell WMI query costs ~0.5s per call on Windows), and only
// falls back to the full scan when the port is still occupied.

const { exec, execFileSync, execSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const PID_FILE_NAME = "launcher.pid";
const PORT_PROBE_TIMEOUT_MS = 500;
const DEFAULT_WAIT_TIMEOUT_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const EXE_LOOKUP_TIMEOUT_MS = 2000;

function getPidFilePath(dataDir) {
  return path.join(dataDir, PID_FILE_NAME);
}

function toPid(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// PIDs parsed from ps/lsof/netstat/WMI output: digits only, positive safe integer.
// Anything else (empty, "1e3", "12;rm", negative) is rejected before it reaches a kill.
function parsePid(value) {
  if (typeof value === "number") return toPid(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^\d{1,10}$/.test(text) ? toPid(Number(text)) : null;
}

/**
 * @param {string} file
 * @param {{ cliPid: number, serverPid: number|null, port: number, exe: string }} record
 */
function writePidRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, file);
}

/** @returns {{ cliPid: number, serverPid: number|null, port: number|null, exe: string } | null} */
function readPidRecord(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const cliPid = toPid(parsed.cliPid);
  if (!cliPid || typeof parsed.exe !== "string" || !parsed.exe) return null;
  return {
    cliPid,
    serverPid: toPid(parsed.serverPid),
    port: Number.isSafeInteger(parsed.port) ? parsed.port : null,
    exe: parsed.exe,
  };
}

function removePidRecordIfOwner(file, ownerPid) {
  const record = readPidRecord(file);
  if (!record || record.cliPid !== ownerPid) return;
  try { fs.unlinkSync(file); } catch { /* already removed */ }
}

function isPidAlive(pid, { kill = process.kill.bind(process) } = {}) {
  if (!toPid(pid)) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function normalizeExeName(name) {
  return String(name || "").trim().toLowerCase().replace(/\.exe$/, "");
}

function lookupExeName(pid) {
  if (process.platform === "win32") {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: EXE_LOOKUP_TIMEOUT_MS,
    });
    const match = out.match(/^"([^"]+)","(\d+)"/m);
    return match && Number(match[2]) === pid ? match[1] : "";
  }
  // /proc/<pid>/comm is rewritten by process.title (Next sets "next-server (v…)"),
  // so resolve the real executable instead.
  try {
    return fs.readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      timeout: EXE_LOOKUP_TIMEOUT_MS,
    });
  }
}

// Guards against PID reuse: a stale record must not kill an unrelated program.
function processMatchesExe(pid, exe) {
  const expected = normalizeExeName(exe);
  if (!expected || !toPid(pid)) return false;
  try {
    return normalizeExeName(path.basename(lookupExeName(pid))) === expected;
  } catch {
    return false;
  }
}

function defaultKillPid(pid) {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
      timeout: EXE_LOOKUP_TIMEOUT_MS,
    });
  } else {
    process.kill(pid, "SIGKILL");
  }
}

/**
 * Stops the processes named in a launcher record. Returns the PIDs it killed.
 * Server first so the port is released even if the CLI kill fails.
 */
function stopRecordedInstance(record, {
  selfPid = process.pid,
  isAlive = isPidAlive,
  matchesExe = processMatchesExe,
  killPid = defaultKillPid,
} = {}) {
  if (!record) return [];
  const candidates = [record.serverPid, record.cliPid].filter((pid) => toPid(pid) && pid !== selfPid);
  const killed = [];
  for (const pid of candidates) {
    if (!isAlive(pid) || !matchesExe(pid, record.exe)) continue;
    try {
      killPid(pid);
      killed.push(pid);
    } catch { /* already gone or not permitted — the port check decides what's next */ }
  }
  return killed;
}

function isPortInUse(port, host = "127.0.0.1", timeoutMs = PORT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function pollUntil(check, { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function waitForPortFree(port, opts = {}) {
  return pollUntil(async () => !(await isPortInUse(port)), opts);
}

function waitForPidsExit(pids, { isAlive = isPidAlive, ...opts } = {}) {
  return pollUntil(() => pids.every((pid) => !isAlive(pid)), opts);
}

// Force-kills one PID. `tree` adds taskkill's /T (child processes) on Windows.
function forceKillPid(pid, {
  isWin = process.platform === "win32",
  tree = false,
  execFile = execFileSync,
  kill = process.kill.bind(process),
} = {}) {
  if (isWin) {
    const args = tree ? ["/F", "/T", "/PID", String(pid)] : ["/F", "/PID", String(pid)];
    execFile("taskkill", args, { stdio: "ignore", windowsHide: true, timeout: 3000 });
  } else {
    kill(pid, "SIGKILL");
  }
}

/**
 * PIDs of cloudflared processes whose command line targets this app's port.
 * `output` is the WMI CSV (Windows, header row first) or `ps -eo pid,command`.
 */
function parseCloudflaredPids(output, appPort, { isWin = process.platform === "win32", selfPid = process.pid } = {}) {
  if (!output || !appPort) return [];
  const portMatchers = [`localhost:${appPort}`, `127.0.0.1:${appPort}`];
  const lines = isWin ? output.split("\n").slice(1) : output.split("\n");
  const pids = [];
  for (const line of lines) {
    if (!portMatchers.some((m) => line.includes(m))) continue;
    const pid = isWin
      ? parsePid(line.match(/^"(\d+)"/)?.[1])
      : line.includes("cloudflared") ? parsePid(line.trim().split(/\s+/)[0]) : null;
    if (pid && pid !== selfPid) pids.push(pid);
  }
  return pids;
}

/**
 * PIDs of node processes running this launcher (or a legacy-named one).
 * `output` is the node.exe WMI CSV (Windows) or `ps aux` (macOS/Linux).
 * Whitelist only: editors/grep/strace that merely mention the name are skipped,
 * and there is no bare "next-server" match (every Next.js app shares that title).
 */
function parseAppProcessPids(output, identifiers, { isWin = process.platform === "win32", selfPid = process.pid } = {}) {
  if (!output) return [];
  const lines = isWin ? output.split("\n").slice(1).filter((l) => l.trim()) : output.split("\n");
  const pids = [];
  for (const line of lines) {
    const cmd = line.toLowerCase();
    const isAppProcess =
      cmd.includes("node") &&
      identifiers.some((id) =>
        cmd.includes(id) &&
        (cmd.includes("cli.js") || (isWin && cmd.includes(`\\${id}`)) || cmd.includes(`/${id}`)));
    if (!isAppProcess) continue;
    const pid = isWin
      ? parsePid(line.match(/^"(\d+)"/)?.[1])
      : parsePid(line.trim().split(/\s+/)[1]);
    if (pid && pid !== selfPid) pids.push(pid);
  }
  return pids;
}

/**
 * The PID listening on a port, from `netstat -ano | findstr :<port>` (Windows)
 * or `lsof -ti:<port>` (macOS/Linux). Null when nothing usable is listed.
 */
function parsePortListenerPid(output, { isWin = process.platform === "win32" } = {}) {
  const text = String(output || "").trim();
  if (!text) return null;
  if (isWin) {
    const line = text.split("\n").find((l) => l.includes("LISTENING"));
    return line ? parsePid(line.trim().split(/\s+/).pop()) : null;
  }
  return parsePid(text.split("\n")[0]);
}

const WMI_PROCESS_QUERY = (exeName) =>
  `powershell -NonInteractive -WindowStyle Hidden -Command "Get-WmiObject Win32_Process -Filter 'Name=\\"${exeName}\\"' | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"`;

/**
 * Kills cloudflared processes whose --url targets this app's port (covers a
 * stale tunnel PID file). The scan runs asynchronously so it never blocks
 * launcher startup.
 */
function killCloudflaredForPort(appPort, {
  isWin = process.platform === "win32",
  runAsync = exec,
  kill = forceKillPid,
} = {}) {
  if (!appPort) return;
  const scanCmd = isWin ? WMI_PROCESS_QUERY("cloudflared.exe") : "ps -eo pid,command 2>/dev/null";
  runAsync(scanCmd, { encoding: "utf8", windowsHide: true, timeout: 5000 }, (err, output) => {
    if (err || !output) return;
    for (const pid of parseCloudflaredPids(output, appPort, { isWin })) {
      try { kill(pid, { isWin, tree: true }); } catch { /* already gone */ }
    }
  });
}

/**
 * Full machine-wide scan for this launcher's node processes; kills them and
 * waits until they are gone. Never rejects. Resolves with the PIDs it targeted.
 */
async function killAppProcesses(identifiers, {
  isWin = process.platform === "win32",
  run = execSync,
  kill = forceKillPid,
  waitForExit = waitForPidsExit,
  exitWaitMs = 1000,
} = {}) {
  let pids = [];
  try {
    // Windows: WMI gives the full CommandLine (tasklist /V doesn't include it).
    const output = isWin
      ? run(WMI_PROCESS_QUERY("node.exe"), { encoding: "utf8", windowsHide: true, timeout: 5000 })
      : run("ps aux 2>/dev/null", { encoding: "utf8", timeout: 5000 });
    pids = parseAppProcessPids(output, identifiers, { isWin });
  } catch { /* no processes found or scan failed */ }

  if (pids.length === 0) return pids;
  for (const pid of pids) {
    try { kill(pid, { isWin }); } catch { /* already dead or not permitted */ }
  }
  try { await waitForExit(pids, { timeoutMs: exitWaitMs }); } catch { /* best effort */ }
  return pids;
}

/**
 * Kills whatever listens on `port` (never this process) and, when a listener
 * was found, waits for the port to be released. Never rejects.
 * Resolves with the listener PID, or null.
 */
async function killPortListener(port, {
  isWin = process.platform === "win32",
  run = execSync,
  kill = forceKillPid,
  waitFree = waitForPortFree,
  releaseWaitMs = DEFAULT_WAIT_TIMEOUT_MS,
  selfPid = process.pid,
} = {}) {
  let pid = null;
  try {
    const output = isWin
      ? run(`netstat -ano | findstr :${port}`, { encoding: "utf8", shell: true, windowsHide: true, timeout: 5000 })
      : run(`lsof -ti:${port}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    pid = parsePortListenerPid(output, { isWin });
    if (pid && pid !== selfPid) kill(pid, { isWin });
  } catch { /* port is free or the lookup failed */ }

  if (pid) {
    try { await waitFree(port, { timeoutMs: releaseWaitMs }); } catch { /* best effort */ }
  }
  return pid;
}

/**
 * Stops the previous launcher: its PID record first (fast path), then the slow
 * machine-wide scan only when the port is still occupied afterwards.
 */
async function stopPreviousInstance({
  pidFile,
  port,
  exitWaitMs = 1000,
  readRecord = readPidRecord,
  stopRecorded = stopRecordedInstance,
  waitForExit = waitForPidsExit,
  portInUse = isPortInUse,
  unlink = fs.unlinkSync,
  killAll,
  killOnPort,
}) {
  const killed = stopRecorded(readRecord(pidFile));
  try { unlink(pidFile); } catch { /* no record */ }
  if (killed.length > 0) await waitForExit(killed, { timeoutMs: exitWaitMs });

  if (!(await portInUse(port))) return { killed, scanned: false };
  await killAll();
  await killOnPort(port);
  return { killed, scanned: true };
}

/**
 * Tray-mode status lines. onReady only fires once the tray process really
 * registered an icon; onError explains why there is none.
 */
function trayStatusCallbacks({ displayHost, port, log = console.log }) {
  return {
    onReady: () => {
      log("\n💡 Router is now running in system tray. Close this terminal if you want.");
      log("   Right-click tray icon to open dashboard or quit.\n");
    },
    onError: (err) => {
      log("\n⚠️  No tray icon — the server keeps running.");
      if (err?.message) log(`   ${err.message.split("\n").join("\n   ")}`);
      log(`   Dashboard: http://${displayHost}:${port}\n`);
    },
  };
}

module.exports = {
  forceKillPid,
  killCloudflaredForPort,
  killAppProcesses,
  killPortListener,
  parseCloudflaredPids,
  parseAppProcessPids,
  parsePortListenerPid,
  stopPreviousInstance,
  trayStatusCallbacks,
  parsePid,
  getPidFilePath,
  writePidRecord,
  readPidRecord,
  removePidRecordIfOwner,
  isPidAlive,
  processMatchesExe,
  stopRecordedInstance,
  isPortInUse,
  waitForPortFree,
  waitForPidsExit,
};
