// CLIProxyAPI-compatible "hub" usage endpoints, so T3 Code's Usage page can show Kiro credits
// and Claude Code limits. Only the two calls T3 makes: GET auth-files and POST api-call
// (answered locally, never forwarded).
import { getProviderConnections, getProviderConnectionById } from "@/lib/db/index.js";
import { cliTokenMatches } from "@/lib/auth/cliToken";
import { GET as getConnectionUsage } from "@/app/api/usage/[connectionId]/route.js";

// Providers listed to T3, with the prefix that tells them apart there: T3 only accepts
// claude/codex auth files and shows nothing but `email`, so both appear as "claude".
const HUB_PROVIDERS = { kiro: "Kiro", claude: "Claude" };

// Separate from regent API keys. Unset = hub disabled (every request 401s).
function authorized(request) {
  const auth = request.headers.get("authorization") || "";
  return cliTokenMatches(
    auth.startsWith("Bearer ") ? auth.slice(7) : "",
    process.env.REGENT_MANAGEMENT_KEY,
  );
}

const unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });
const hubError = (message) =>
  Response.json({ status_code: 502, body: JSON.stringify({ error: message }) });
const hubOk = (body) => Response.json({ status_code: 200, body: JSON.stringify(body) });

// The label the dashboard's connection row shows (providers/[id]/ConnectionRow.js).
// displayName is set by some sign-in flows, not users.
const connectionLabel = (c) =>
  c.name?.trim() ||
  c.email?.trim() ||
  c.displayName?.trim() ||
  (c.authType === "oauth" ? "OAuth Account" : "API Key");

export async function GET(request, { params }) {
  if (!authorized(request)) return unauthorized();
  if ((await params).endpoint !== "auth-files")
    return Response.json({ error: "Not found" }, { status: 404 });
  const files = [];
  for (const [provider, prefix] of Object.entries(HUB_PROVIDERS)) {
    for (const c of await getProviderConnections({ provider })) {
      files.push({
        id: c.id,
        auth_index: c.id,
        provider: "claude",
        email: `${prefix} · ${connectionLabel(c)}`,
        disabled: c.isActive === false,
      });
    }
  }
  return Response.json({ files });
}

// Kiro's resourceType names the pool (e.g. "credit"), so take the first paid pool with a limit.
// ponytail: monthly credit pool shown as the 7-day bar; free-trial pool not reported.
function kiroUsageBody(usage) {
  const quotas = usage?.quotas || {};
  const q = Object.entries(quotas).find(([k, v]) => !k.endsWith("_freetrial") && v?.total > 0)?.[1];
  if (!q) {
    return {
      error:
        usage?.error ||
        usage?.message ||
        `Kiro usage unavailable (quotas: ${Object.keys(quotas).join(", ") || "none"})`,
    };
  }
  return {
    five_hour: null,
    seven_day: {
      utilization: Math.min(100, (q.used / q.total) * 100),
      resets_at: q.resetAt ?? null,
    },
  };
}

// Back to Anthropic's own /api/oauth/usage shape, which T3 reads: services/usage/claude.js
// names the windows "session (5h)", "weekly (7d)" and "weekly <model> (7d)", used = % used.
function claudeUsageBody(usage) {
  const quotas = usage?.quotas || {};
  const window = (q) => ({ utilization: q.used, resets_at: q.resetAt ?? null });
  const body = {
    five_hour: quotas["session (5h)"] ? window(quotas["session (5h)"]) : null,
    seven_day: quotas["weekly (7d)"] ? window(quotas["weekly (7d)"]) : null,
  };
  for (const [key, q] of Object.entries(quotas)) {
    const model = /^weekly (.+) \(7d\)$/.exec(key)?.[1];
    if (model) body[`seven_day_${model.replace(/\s+/g, "_")}`] = window(q);
  }
  if (!body.five_hour && !body.seven_day) {
    return { error: usage?.error || usage?.message || "Claude usage unavailable" };
  }
  return body;
}

export async function POST(request, { params }) {
  if (!authorized(request)) return unauthorized();
  if ((await params).endpoint !== "api-call")
    return Response.json({ error: "Not found" }, { status: 404 });
  const body = await request.json().catch(() => null);
  const id = body?.auth_index;
  if (typeof id !== "string" || !id)
    return Response.json({ error: "auth_index required" }, { status: 400 });

  const conn = await getProviderConnectionById(id);
  if (!HUB_PROVIDERS[conn?.provider]) return hubError("Unknown account");

  // Same path as the dashboard: token refresh, connection proxy, auth-expired retry.
  // Fresh request: T3's query string (e.g. ?force=1) must not reach the usage cache.
  const res = await getConnectionUsage(new Request("http://localhost/"), {
    params: Promise.resolve({ connectionId: id }),
  });
  const usage = await res.json().catch(() => null);
  const out = conn.provider === "kiro" ? kiroUsageBody(usage) : claudeUsageBody(usage);
  if (!res.ok && !out.error) out.error = usage?.error || `Usage request failed (${res.status})`;
  return out.error ? hubError(out.error) : hubOk(out);
}
