// Spend budgets (src/lib/budgets): enforcement (under / over, hard vs soft stop,
// period rollover, global vs per-key), cached counters, alert de-dup across calls,
// fail-open, the 429 shape, and the dashboard routes (no key strings, validation).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { usageKeyRef } from "@/lib/db/helpers/usageKeyRef.js";

// Periods are UTC: run in a zone far from it so a local-time slip shows up.
const sent = vi.hoisted(() => {
  process.env.TZ = "Pacific/Honolulu"; // UTC-10, no DST
  return [];
});
vi.mock("@/lib/notify/index.js", () => ({
  notify: vi.fn(async (msg) => {
    sent.push(msg);
    return { ok: true };
  }),
}));

let tempDir;
const originalDataDir = process.env.DATA_DIR;
let db;
let budgets;
let repo;
let adapter;
let keyA;
let keyB;

const NOW = new Date(Date.UTC(2026, 9, 19, 12, 0, 0)); // Oct 19 UTC
const LAST_MONTH = new Date(Date.UTC(2026, 8, 28, 12, 0, 0)).toISOString();

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "regent-budgets-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._regentBudgetState;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  repo = await import("@/lib/db/repos/budgetsRepo.js");
  budgets = await import("@/lib/budgets/index.js");
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  keyA = await db.createApiKey("acme", "machine-fixture");
  keyB = await db.createApiKey("globex", "machine-fixture");
  await db.updateSettings({ notifyAdminEmail: "admin@example.com" });
});

afterAll(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  delete global._regentBudgetState;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  adapter.run("DELETE FROM usageHistory");
  adapter.run("DELETE FROM budgets");
  adapter.run("DELETE FROM budgetAlerts");
  budgets.invalidateBudgetCache({ counters: true });
  sent.length = 0;
});

function usage(apiKey, cost, { at = NOW.toISOString(), tokens = 100 } = {}) {
  adapter.run(
    "INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status) VALUES(?, 'p', 'm', ?, ?, 0, ?, 'ok')",
    [at, usageKeyRef(adapter, apiKey), tokens, cost],
  );
}

async function setBudget(scope, input) {
  const { value, error } = budgets.validateBudget(input, { isKey: scope !== "global" });
  if (error) throw new Error(error);
  await repo.setBudget(scope, value);
  budgets.invalidateBudgetCache({ counters: true });
}

describe("validateBudget", () => {
  it("accepts a sane budget and rejects nonsense", () => {
    expect(budgets.validateBudget({ spendLimit: 10, warnAt: [80, 50] }).value).toMatchObject({
      period: "month",
      spendLimit: 10,
      warnAt: [50, 80],
      hardStop: false,
    });
    expect(budgets.validateBudget({}).error).toMatch(/at least one/);
    expect(budgets.validateBudget({ spendLimit: -1 }).error).toBeTruthy();
    expect(budgets.validateBudget({ tokenLimit: 1.5 }).error).toBeTruthy();
    expect(budgets.validateBudget({ spendLimit: 1, period: "week" }).error).toBeTruthy();
    expect(budgets.validateBudget({ spendLimit: 1, warnAt: [150] }).error).toBeTruthy();
    expect(budgets.validateBudget({ spendLimit: 1, contactEmail: "x\r\n@y.z" }).error).toBeTruthy();
    expect(
      budgets.validateBudget({ spendLimit: 1, contactEmail: "c@x.io" }, { isKey: false }).error,
    ).toBeTruthy();
  });
});

describe("enforcement", () => {
  it("lets a key under its limit through and stops it once over (hard stop)", async () => {
    await setBudget(repo.keyScope(keyA.id), { spendLimit: 10, hardStop: true });
    usage(keyA.key, 9.99);
    expect(await budgets.checkBudget(keyA.key, { now: NOW })).toBeNull();
    usage(keyA.key, 0.01);
    budgets.invalidateBudgetCache({ counters: true });
    expect(await budgets.checkBudget(keyA.key, { now: NOW })).toMatchObject({ global: false });
  });

  it("never blocks a soft (alert-only) budget", async () => {
    await setBudget(repo.keyScope(keyA.id), { spendLimit: 1, hardStop: false });
    usage(keyA.key, 5);
    expect(await budgets.checkBudget(keyA.key, { now: NOW })).toBeNull();
  });

  it("only counts the current period (rollover)", async () => {
    await setBudget(repo.keyScope(keyA.id), { spendLimit: 1, hardStop: true });
    usage(keyA.key, 50, { at: LAST_MONTH });
    expect(await budgets.checkBudget(keyA.key, { now: NOW })).toBeNull();
    await setBudget(repo.keyScope(keyA.id), { spendLimit: 1, hardStop: true, period: "day" });
    usage(keyA.key, 5, { at: "2026-10-18T23:00:00.000Z" });
    expect(await budgets.checkBudget(keyA.key, { now: NOW })).toBeNull();
    const next = await budgets.checkBudget(keyA.key, { now: new Date("2026-10-18T23:30:00.000Z") });
    expect(next).toMatchObject({ resetsAt: "2026-10-19T00:00:00.000Z" });
  });

  it("enforces token and request limits too", async () => {
    await setBudget(repo.keyScope(keyA.id), { tokenLimit: 150, hardStop: true });
    usage(keyA.key, 0, { tokens: 100 });
    expect(await budgets.checkBudget(keyA.key, { now: NOW })).toBeNull();
    usage(keyA.key, 0, { tokens: 100 });
    budgets.invalidateBudgetCache({ counters: true });
    expect(await budgets.checkBudget(keyA.key, { now: NOW })).not.toBeNull();
    await setBudget(repo.keyScope(keyB.id), { requestLimit: 1, hardStop: true });
    usage(keyB.key, 0);
    expect(await budgets.checkBudget(keyB.key, { now: NOW })).not.toBeNull();
  });

  it("a per-key budget doesn't affect other keys; the global one affects everyone", async () => {
    await setBudget(repo.keyScope(keyA.id), { spendLimit: 1, hardStop: true });
    usage(keyA.key, 2);
    expect(await budgets.checkBudget(keyB.key, { now: NOW })).toBeNull();
    expect(await budgets.checkBudget(null, { now: NOW })).toBeNull();

    await setBudget("global", { spendLimit: 3, hardStop: true });
    usage(keyB.key, 1.5);
    expect(await budgets.checkBudget(keyB.key, { now: NOW })).toMatchObject({ global: true });
    expect(await budgets.checkBudget(null, { now: NOW })).toMatchObject({ global: true });
  });

  it("uses cached counters bumped by recordUsage, without re-reading the table", async () => {
    await setBudget(repo.keyScope(keyA.id), { spendLimit: 1, hardStop: true });
    expect(await budgets.checkBudget(keyA.key, { now: NOW })).toBeNull(); // seeds the counter
    await budgets.recordUsage(
      { apiKey: keyA.key, cost: 1.2, tokens: { prompt_tokens: 10 } },
      { now: NOW },
    );
    // No row was inserted: only the in-memory counter knows about the spend.
    expect(await budgets.checkBudget(keyA.key, { now: NOW })).not.toBeNull();
  });

  it("fails closed for a hard-stopped budget when the check breaks", async () => {
    await setBudget(repo.keyScope(keyA.id), { spendLimit: 100, hardStop: true });
    expect(await budgets.checkBudget(keyA.key, { now: NOW })).toBeNull(); // caches config + key id
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    budgets.invalidateBudgetCache({ counters: true });
    adapter.exec("ALTER TABLE usageHistory RENAME TO usageHistory_off");
    try {
      expect(await budgets.checkBudget(keyA.key, { now: NOW })).toMatchObject({ global: false });
    } finally {
      adapter.exec("ALTER TABLE usageHistory_off RENAME TO usageHistory");
    }
    // Config itself unreadable: the last loaded config decides.
    global._regentBudgetState.config = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("db exploded");
        },
      },
    );
    global._regentBudgetState.configAt = Date.now();
    expect(await budgets.checkBudget(keyA.key, { now: NOW })).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/refusing/));
    warn.mockRestore();
  });

  it("fails open when the check breaks and no hard stop applies", async () => {
    await setBudget(repo.keyScope(keyA.id), { spendLimit: 1, hardStop: false });
    await setBudget(repo.keyScope(keyB.id), { spendLimit: 1, hardStop: true });
    expect(await budgets.checkBudget(keyA.key, { now: NOW })).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    budgets.invalidateBudgetCache({ counters: true });
    adapter.exec("ALTER TABLE usageHistory RENAME TO usageHistory_off");
    try {
      expect(await budgets.checkBudget(keyA.key, { now: NOW })).toBeNull();
    } finally {
      adapter.exec("ALTER TABLE usageHistory_off RENAME TO usageHistory");
    }
    // Nothing ever loaded: nothing is known to be hard-stopped.
    global._regentBudgetState.lastGood = null;
    global._regentBudgetState.config = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("db exploded");
        },
      },
    );
    global._regentBudgetState.configAt = Date.now();
    expect(await budgets.checkBudget(keyB.key, { now: NOW })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/letting the request through/));
    warn.mockRestore();
  });
});

describe("UTC periods", () => {
  it("day and month follow UTC, not the server zone", () => {
    expect(new Date().getTimezoneOffset()).toBe(600); // really running in UTC-10
    const late = new Date("2026-10-31T23:30:00.000Z"); // still Oct 31 13:30 in Honolulu
    expect(budgets.periodBounds("day", new Date("2026-10-19T03:00:00.000Z"))).toMatchObject({
      key: "d:2026-10-19",
    });
    const m = budgets.periodBounds("month", late);
    expect(m.key).toBe("m:2026-10");
    expect(m.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(budgets.periodBounds("month", new Date("2026-11-01T00:00:00.000Z")).key).toBe(
      "m:2026-11",
    );
  });

  it("rolls over at UTC midnight", async () => {
    await setBudget(repo.keyScope(keyA.id), { spendLimit: 1, hardStop: true, period: "day" });
    usage(keyA.key, 2, { at: "2026-10-19T23:59:00.000Z" });
    expect(
      await budgets.checkBudget(keyA.key, { now: new Date("2026-10-19T23:59:30.000Z") }),
    ).not.toBeNull();
    expect(
      await budgets.checkBudget(keyA.key, { now: new Date("2026-10-20T00:00:01.000Z") }),
    ).toBeNull();
  });
});

describe("unpriced models", () => {
  it("lists models used this period with no price, only when a spend limit is set", async () => {
    adapter.run(
      "INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status) VALUES(?, 'nobody', 'mystery-model', ?, 500, 0, 0, 'ok')",
      [NOW.toISOString(), usageKeyRef(adapter, keyA.key)],
    );
    usage(keyA.key, 0.5); // provider 'p' model 'm' with a cost: priced
    const spend = budgets.validateBudget({ spendLimit: 5 }).value;
    const st = await budgets.budgetStatus(repo.keyScope(keyA.id), spend, { now: NOW });
    expect(st.unpricedModels).toEqual(["nobody/mystery-model"]);
    const tokensOnly = budgets.validateBudget({ tokenLimit: 5000 }).value;
    budgets.invalidateBudgetCache({ counters: true });
    const st2 = await budgets.budgetStatus(repo.keyScope(keyA.id), tokensOnly, {
      now: NOW,
    });
    expect(st2.unpricedModels).toEqual([]);
    const other = await budgets.budgetStatus(repo.keyScope(keyB.id), spend, { now: NOW });
    expect(other.unpricedModels).toEqual([]);
  });

  it("names a custom provider by its prefix (or name), not its internal node id", async () => {
    const { createProviderNode } = await import("@/lib/db/repos/nodesRepo.js");
    const withPrefix = "openai-compatible-chat-11111111-1111-4111-8111-111111111111";
    const nameOnly = "openai-compatible-chat-22222222-2222-4222-8222-222222222222";
    await createProviderNode({
      id: withPrefix,
      type: "openai-compatible",
      name: "My Proxy",
      prefix: "mine",
      apiType: "chat",
      baseUrl: "https://example.test/v1",
    });
    await createProviderNode({
      id: nameOnly,
      type: "openai-compatible",
      name: "Unprefixed",
      apiType: "chat",
      baseUrl: "https://example.test/v1",
    });
    for (const provider of [withPrefix, nameOnly]) {
      adapter.run(
        "INSERT INTO usageHistory(timestamp, provider, model, apiKey, promptTokens, completionTokens, cost, status) VALUES(?, ?, 'local-model', ?, 500, 0, 0, 'ok')",
        [NOW.toISOString(), provider, usageKeyRef(adapter, keyA.key)],
      );
    }
    const spend = budgets.validateBudget({ spendLimit: 5 }).value;
    const st = await budgets.budgetStatus(repo.keyScope(keyA.id), spend, { now: NOW });
    expect(st.unpricedModels.toSorted()).toEqual(
      ["Unprefixed/local-model", "mine/local-model"].toSorted(),
    );
  });
});

describe("429 response", () => {
  it("is OpenAI-shaped with code budget_exceeded and no internal details", async () => {
    const { enforceBudget } = await import("@/sse/services/budget.js");
    await setBudget(repo.keyScope(keyA.id), { spendLimit: 1, hardStop: true });
    // enforceBudget reads the real clock, so the spend must be in the current period, not NOW's.
    usage(keyA.key, 2, { at: new Date().toISOString() });
    const res = await enforceBudget(
      new Request("http://x/v1/chat/completions", {
        headers: { Authorization: `Bearer ${keyA.key}` },
      }),
    );
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    const text = await res.text();
    expect(JSON.parse(text).error).toMatchObject({
      code: "budget_exceeded",
      type: "insufficient_quota",
    });
    for (const leak of [keyA.id, keyA.key, "acme", "$"]) expect(text).not.toContain(leak);
    const other = await enforceBudget(
      new Request("http://x/v1/chat/completions", {
        headers: { Authorization: `Bearer ${keyB.key}` },
      }),
    );
    expect(other).toBeNull();
  });
});

describe("alerts", () => {
  it("sends once per threshold per period, to the admin and the key's contact separately", async () => {
    await setBudget(repo.keyScope(keyA.id), {
      spendLimit: 10,
      warnAt: [50, 80],
      hardStop: true,
      contactEmail: "billing@customer.example",
    });
    usage(keyA.key, 8.5);
    await budgets.recordUsage({ apiKey: keyA.key, cost: 0 }, { now: NOW });
    // 50 and 80 crossed at once: one email (the higher one) per recipient.
    expect(sent.map((m) => m.to).sort()).toEqual(["admin@example.com", "billing@customer.example"]);
    expect(sent[0].subject).toContain("80%");
    expect(sent[0].text).not.toContain("admin@example.com");

    sent.length = 0;
    await budgets.recordUsage({ apiKey: keyA.key, cost: 0.5 }, { now: NOW });
    budgets.invalidateBudgetCache({ counters: true }); // a restart: the ledger still remembers
    await budgets.recordUsage({ apiKey: keyA.key, cost: 0 }, { now: NOW });
    expect(sent).toHaveLength(0);

    await budgets.recordUsage({ apiKey: keyA.key, cost: 2 }, { now: NOW });
    expect(sent).toHaveLength(2);
    expect(sent[0].subject).toMatch(/budget reached/);
    expect(sent[0].text).toMatch(/refused/);

    // Next month starts over.
    sent.length = 0;
    const nov = new Date(Date.UTC(2026, 10, 2));
    usage(keyA.key, 9, { at: nov.toISOString() });
    await budgets.recordUsage({ apiKey: keyA.key, cost: 9 }, { now: nov });
    expect(sent.length).toBe(2);
  });

  it("the global budget only mails the admin", async () => {
    await setBudget("global", { spendLimit: 1, warnAt: [80] });
    usage(keyB.key, 2);
    await budgets.recordUsage({ apiKey: keyB.key, cost: 0 }, { now: NOW });
    expect(sent.map((m) => m.to)).toEqual(["admin@example.com"]);
    expect(sent[0].subject).toContain("All API keys");
  });
});

describe("dashboard routes", () => {
  const req = (method, body) =>
    new Request("http://localhost/api/budgets", {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ctx = (scope) => ({ params: Promise.resolve({ scope }) });

  it("PUT validates and 404s unknown keys; GET never returns key strings", async () => {
    const one = await import("@/app/api/budgets/[scope]/route.js");
    const all = await import("@/app/api/budgets/route.js");
    expect((await one.PUT(req("PUT", { spendLimit: -5 }), ctx(keyA.id))).status).toBe(400);
    expect((await one.PUT(req("PUT", { spendLimit: 5 }), ctx("nope"))).status).toBe(404);
    const ok = await one.PUT(req("PUT", { spendLimit: 5, hardStop: true }), ctx(keyA.id));
    expect(ok.status).toBe(200);
    expect((await one.PUT(req("PUT", { spendLimit: 50 }), ctx("global"))).status).toBe(200);

    const text = await (await all.GET()).text();
    expect(text).not.toContain(keyA.key);
    const body = JSON.parse(text);
    expect(body.keys[keyA.id].budget.spendLimit).toBe(5);
    expect(body.global.budget.spendLimit).toBe(50);

    expect((await one.DELETE(req("DELETE"), ctx(keyA.id))).status).toBe(200);
    expect(JSON.parse(await (await all.GET()).text()).keys[keyA.id]).toBeUndefined();
  });

  it("deleting a key deletes its budget, and budgets survive a backup round trip", async () => {
    await setBudget(repo.keyScope(keyB.id), { spendLimit: 7 });
    await setBudget("global", { requestLimit: 100 });
    const dump = await db.exportDb();
    expect(dump.budgets).toHaveLength(2);
    await db.importDb(dump);
    expect(Object.keys(await repo.getBudgets()).sort()).toEqual(
      ["global", repo.keyScope(keyB.id)].sort(),
    );

    await db.deleteApiKey(keyB.id);
    expect((await repo.getBudgets())[repo.keyScope(keyB.id)]).toBeUndefined();
  });
});
