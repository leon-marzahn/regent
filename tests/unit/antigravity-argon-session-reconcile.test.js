// getAntigravityUsage: the Gemini 4 Argon 5h session row is reconciled to 0%
// (with the latest model reset time) when every Argon model is exhausted, and
// left alone while any Argon model still has quota.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { _clearWeeklyCache } from "../../open-sse/services/usage/antigravity-weekly.js";
import { getAntigravityUsage } from "../../open-sse/services/usage/google.js";

const json = (body) => ({ ok: true, status: 200, json: async () => body });

function mockUpstream(models) {
  proxyAwareFetch.mockImplementation(async (url) => {
    if (url.includes(":loadCodeAssist")) {
      return json({ cloudaicompanionProject: "p1", currentTier: { name: "Pro" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } });
    }
    if (url.includes(":fetchAvailableModels")) return json({ models });
    if (url.includes(":retrieveUserQuotaSummary")) {
      return json({
        groups: [{
          displayName: "Gemini 4 Argon",
          buckets: [
            { bucketId: "argon-weekly", displayName: "Weekly Limit", window: "weekly", remainingFraction: 0.6, resetTime: "2026-09-20T00:00:00Z" },
            { bucketId: "argon-5h", displayName: "Five Hour Limit", window: "5h", remainingFraction: 1, resetTime: "2026-09-13T11:00:00Z" },
          ],
        }],
      });
    }
    return json({});
  });
}

describe("getAntigravityUsage — Argon 5h session reconciliation", () => {
  beforeEach(() => {
    proxyAwareFetch.mockReset();
    _clearWeeklyCache();
  });

  it("zeroes the Argon session row and takes the latest reset when all Argon models are exhausted", async () => {
    mockUpstream({
      "gemini-4-argon-high": { displayName: "Argon High", quotaInfo: { resetTime: "2026-09-13T12:00:00Z" } },
      "gemini-4-argon-low": { displayName: "Argon Low", quotaInfo: { resetTime: "2026-09-13T14:30:00Z" } },
    });
    const result = await getAntigravityUsage("token-argon-exhausted", null);

    expect(result.quotas["gemini-4-argon-high"].remainingPercentage).toBe(0);
    expect(result.quotas.gemini_argon_session).toMatchObject({
      used: 1000,
      total: 1000,
      remainingPercentage: 0,
      resetAt: "2026-09-13T14:30:00.000Z",
    });
    // Weekly row is untouched.
    expect(result.quotas.gemini_argon_weekly).toMatchObject({ remainingPercentage: 60, resetAt: "2026-09-20T00:00:00.000Z" });
  });

  it("keeps the Argon session row when one Argon model still has quota", async () => {
    mockUpstream({
      "gemini-4-argon-high": { displayName: "Argon High", quotaInfo: { resetTime: "2026-09-13T12:00:00Z" } },
      "gemini-4-argon-low": { displayName: "Argon Low", quotaInfo: { remainingFraction: 0.5, resetTime: "2026-09-13T14:30:00Z" } },
    });
    const result = await getAntigravityUsage("token-argon-partial", null);

    expect(result.quotas.gemini_argon_session).toMatchObject({ remainingPercentage: 100, resetAt: "2026-09-13T11:00:00.000Z" });
  });
});
