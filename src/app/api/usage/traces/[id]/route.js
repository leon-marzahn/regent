import { NextResponse } from "next/server";
import { loadTrace } from "@/lib/requestTrace.js";
import { calculateCost } from "@/lib/db/repos/usageRepo.js";
import { providerName } from "@/lib/providerName.js";

const ID_RE = /^tr_[a-z0-9]{6,40}$/;

/**
 * GET /api/usage/traces/:id — how one /v1 request was routed: combo expansion
 * and every upstream attempt. Metadata only (no bodies, headers or credentials);
 * dashboard access is enforced by dashboardGuard (/api/usage is protected).
 */
export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    if (!id || !ID_RE.test(id)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }
    const trace = await loadTrace(id);
    if (!trace) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const names = new Map();
    const attempts = await Promise.all(
      (trace.attempts || []).map(async (a) => ({ ...a, providerName: await providerName(a.provider, names) })),
    );

    const billed = [...attempts].reverse().find((a) => a.tokens);
    let cost = 0;
    if (billed) {
      const t = billed.tokens;
      cost = await calculateCost(billed.provider, billed.model, {
        prompt_tokens: t.in || 0,
        completion_tokens: t.out || 0,
        cached_tokens: t.cached,
        cache_creation_input_tokens: t.cacheWrite,
        reasoning_tokens: t.reasoning,
        credits: t.credits,
      }).catch(() => 0);
    }
    return NextResponse.json({ ...trace, attempts, cost }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[API] Failed to get request trace:", error?.message);
    return NextResponse.json({ error: "Failed to fetch request trace" }, { status: 500 });
  }
}
