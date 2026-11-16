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

  async function putStatus(id, body) {
    const res = await updateConnection(request("PUT", `https://regent.local/api/providers/${id}`, body), {
      params: Promise.resolve({ id }),
    });
    return { status: res.status, body: await res.json() };
  }

  it("lowercases and deduplicates valid slugs", async () => {
    const id = await createOpenRouter();
    expect((await put(id, { providerRouting: { only: ["Anthropic", "anthropic", "Google-Vertex/Global"] } })).providerRouting)
      .toEqual({ only: ["anthropic", "google-vertex/global"] });
  });

  it("rejects invalid input with a 400 and keeps the stored policy", async () => {
    const id = await createOpenRouter();
    const policy = { only: ["google-vertex/global"], allow_fallbacks: false };
    await put(id, { providerRouting: policy });
    const hostile = [
      { providerRouting: "anthropic, google-vertex" },
      { providerRouting: { only: ["google-vertex/global", "bad slug"] } },
      { providerRouting: { only: ["google-vertex/global/x"] } },
      { providerRouting: { only: ["anthropic"], allow_fallbacks: "false" } },
      { providerRouting: { only: ["anthropic"], sort: "price" } },
      { providerRouting: { ignore: Array.from({ length: 33 }, (_, i) => `p${i}`) } },
      { providerSpecificData: { providerRouting: { order: ["x/y/z"] } } },
    ];
    for (const body of hostile) {
      const res = await putStatus(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBeTruthy();
    }
    expect((await getStoredConnection(id)).providerSpecificData.providerRouting).toEqual(policy);
  });

  it("validates routing on create too: stores the validated value, refuses bad input", async () => {
    const create = async (provider, extra) => {
      const res = await createConnection(
        request("POST", "https://regent.local/api/providers", { provider, name: `c-${Math.random()}`, apiKey: "sk-test", ...extra }),
      );
      return { status: res.status, body: await res.json() };
    };

    const ok = await create("openrouter", { providerRouting: { only: ["Google-Vertex/Global"], allow_fallbacks: false } });
    expect(ok.status).toBe(201);
    expect((await getStoredConnection(ok.body.connection.id)).providerSpecificData.providerRouting)
      .toEqual({ only: ["google-vertex/global"], allow_fallbacks: false });

    const nested = await create("openrouter", { providerSpecificData: { providerRouting: { order: "anthropic" } } });
    expect(nested.status).toBe(201);
    expect((await getStoredConnection(nested.body.connection.id)).providerSpecificData.providerRouting)
      .toEqual({ order: ["anthropic"] });

    const bad = [
      ["openrouter", { providerSpecificData: { providerRouting: { only: ["bad slug", "x/y/z"], allow_fallbacks: "false", sort: "price" } } }],
      ["openrouter", { providerRouting: "anthropic" }],
      ["groq", { providerSpecificData: { providerRouting: { only: ["anthropic"] } } }],
    ];
    for (const [provider, extra] of bad) {
      const res = await create(provider, extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.body.error).toBeTruthy();
    }
  });

  it("refuses routing for providers without the quirk and never keeps one there", async () => {
    const created = await createConnection(
      request("POST", "https://regent.local/api/providers", { provider: "openai", name: "no routing", apiKey: "sk-test" }),
    );
    const id = (await created.json()).connection.id;
    const res = await putStatus(id, { providerRouting: { only: ["anthropic"] } });
    expect(res.status).toBe(400);
    expect((await put(id, { providerRouting: null })).providerRouting).toBeUndefined();
  });
});
