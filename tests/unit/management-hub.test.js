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
    getProviderConnections.mockResolvedValue([{ id: "k1", email: "a@b.c", isActive: true }]);
    const res = await GET(...req("GET", "auth-files"));
    expect(await res.json()).toEqual({
      files: [{ id: "k1", auth_index: "k1", provider: "claude", email: "a@b.c", disabled: false }],
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
});
