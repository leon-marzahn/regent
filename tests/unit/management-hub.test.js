import { beforeEach, describe, it, expect, vi } from "vite-plus/test";
import { getProviderConnections, getProviderConnectionById } from "@/lib/db/index.js";
import { GET as usageGET } from "@/app/api/usage/[connectionId]/route.js";
import { GET, POST } from "@/app/v0/management/[endpoint]/route.js";

vi.mock("@/lib/db/index.js", () => ({ getProviderConnections: vi.fn(), getProviderConnectionById: vi.fn() }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({ GET: vi.fn() }));

const KEY = "test-mgmt-key";
const req = (method, endpoint, { key = KEY, body } = {}) => [
  new Request(`http://localhost/v0/management/${endpoint}`, {
    method,
    headers: key ? { authorization: `Bearer ${key}` } : {},
    ...(body && { body: JSON.stringify(body) }),
  }),
  { params: Promise.resolve({ endpoint }) },
];

describe("v0 management hub", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.REGENT_MANAGEMENT_KEY = KEY;
  });

  it("rejects a missing or wrong key", async () => {
    expect((await GET(...req("GET", "auth-files", { key: null }))).status).toBe(401);
    expect((await POST(...req("POST", "api-call", { key: "nope", body: {} }))).status).toBe(401);
    delete process.env.REGENT_MANAGEMENT_KEY;
    expect((await GET(...req("GET", "auth-files"))).status).toBe(401);
  });

  it("lists Kiro accounts as claude auth files", async () => {
    getProviderConnections.mockResolvedValue([
      { id: "k1", name: "a@b.c (google)", email: "a@b.c", isActive: true },
      { id: "k2", email: "a@b.c", isActive: false },
      { id: "k3", authType: "api_key", isActive: true },
      { id: "k4", authType: "oauth", isActive: true },
    ]);
    const res = await GET(...req("GET", "auth-files"));
    const file = (id, email, disabled) => ({ id, auth_index: id, provider: "claude", email, disabled });
    expect(await res.json()).toEqual({
      files: [
        file("k1", "a@b.c (google)", false),
        file("k2", "a@b.c", true),
        file("k3", "API Key", false),
        file("k4", "OAuth Account", false),
      ],
    });
    expect(getProviderConnections).toHaveBeenCalledWith({ provider: "kiro" });
  });

  it("answers api-call locally with a JSON-string body", async () => {
    getProviderConnectionById.mockResolvedValue({ id: "k1", provider: "kiro" });
    usageGET.mockResolvedValue(
      Response.json({
        quotas: {
          credit_freetrial: { used: 1, total: 50, resetAt: null },
          credit: { used: 42, total: 100, resetAt: "2026-12-01T00:00:00.000Z" },
        },
      }),
    );
    const res = await POST(...req("POST", "api-call", { body: { auth_index: "k1", method: "GET", url: "https://api.anthropic.com/api/oauth/usage" } }));
    const out = await res.json();
    expect(out.status_code).toBe(200);
    expect(typeof out.body).toBe("string");
    expect(JSON.parse(out.body)).toEqual({
      five_hour: null,
      seven_day: { utilization: 42, resets_at: "2026-12-01T00:00:00.000Z" },
    });
  });

  it("returns non-2xx status_code when usage can't be read", async () => {
    getProviderConnectionById.mockResolvedValue({ id: "k1", provider: "kiro" });
    usageGET.mockResolvedValue(Response.json({ message: "Kiro quota API rejected the current token.", quotas: {} }));
    const out = await (await POST(...req("POST", "api-call", { body: { auth_index: "k1" } }))).json();
    expect(out.status_code).toBe(502);
  });

  it("names the quota keys when no pool has a limit", async () => {
    getProviderConnectionById.mockResolvedValue({ id: "k1", provider: "kiro" });
    usageGET.mockResolvedValue(Response.json({ quotas: { credit: { used: 0, total: 0 } } }));
    const out = await (await POST(...req("POST", "api-call", { body: { auth_index: "k1" } }))).json();
    expect(out.status_code).toBe(502);
    expect(JSON.parse(out.body).error).toContain("quotas: credit");
  });
});
