// Dashboard API routes that read/write credentials: API keys, provider connections,
// provider nodes (+ their URL validator) and proxy pools. Handlers run against a real
// SQLite DB in a per-file temp DATA_DIR. Auth is enforced by src/dashboardGuard.js
// (covered in api-route-auth-gate.test.js), so these call the handlers directly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vite-plus/test";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-api-cred-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

afterEach(() => vi.unstubAllGlobals());

const json = (method, body) =>
  new Request("http://localhost/api", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (url = "http://localhost/api") => new Request(url);
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const SECRET_FIELDS = ["apiKey", "accessToken", "refreshToken", "idToken"];

describe("/api/keys", () => {
  it("POST validates name and creates a key; [id] GET/PUT/DELETE round-trip", async () => {
    const list = await import("@/app/api/keys/route.js");
    const one = await import("@/app/api/keys/[id]/route.js");

    expect((await list.POST(json("POST", {}))).status).toBe(400);

    const res = await list.POST(json("POST", { name: "laptop" }));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.key).toMatch(/^sk-/);

    const all = await (await list.GET()).json();
    expect(all.keys.map((k) => k.id)).toContain(created.id);

    expect((await one.GET(get(), ctx("missing"))).status).toBe(404);
    expect((await (await one.GET(get(), ctx(created.id))).json()).key.name).toBe("laptop");

    expect((await one.PUT(json("PUT", { isActive: false }), ctx("missing"))).status).toBe(404);
    const bad = await one.PUT(json("PUT", { access: { restricted: "yes", allow: 5 } }), ctx(created.id));
    expect(bad.status).toBe(400);
    const upd = await (await one.PUT(json("PUT", { isActive: false }), ctx(created.id))).json();
    expect(upd.key.isActive).toBe(false);

    expect((await one.DELETE(get(), ctx(created.id))).status).toBe(200);
    expect((await one.DELETE(get(), ctx(created.id))).status).toBe(404);
  });
});

describe("/api/providers", () => {
  it("POST validates provider/key/proxy input", async () => {
    const r = await import("@/app/api/providers/route.js");
    expect((await r.POST(json("POST", { provider: "not-a-provider", apiKey: "x" }))).status).toBe(400);
    expect((await r.POST(json("POST", { provider: "openai" }))).status).toBe(400);
    expect((await r.POST(json("POST", { provider: "openai", apiKey: "x", connectionProxyEnabled: true }))).status).toBe(400);
    expect((await r.POST(json("POST", { provider: "openai", apiKey: "x", proxyPoolId: "nope" }))).status).toBe(400);
  });

  it("never returns the stored API key from POST, list GET or [id] GET/PUT", async () => {
    const r = await import("@/app/api/providers/route.js");
    const one = await import("@/app/api/providers/[id]/route.js");
    const SECRET = "sk-FAKE-provider-secret-123";

    const res = await r.POST(json("POST", { provider: "openai", apiKey: SECRET, name: "primary" }));
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const { connection } = JSON.parse(text);

    // Seed OAuth tokens directly so the GETs have every secret field to leak.
    await db.updateProviderConnection(connection.id, { accessToken: "at-FAKE", refreshToken: "rt-FAKE", idToken: "id-FAKE" });

    const listText = await (await r.GET()).text();
    const oneText = await (await one.GET(get(), ctx(connection.id))).text();
    for (const body of [listText, oneText]) {
      for (const s of [SECRET, "at-FAKE", "rt-FAKE", "id-FAKE"]) expect(body).not.toContain(s);
    }
    const fetched = JSON.parse(oneText).connection;
    for (const f of SECRET_FIELDS) expect(fetched).not.toHaveProperty(f);

    // PUT rotates the key but the response is still masked.
    const putRes = await one.PUT(json("PUT", { apiKey: "sk-FAKE-rotated", name: "renamed" }), ctx(connection.id));
    const putText = await putRes.text();
    expect(putText).not.toContain("sk-FAKE-rotated");
    expect(JSON.parse(putText).connection.name).toBe("renamed");
    expect((await db.getProviderConnectionById(connection.id)).apiKey).toBe("sk-FAKE-rotated");
  });

  it("[id] PUT validates proxy settings and 404s on unknown ids; DELETE removes", async () => {
    const one = await import("@/app/api/providers/[id]/route.js");
    const conn = await db.createProviderConnection({ provider: "groq", authType: "apikey", name: "g", apiKey: "k" });

    expect((await one.GET(get(), ctx("missing"))).status).toBe(404);
    expect((await one.PUT(json("PUT", { name: "x" }), ctx("missing"))).status).toBe(404);
    expect((await one.PUT(json("PUT", { connectionProxyEnabled: true }), ctx(conn.id))).status).toBe(400);
    expect((await one.PUT(json("PUT", { proxyPoolId: "nope" }), ctx(conn.id))).status).toBe(400);

    const pool = await db.createProxyPool({ name: "p", proxyUrl: "http://p.example:1" });
    const attached = await (await one.PUT(json("PUT", { proxyPoolId: pool.id, connectionProxyEnabled: true, connectionProxyUrl: " http://x:1 " }), ctx(conn.id))).json();
    expect(attached.connection.providerSpecificData).toMatchObject({ proxyPoolId: pool.id, connectionProxyUrl: "http://x:1" });
    const detached = await (await one.PUT(json("PUT", { proxyPoolId: "__none__" }), ctx(conn.id))).json();
    expect(detached.connection.providerSpecificData.proxyPoolId).toBeUndefined();

    expect((await one.DELETE(get(), ctx(conn.id))).status).toBe(200);
    expect((await one.DELETE(get(), ctx(conn.id))).status).toBe(404);
  });
});

describe("/api/provider-nodes", () => {
  it("POST validates and sanitizes base URLs; [id] PUT/DELETE cascade to connections", async () => {
    const r = await import("@/app/api/provider-nodes/route.js");
    const one = await import("@/app/api/provider-nodes/[id]/route.js");

    expect((await r.POST(json("POST", { prefix: "p" }))).status).toBe(400);
    expect((await r.POST(json("POST", { name: "n" }))).status).toBe(400);
    expect((await r.POST(json("POST", { name: "n", prefix: "p", apiType: "bogus" }))).status).toBe(400);
    expect((await r.POST(json("POST", { name: "n", prefix: "p", type: "weird" }))).status).toBe(400);

    const anth = await (await r.POST(json("POST", { name: "A", prefix: "a", type: "anthropic-compatible", baseUrl: "https://x.example/v1/messages/" }))).json();
    expect(anth.node.baseUrl).toBe("https://x.example/v1");
    const emb = await (await r.POST(json("POST", { name: "E", prefix: "e", type: "custom-embedding", baseUrl: "https://e.example/v1/embeddings" }))).json();
    expect(emb.node.baseUrl).toBe("https://e.example/v1");
    const oai = await (await r.POST(json("POST", { name: " O ", prefix: " o ", apiType: "chat" }))).json();
    expect(oai.node).toMatchObject({ name: "O", prefix: "o", baseUrl: "https://api.openai.com/v1" });

    expect((await (await r.GET()).json()).nodes).toHaveLength(3);

    // A connection bound to the node picks up node edits.
    const conn = await db.createProviderConnection({ provider: oai.node.id, authType: "apikey", name: "c", apiKey: "k", providerSpecificData: { prefix: "o" } });
    expect((await one.PUT(json("PUT", { name: "x", prefix: "y", apiType: "chat", baseUrl: "u" }), ctx("missing"))).status).toBe(404);
    expect((await one.PUT(json("PUT", { prefix: "y", apiType: "chat", baseUrl: "u" }), ctx(oai.node.id))).status).toBe(400);
    expect((await one.PUT(json("PUT", { name: "x", apiType: "chat", baseUrl: "u" }), ctx(oai.node.id))).status).toBe(400);
    expect((await one.PUT(json("PUT", { name: "x", prefix: "y", apiType: "nope", baseUrl: "u" }), ctx(oai.node.id))).status).toBe(400);
    expect((await one.PUT(json("PUT", { name: "x", prefix: "y", apiType: "chat" }), ctx(oai.node.id))).status).toBe(400);
    const upd = await one.PUT(json("PUT", { name: "O2", prefix: "o2", apiType: "responses", baseUrl: "https://o2.example/v1" }), ctx(oai.node.id));
    expect(upd.status).toBe(200);
    expect((await db.getProviderConnectionById(conn.id)).providerSpecificData).toMatchObject({ prefix: "o2", baseUrl: "https://o2.example/v1", nodeName: "O2" });

    // Stream-usage opt-out: boolean only, stored on the node and its connections,
    // and inherited by connections added later.
    expect((await one.PUT(json("PUT", { name: "O2", prefix: "o2", apiType: "chat", baseUrl: "https://o2.example/v1", streamUsage: "no" }), ctx(oai.node.id))).status).toBe(400);
    const off = await (await one.PUT(json("PUT", { name: "O2", prefix: "o2", apiType: "chat", baseUrl: "https://o2.example/v1", streamUsage: false }), ctx(oai.node.id))).json();
    expect(off.node.streamUsage).toBe(false);
    expect((await db.getProviderConnectionById(conn.id)).providerSpecificData.streamUsage).toBe(false);
    const providers = await import("@/app/api/providers/route.js");
    const added = await (await providers.POST(json("POST", { provider: oai.node.id, apiKey: "k2", name: "c2" }))).json();
    expect(added.connection?.providerSpecificData?.streamUsage ?? (await db.getProviderConnectionById(added.connection.id)).providerSpecificData.streamUsage).toBe(false);

    const anthUpd = await (await one.PUT(json("PUT", { name: "A", prefix: "a", baseUrl: "https://y.example/messages" }), ctx(anth.node.id))).json();
    expect(anthUpd.node.baseUrl).toBe("https://y.example");

    expect((await one.DELETE(get(), ctx("missing"))).status).toBe(404);
    expect((await one.DELETE(get(), ctx(oai.node.id))).status).toBe(200);
    expect(await db.getProviderConnectionById(conn.id)).toBeNull();
  });
});

describe("/api/provider-nodes/validate (SSRF)", () => {
  const validate = () => import("@/app/api/provider-nodes/validate/route.js");

  it("rejects missing fields and malformed URLs", async () => {
    const { POST } = await validate();
    expect((await POST(json("POST", { baseUrl: "https://x.example" }))).status).toBe(400);
    expect((await POST(json("POST", { baseUrl: "not a url", apiKey: "k" }))).status).toBe(400);
  });

  it.each([
    "http://127.0.0.1:20128/v1",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.5/v1",
    "http://[::1]/v1",
    "http://localhost/v1",
  ])("refuses private target %s for a remote caller without fetching", async (baseUrl) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { POST } = await validate();
    const res = await POST(json("POST", { baseUrl, apiKey: "k" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("URL not allowed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  const withCookie = (cookie, body) =>
    new Request("http://localhost/api", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
  const session = async () => {
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession");
    return `auth_token=${await createDashboardAuthToken()}`;
  };

  it.each([
    "http://100.109.145.81:1234/v1",
    "http://192.168.1.20:1234/v1",
    "http://10.0.0.5/v1",
    "http://[fd7a:115c:a1e0::1]:1234/v1",
  ])("lets a signed-in session test LAN/Tailscale target %s", async (baseUrl) => {
    const fetchSpy = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchSpy);
    const { POST } = await validate();
    const res = await POST(withCookie(await session(), { baseUrl, apiKey: "k" }));
    expect(await res.json()).toEqual({ valid: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://127.0.0.1:20128/v1",
    "http://169.254.169.254/latest/meta-data",
    "http://100.100.100.200/latest/meta-data",
    "http://[::1]/v1",
    "http://localhost/v1",
    "http://[fd00:ec2::254]/latest/meta-data",
  ])("still refuses %s for a signed-in session", async (baseUrl) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { POST } = await validate();
    const res = await POST(withCookie(await session(), { baseUrl, apiKey: "k" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("URL not allowed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not take a forged or garbled session cookie for a signed-in one", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { POST } = await validate();
    for (const cookie of ["auth_token=eyJhbGciOiJIUzI1NiJ9.e30.forged", "auth_token=%E0%A4%A", "other=1"]) {
      const res = await POST(withCookie(cookie, { baseUrl: "http://192.168.1.20:1234/v1", apiKey: "k" }));
      expect(res.status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a LAN endpoint that redirects to cloud metadata, without following it", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const { POST } = await validate();
    const res = await POST(withCookie(await session(), { baseUrl: "http://192.168.1.20:1234/v1", apiKey: "k" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("URL not allowed");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("validates OpenAI, Anthropic and embedding nodes against a public URL", async () => {
    const { POST } = await validate();
    const fetchSpy = vi.fn(async (url) => {
      if (String(url).endsWith("/embeddings")) return Response.json({ data: [{ embedding: [0, 1, 2] }] });
      if (String(url).endsWith("/models")) return new Response("", { status: 404 });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchSpy);

    const oai = await (await POST(json("POST", { baseUrl: "https://8.8.8.8/v1/", apiKey: "k", modelId: "m" }))).json();
    expect(oai).toEqual({ valid: true, method: "chat" });
    const noModel = await (await POST(json("POST", { baseUrl: "https://8.8.8.8/v1", apiKey: "k" }))).json();
    expect(noModel.valid).toBe(false);

    const anth = await (await POST(json("POST", { baseUrl: "https://8.8.8.8/v1/messages", apiKey: "k", type: "anthropic-compatible", modelId: "m" }))).json();
    expect(anth).toEqual({ valid: true, method: "chat" });

    const emb = await (await POST(json("POST", { baseUrl: "https://8.8.8.8/v1", apiKey: "k", type: "custom-embedding", modelId: "e" }))).json();
    expect(emb).toEqual({ valid: true, method: "embeddings", dimensions: 3 });
    const embNoModel = await (await POST(json("POST", { baseUrl: "https://8.8.8.8/v1", apiKey: "k", type: "custom-embedding" }))).json();
    expect(embNoModel.valid).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    expect((await (await POST(json("POST", { baseUrl: "https://8.8.8.8/v1", apiKey: "k" }))).json()).error).toBe("API key unauthorized");

    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } }); }));
    const down = await POST(json("POST", { baseUrl: "https://8.8.8.8/v1", apiKey: "k" }));
    expect(down.status).toBe(500);
    expect((await down.json()).error).toMatch(/Connection refused/);
  });
});

describe("/api/proxy-pools", () => {
  it("validates input, lists with usage, refuses to delete an in-use pool", async () => {
    const r = await import("@/app/api/proxy-pools/route.js");
    const one = await import("@/app/api/proxy-pools/[id]/route.js");

    expect((await r.POST(json("POST", { proxyUrl: "http://p:1" }))).status).toBe(400);
    expect((await r.POST(json("POST", { name: "p" }))).status).toBe(400);
    const created = await (await r.POST(json("POST", { name: " pool ", proxyUrl: " http://p.example:3128 ", type: "evil" }))).json();
    expect(created.proxyPool).toMatchObject({ name: "pool", proxyUrl: "http://p.example:3128", type: "http", isActive: true });
    const id = created.proxyPool.id;

    await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "bound", apiKey: "k", providerSpecificData: { proxyPoolId: id } });

    const usage = await (await r.GET(get("http://localhost/api/proxy-pools?includeUsage=true&isActive=true"))).json();
    expect(usage.proxyPools.find((p) => p.id === id).boundConnectionCount).toBe(1);
    const inactive = await (await r.GET(get("http://localhost/api/proxy-pools?isActive=false"))).json();
    expect(inactive.proxyPools.map((p) => p.id)).not.toContain(id);

    expect((await one.GET(get(), ctx("missing"))).status).toBe(404);
    expect((await one.GET(get(), ctx(id))).status).toBe(200);
    expect((await one.PUT(json("PUT", { name: "x" }), ctx("missing"))).status).toBe(404);
    expect((await one.PUT(json("PUT", { name: "  " }), ctx(id))).status).toBe(400);
    expect((await one.PUT(json("PUT", { proxyUrl: "" }), ctx(id))).status).toBe(400);
    const upd = await (await one.PUT(json("PUT", { noProxy: " a.com ", isActive: false, strictProxy: true, type: "deno" }), ctx(id))).json();
    expect(upd.proxyPool).toMatchObject({ noProxy: "a.com", isActive: false, strictProxy: true, type: "deno" });

    const busy = await one.DELETE(get(), ctx(id));
    expect(busy.status).toBe(409);
    expect((await busy.json()).boundConnectionCount).toBe(1);

    const free = await (await r.POST(json("POST", { name: "free", proxyUrl: "http://f:1" }))).json();
    expect((await one.DELETE(get(), ctx(free.proxyPool.id))).status).toBe(200);
    expect((await one.DELETE(get(), ctx(free.proxyPool.id))).status).toBe(404);
  });
});
