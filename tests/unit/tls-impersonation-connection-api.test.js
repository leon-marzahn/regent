// PUT /api/providers/[id] stores only a validated per-account TLS fingerprint.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let createConnection;
let updateConnection;
let getStoredConnection;

function request(method, url, body) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function put(id, body) {
  const res = await updateConnection(
    request("PUT", `https://regent.local/api/providers/${id}`, body),
    {
      params: Promise.resolve({ id }),
    },
  );
  expect(res.status).toBe(200);
  return (await getStoredConnection(id)).providerSpecificData || {};
}

describe("per-account TLS fingerprint setting", () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-tls-api-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), { status: init.status || 200 });
        },
      },
    }));
    ({ POST: createConnection } = await import("@/app/api/providers/route.js"));
    ({ PUT: updateConnection } = await import("@/app/api/providers/[id]/route.js"));
    ({ getProviderConnectionById: getStoredConnection } = await import("@/models/index.js"));
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    global._dbAdapter?.instance?.close?.();
    delete global._dbAdapter;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  async function createOpenAi() {
    const res = await createConnection(
      request("POST", "https://regent.local/api/providers", {
        provider: "openai",
        name: "tls test",
        apiKey: "sk-test",
      }),
    );
    expect(res.status).toBe(201);
    return (await res.json()).connection.id;
  }

  it("stores, keeps across unrelated edits, and clears the setting", async () => {
    const id = await createOpenAi();
    expect(
      (await put(id, { tlsImpersonation: { browser: "firefox", os: "windows" } })).tlsImpersonation,
    ).toEqual({
      browser: "firefox",
      os: "windows",
    });
    expect((await put(id, { name: "renamed" })).tlsImpersonation).toEqual({
      browser: "firefox",
      os: "windows",
    });
    expect((await put(id, { tlsImpersonation: null })).tlsImpersonation).toBeUndefined();
  });

  it("sanitizes values smuggled through providerSpecificData", async () => {
    const id = await createOpenAi();
    const psd = await put(id, {
      providerSpecificData: { tlsImpersonation: { browser: "x", os: "y", extra: 1 } },
    });
    expect(psd.tlsImpersonation).toEqual({ browser: "chrome", os: "macos" });
  });
});

// Same route, same pattern: the upstream routing object is validated before it is stored.
describe("per-connection upstream routing setting", () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-routing-api-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), { status: init.status || 200 });
        },
      },
    }));
    ({ POST: createConnection } = await import("@/app/api/providers/route.js"));
    ({ PUT: updateConnection } = await import("@/app/api/providers/[id]/route.js"));
    ({ getProviderConnectionById: getStoredConnection } = await import("@/models/index.js"));
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    global._dbAdapter?.instance?.close?.();
    delete global._dbAdapter;
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  async function createOpenRouter() {
    const res = await createConnection(
      request("POST", "https://regent.local/api/providers", {
        provider: "openrouter",
        name: "routing test",
        apiKey: "sk-or-test",
      }),
    );
    expect(res.status).toBe(201);
    return (await res.json()).connection.id;
  }

  it("stores, keeps across unrelated edits, and clears the setting", async () => {
    const id = await createOpenRouter();
    const routing = { only: ["google-vertex/global"], allow_fallbacks: false };
    expect((await put(id, { providerRouting: routing })).providerRouting).toEqual(routing);
    expect((await put(id, { name: "renamed" })).providerRouting).toEqual(routing);
    expect((await put(id, { providerRouting: null })).providerRouting).toBeUndefined();
  });

  it("sanitizes values sent top-level or through providerSpecificData", async () => {
    const id = await createOpenRouter();
    expect((await put(id, { providerRouting: { only: ["Anthropic", "bad slug"], extra: 1 } })).providerRouting)
      .toEqual({ only: ["anthropic"] });
    const psd = await put(id, { providerSpecificData: { providerRouting: { order: ["x/y/z"], allow_fallbacks: "no" } } });
    expect(psd.providerRouting).toBeUndefined();
  });
});
