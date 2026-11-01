// CLIProxyAPI-compatible "hub" usage endpoints, so T3 Code's Usage page can show Kiro credits.
// Only the two calls T3 makes: GET auth-files and POST api-call (answered locally, never forwarded).
import { getProviderConnections, getProviderConnectionById } from "@/lib/db/index.js";
import { cliTokenMatches } from "@/lib/auth/cliToken";
import { GET as getConnectionUsage } from "@/app/api/usage/[connectionId]/route.js";

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

export async function GET(request, { params }) {
  if (!authorized(request)) return unauthorized();
  if ((await params).endpoint !== "auth-files")
    return Response.json({ error: "Not found" }, { status: 404 });
  const conns = await getProviderConnections({ provider: "kiro" });
  // T3 only accepts claude/codex, so Kiro accounts are listed as "claude".
  const files = conns.map((c) => ({
    id: c.id,
    auth_index: c.id,
    provider: "claude",
    ...(c.email ? { email: c.email } : {}),
    disabled: c.isActive === false,
  }));
  return Response.json({ files });
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
  if (conn?.provider !== "kiro") return hubError("Unknown account");

  // Same path as the dashboard: token refresh, connection proxy, auth-expired retry.
  const res = await getConnectionUsage(request, { params: Promise.resolve({ connectionId: id }) });
  const usage = await res.json().catch(() => null);
  const q = usage?.quotas?.agentic_request;
  if (!res.ok || !q?.total)
    return hubError(usage?.error || usage?.message || "Kiro usage unavailable");

  // ponytail: monthly credit pool shown as the 7-day bar; free-trial pool not reported. Add as a `limits` entry if needed.
  return Response.json({
    status_code: 200,
    body: JSON.stringify({
      five_hour: null,
      seven_day: {
        utilization: Math.min(100, (q.used / q.total) * 100),
        resets_at: q.resetAt ?? null,
      },
    }),
  });
}
