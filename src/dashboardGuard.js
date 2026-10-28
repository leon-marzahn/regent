import net from "node:net";
import { NextResponse } from "next/server";
import { getSettings, validateApiKey } from "@/lib/localDb";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { hasTrustedPeerHeaders } from "@/lib/auth/trustedPeer";
import { hasValidCliToken } from "@/lib/auth/cliToken";

// Public API paths — no auth required (LLM API has its own key auth inside handler).
const PUBLIC_API_PATHS = [
  "/api/health",
  "/api/init",
  "/api/locale",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/auth/oidc",
  "/api/auth/saml",
  "/api/settings/require-login",
];

// Public exact paths only (no sub-paths). Customer view: authenticated by the caller's
// own API key inside the handler (constant-time lookup, per-IP failure limiter, off by default).
const PUBLIC_API_EXACT = ["/api/customer/usage"];

// Public top-level prefixes (LLM API endpoints with their own API key auth).
// Keep root-level rewrites here too: middleware runs before Next.js rewrites.
const PUBLIC_PREFIXES = ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex", "/responses"];

// Always require JWT token regardless of requireLogin setting
const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
  "/api/version/shutdown",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/oauth/zed/auto-import",
  "/api/oauth/xiaomi-mimo/auto-import",
  "/api/oauth/minimax-code/lease",
  "/api/oauth/minimax-code-global/lease",
];

// Routes that spawn child processes or read host secrets — restrict to localhost.
// All of /api/cli-tools/ is local-only, GETs included: the handlers write config files
// in the user's home, exec `which`, and the status GETs read those files back (they can
// contain API keys). all-statuses calls the same GET handlers in-process.
const LOCAL_ONLY_PATHS = [
  "/api/cli-tools/",
  "/api/mcp/",
  "/api/tunnel/tailscale-install",
  "/api/tunnel/tailscale-enable",
  "/api/tunnel/tailscale-disable",
  "/api/tunnel/tailscale-check",
  "/api/tunnel/enable",
  "/api/tunnel/disable",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/oauth/zed/auto-import",
  "/api/oauth/xiaomi-mimo/auto-import",
  "/api/oauth/minimax-code/lease",
  "/api/oauth/minimax-code-global/lease",
  "/api/auth/reset-password",
  "/api/headroom/start",
  "/api/headroom/stop",
  "/api/headroom/proxy",
  // pip install/uninstall and process restart, same as start/stop.
  "/api/headroom/extras",
  "/api/headroom/restart",
];

// Every /api/oauth/<provider>/auto-import reads IDE or desktop credentials from this
// host's files and returns them, so one added later is local-only and always
// protected even if nobody lists it above.
const AUTO_IMPORT_RE = /^\/api\/oauth\/[^/]+\/auto-import(\/|$)/;
const isLocalOnlyPath = (p) => LOCAL_ONLY_PATHS.some((x) => p.startsWith(x)) || AUTO_IMPORT_RE.test(p);
const isAlwaysProtectedPath = (p) => ALWAYS_PROTECTED.some((x) => p.startsWith(x)) || AUTO_IMPORT_RE.test(p);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Accepts a Host header, a URL hostname or a raw socket address. Splitting on the first
// colon only works for IPv4 and would reduce every IPv6 form to "", so a dual-stack
// listener handing back ::ffff:127.0.0.1 would not read as loopback.
function isLoopbackHostname(h) {
  if (!h) return false;
  let name = String(h).trim().toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    if (end === -1) return false;
    name = name.slice(1, end);
  } else if (name.indexOf(":") !== -1 && name.indexOf(":") === name.lastIndexOf(":")) {
    name = name.slice(0, name.indexOf(":"));
  }
  if (name.startsWith("::ffff:")) name = name.slice(7);
  return LOOPBACK_HOSTS.has(name);
}

function isLoopbackPeer(request) {
  if (hasTrustedPeerHeaders(request)) {
    return isLoopbackHostname(request.headers.get("x-9r-real-ip"));
  }
  // Bare `next dev` forks its server, so the wrapper never loads and no peer address
  // reaches us. Host is spoofable, so this stays confined to development.
  if (process.env.NODE_ENV === "development") {
    return isLoopbackHostname(request.headers.get("host"));
  }
  return false;
}

export function isLocalRequest(request) {
  // Stamped by custom-server.js when forwarding headers exist: request came through
  // a reverse proxy, so the loopback socket is the proxy hop, not the end-user.
  if (request.headers.get("x-9r-via-proxy")) return false;
  if (!isLoopbackPeer(request)) return false;
  // A loopback Host too: a reverse proxy on this machine forwarding an ALLOWED_HOSTS or
  // base-URL name is remote traffic even if it adds no forwarding headers.
  const host = request.headers.get("host");
  if (host && !isLoopbackHostname(host)) return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return false;
    } catch { return false; }
  }
  return true;
}

// Host allow-list (DNS rebinding). A page on evil.com that re-resolves to 127.0.0.1 is
// same-origin with us in the browser, so a same-origin GET carries no Origin header and
// the peer socket is loopback. The Host header is the one thing it cannot fake: the
// browser always sends the name from the page URL. Allowed: loopback names, any IP
// literal (no DNS lookup, so it cannot be rebound; keeps Docker-by-host-IP working),
// the BASE_URL / NEXT_PUBLIC_BASE_URL host, the active tunnel / Tailscale hosts, and
// ALLOWED_HOSTS (comma-separated, for reverse proxies and LAN hostnames).
function hostnameOf(value) {
  if (!value) return "";
  try {
    const raw = String(value).trim();
    return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function urlHostname(url) {
  try {
    return url ? new URL(url).hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

function isIpLiteralHost(name) {
  const bare = name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
  return net.isIP(bare) !== 0;
}

function allowedHostnames(settings) {
  const names = new Set();
  for (const u of [process.env.NEXT_PUBLIC_BASE_URL, process.env.BASE_URL]) {
    const h = urlHostname(u);
    if (h) names.add(h);
  }
  for (const entry of String(process.env.ALLOWED_HOSTS || "").split(",")) {
    const h = hostnameOf(entry);
    if (h) names.add(h);
  }
  for (const u of [settings?.tunnelUrl, settings?.tailscaleUrl]) {
    const h = urlHostname(u);
    if (h) names.add(h);
  }
  return names;
}

// Characters that make URL parsing reinterpret a Host (userinfo, path, fragment).
const MALFORMED_HOST_RE = /[@/\\#\s]/;

function isAllowedHost(request, settings) {
  const host = request.headers.get("host");
  // HTTP/1.0 clients may omit Host; a browser (the only rebinding vector) never does.
  if (!host) return true;
  if (MALFORMED_HOST_RE.test(host)) return false;
  const name = hostnameOf(host);
  if (!name) return false;
  if (isLoopbackHostname(name) || isIpLiteralHost(name)) return true;
  return allowedHostnames(settings).has(name);
}

function misdirected(request) {
  const raw = request.headers.get("host") || "";
  const name = MALFORMED_HOST_RE.test(raw) ? "" : hostnameOf(raw);
  const shown = name ? `"${name}"` : "This Host";
  return NextResponse.json({
    error: `${shown} is not in ALLOWED_HOSTS. To use the dashboard and /api under this name, set ALLOWED_HOSTS=${name || "<hostname>"} (comma-separated) on the server and restart.`,
  }, { status: 421 });
}

function isPublicLlmApi(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function extractApiKey(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader) return apiKeyHeader;
  const googleApiKeyHeader = request.headers.get("x-goog-api-key");
  if (googleApiKeyHeader) return googleApiKeyHeader;
  return request.nextUrl.searchParams?.get("key") || null;
}

async function hasValidApiKey(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

async function canAccessPublicLlmApi(request) {
  // The keyless loopback bypass also needs an allowed Host, so a rebound page cannot
  // read /v1/models. Requests with an API key or CLI token are unaffected by Host.
  if (isLocalRequest(request) && isAllowedHost(request, await loadSettings())) return true;
  if (await hasValidCliToken(request)) return true;
  return await hasValidApiKey(request);
}

async function canAccessLocalOnlyRoute(request) {
  if (await hasValidCliToken(request)) return true;
  // Browser on host: loopback Host + Origin (blocks tunnel/CSRF) + auth (JWT or requireLogin=false)
  if (isLocalRequest(request) && await isAuthenticated(request)) return true;
  return false;
}

async function hasValidToken(request) {
  const token = request.cookies.get("auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

// Read settings directly from DB to avoid self-fetch deadlock in proxy
async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

// requireLogin=false only waives login for a browser on this machine: loopback peer
// (stamped by custom-server.js, never X-Forwarded-For), loopback Origin if any, not via a
// reverse proxy or tunnel (both arrive with forwarding headers), and an allowed Host.
// Everyone else needs a session exactly as if requireLogin were on.
async function isAuthenticated(request) {
  const settings = await loadSettings();
  if (!isAllowedHost(request, settings)) return false;
  if (await hasValidToken(request)) return true;
  if (settings && settings.requireLogin === false && isLocalRequest(request)) return true;
  return false;
}

// Under the public /api/auth/{oidc,saml} prefixes, but they make the server fetch
// a caller-supplied URL (SSRF) — only for signed-in users.
const AUTH_TEST_PATHS = ["/api/auth/oidc/test", "/api/auth/saml/test"];

function isPublicApi(pathname) {
  if (isPublicLlmApi(pathname)) return true;
  if (AUTH_TEST_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return false;
  if (PUBLIC_API_EXACT.includes(pathname)) return true;
  return PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// Shared with src/proxy.js — the mimo login branch must respect dashboard auth.
export { isAuthenticated };

export const __test__ = {
  isPublicApi,
  isLocalRequest,
  isPublicLlmApi,
  isAllowedHost,
  extractApiKey,
  canAccessPublicLlmApi,
  canAccessLocalOnlyRoute,
};

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  // DNS-rebinding gate for everything but the LLM API (key-authenticated; its keyless
  // loopback bypass checks Host itself), so reverse-proxied /v1 traffic is unaffected.
  if (!isPublicLlmApi(pathname) && !isAllowedHost(request, await loadSettings())) {
    return misdirected(request);
  }

  // Local-only gate for spawn-capable / host-secret routes.
  if (isLocalOnlyPath(pathname)) {
    if (!(await canAccessLocalOnlyRoute(request))) {
      return NextResponse.json({ error: "Local only: CLI token required" }, { status: 403 });
    }
  }

  // Always protected - require valid JWT or local CLI token (machineId-based)
  if (isAlwaysProtectedPath(pathname)) {
    if (await hasValidCliToken(request) || await hasValidToken(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isPublicLlmApi(pathname)) {
    if (await canAccessPublicLlmApi(request)) return NextResponse.next();
    return NextResponse.json({ error: "API key required for remote API access" }, { status: 401 });
  }

  // Deny-by-default for /api/* — public allow-list bypasses, everything else requires auth.
  if (pathname.startsWith("/api/")) {
    if (isPublicApi(pathname)) return NextResponse.next();
    if (await hasValidCliToken(request) || await isAuthenticated(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Protect all dashboard routes
  if (pathname.startsWith("/dashboard")) {
    let requireLogin = true;
    let tunnelDashboardAccess = true;

    try {
      const settings = await loadSettings();
      if (settings) {
        requireLogin = settings.requireLogin !== false;
        tunnelDashboardAccess = settings.tunnelDashboardAccess === true;

        // Block tunnel/tailscale access if disabled (redirect to login)
        if (!tunnelDashboardAccess) {
          const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
          const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
          const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
          if ((tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost)) {
            return NextResponse.redirect(new URL("/login", request.url));
          }
        }
      }
    } catch {
      // On error, keep defaults (require login, block tunnel)
    }

    // Login not required: only for a browser on this machine (see isAuthenticated).
    if (!requireLogin && isLocalRequest(request)) return NextResponse.next();

    // Verify JWT token
    const token = request.cookies.get("auth_token")?.value;
    if (token) {
      if (await verifyDashboardAuthToken(token)) {
        return NextResponse.next();
      } else {
        return NextResponse.redirect(new URL("/login", request.url));
      }
    }

    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Redirect / to /dashboard if logged in, or /dashboard if it's the root
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}
