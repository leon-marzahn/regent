// The other on-disk/console debug outputs (MITM dumps, responses stream logs, legacy
// error log, insecure-TLS retry warning) must redact credentials too.
import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { maskBody } from "../../open-sse/utils/maskSecrets.cjs";

const require = createRequire(import.meta.url);
const KEY = "sk-dump-SEEDED-5a1b2c3d4e";

function readAll(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? readAll(path.join(dir, e.name)) : [fs.readFileSync(path.join(dir, e.name), "utf8")]))
    .join("\n");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("MITM dumps", () => {
  it("redact request headers, URL, body and response headers/body", () => {
    const { dumpRequest, createResponseDumper } = require("../../src/mitm/logger.js");
    const { DATA_DIR } = require("../../src/mitm/paths.js");
    const dir = path.join(DATA_DIR, "logs", "mitm");
    const req = {
      method: "POST",
      url: `/v1/models/x:generateContent?key=${KEY}`,
      headers: { host: "api.test", authorization: `Bearer ${KEY}`, "x-goog-api-key": KEY },
    };
    expect(dumpRequest(req, Buffer.from(JSON.stringify({ refresh_token: KEY, q: "hi" })))).toBeTruthy();
    dumpRequest(req, Buffer.from(`token=${KEY} not json Bearer ${KEY}`));
    const dumper = createResponseDumper(req);
    dumper.writeHeader(200, { "set-cookie": `sid=${KEY}`, "content-type": "application/json" });
    dumper.writeChunk(`{"access_token":"${KEY}"}`);
    dumper.end();
    const all = readAll(dir);
    expect(all).toContain("[REDACTED]");
    expect(all).not.toContain(KEY);
    expect(fs.readdirSync(dir).join(" ")).not.toContain(KEY);
  });
});

describe("responses stream logger", () => {
  it("redacts credentials in logged events", async () => {
    const { createResponsesLogger } = await import("../../open-sse/transformer/responsesTransformer.js");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "regent-resp-"));
    const logger = createResponsesLogger("m", base);
    logger.logInput(`data: {"api_key":"${KEY}"}`);
    logger.logOutput(`Authorization: Bearer ${KEY}`);
    logger.flush();
    expect(readAll(base)).not.toContain(KEY);
    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe("request logger legacy paths", () => {
  it("redacts the legacy error log and streamed chunks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-legacy-"));
    vi.stubEnv("ENABLE_REQUEST_LOGS", "true");
    vi.stubEnv("REQUEST_LOGS_DIR", dir);
    vi.resetModules();
    const { createRequestLogger, logError } = await import("../../open-sse/utils/requestLogger.js");
    const logger = await createRequestLogger("openai", "openai", "m");
    logger.appendProviderChunk(new TextEncoder().encode(`data: {"refresh_token":"${KEY}"}\n`));
    logger.appendOpenAIChunk(`url=https://x.test/?key=${KEY}`);
    logger.appendConvertedChunk(`Bearer ${KEY}`);
    logger.logProviderResponse(500, "err", new Headers({ "set-cookie": `a=${KEY}` }), { error: `bad ?key=${KEY}` });
    logger.logError(new Error(`fetch https://x.test/?key=${KEY} failed`), { apiKey: KEY });
    logError("gemini", { error: new Error("boom"), url: `https://x.test/?key=${KEY}`, model: "m", requestBody: { client_secret: KEY } });
    const all = readAll(dir);
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(KEY);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("insecure TLS retry warning", () => {
  it("does not print a ?key= value", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = Object.assign(new Error("self signed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    const fetchStub = vi.fn().mockRejectedValueOnce(err).mockResolvedValue(new Response("ok"));
    // proxyFetch sends through the undici package's fetch.
    vi.doMock("undici", async (importOriginal) => ({ ...(await importOriginal()), fetch: fetchStub }));
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    await proxyAwareFetch(`https://x.test/v1?key=${KEY}`, { method: "GET" }).catch(() => {});
    vi.doUnmock("undici");
    expect(fetchStub).toHaveBeenCalledTimes(2);
    const printed = warn.mock.calls.flat().join(" ");
    expect(printed).toContain("insecure TLS");
    expect(printed).not.toContain(KEY);
  });
});

describe("maskBody depth guard", () => {
  it("stops recursing on pathologically deep input", () => {
    let deep = { v: 1 };
    for (let i = 0; i < 60; i++) deep = { n: deep };
    expect(() => maskBody(deep)).not.toThrow();
  });
});
