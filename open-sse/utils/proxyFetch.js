import { Readable } from "stream";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { maskString } from "./maskSecrets.cjs";
import { wreqFetch } from "./tlsImpersonation.js";
import { getScopedProxyOptions, PROXY_UNAVAILABLE } from "./proxyScope.js";

const proxyDispatchers = new Map();

// Always fetch through the package's own undici instance: undici 8 rejects
// dispatchers created by a different undici copy (UND_ERR_INVALID_ARG on the
// bundled-in-Node global fetch), so originalFetch/globalThis.fetch is not an
// option once we build our own Agents.
let undiciFetch = null;
async function rawFetch(url, options) {
  undiciFetch ??= (await import("undici")).fetch;
  return undiciFetch(url, options);
}

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const TLS_CERT_ERRORS = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function isTlsCertError(err) {
  const code = err?.cause?.code || err?.code;
  return TLS_CERT_ERRORS.has(code);
}
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

// ISP DPI (VN → api.anthropic.com) RSTs Node's default TLS ClientHello curve
// list; a single curve rewrites the fingerprint enough to pass. Empirically:
// default agent = ECONNRESET 100%, X25519 = through 100%.
// REGENT_TLS_ECDH_CURVE overrides it (the upstream NINEROUTER_TLS_ECDH_CURVE is still read).
const TLS_ECDH_CURVE = process.env.REGENT_TLS_ECDH_CURVE || process.env.NINEROUTER_TLS_ECDH_CURVE || "X25519";

/**
 * Create proxy dispatcher lazily (undici-compatible).
 * Always returns a dispatcher — the direct path needs the custom Agent too,
 * otherwise the default global agent's ClientHello gets RST-ed by DPI.
 */
async function getDispatcher(proxyUrl, insecure = false) {
  const normalized = normalizeProxyUrl(proxyUrl);

  const key = `${normalized || "direct"}::${insecure ? "insecure" : "secure"}`;
  if (!proxyDispatchers.has(key)) {
    // Evict oldest entry if max size reached
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      proxyDispatchers.delete(proxyDispatchers.keys().next().value);
    }
    const { Agent, ProxyAgent } = await import("undici");
    // autoSelectFamilyAttemptTimeout = happy eyeballs (RFC 8305): race both
    // address families, fall over in 250ms — replaces the old global
    // ipv4first flag, which fixed one broken-family network by breaking the
    // other (see claude-code#20240 vs our VN case: IPv4 path RST-ed).
    // requestTls must stay TLS-options-only (undici 8 rejects connect-level
    // options there with UND_ERR_INVALID_ARG).
    const eyeballs = { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 };
    const tlsOpts = { ecdhCurve: TLS_ECDH_CURVE, ...(insecure ? { rejectUnauthorized: false } : {}) };
    const connect = { ...eyeballs, ...tlsOpts };
    const dispatcher = normalized
      ? new ProxyAgent({ uri: normalized, connect: eyeballs, requestTls: tlsOpts })
      : new Agent({ connect, keepAliveTimeout: 4000 });
    proxyDispatchers.set(key, dispatcher);
  }

  return proxyDispatchers.get(key);
}

async function fetchWithTlsFallback(url, options, proxyUrl, impersonation = null) {
  if (impersonation) {
    const impersonated = await wreqFetch(typeof url === "string" ? url : url.toString(), options, impersonation, proxyUrl);
    if (impersonated) return impersonated;
  }
  try {
    // Protocol adapters may need Node's HTTP/1 transport on the direct path.
    // Keep proxy/no-proxy resolution and strict-proxy enforcement here.
    if (!proxyUrl && options.directFetch) return await options.directFetch(url, options);
    const dispatcher = await getDispatcher(proxyUrl);
    return await rawFetch(url, { ...options, dispatcher });
  } catch (err) {
    const isStrictSsl = options.strictTls === true || process.env.STRICT_SSL === "true" || process.env.STRICT_SSL === "1";
    if (!isStrictSsl && isTlsCertError(err)) {
      if (options.body && typeof options.body.getReader === "function" && options.body.locked) {
        throw err;
      }
      // ponytail: in-memory insecure agent fallback for self-signed MITM corporate/antivirus certs
      console.warn(`[ProxyFetch] TLS cert verification failed (${err.cause?.code || err.code}), retrying with insecure TLS: ${maskString(String(url))}`);
      const insecureDispatcher = await getDispatcher(proxyUrl, true);
      return await rawFetch(url, { ...options, dispatcher: insecureDispatcher });
    }
    throw err;
  }
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const netModule = await import("net");
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    socket.connect(HTTPS_PORT, realIP, () => {
      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      const req = https.request(reqOptions, (res) => {
        const response = {
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: new Map(Object.entries(res.headers)),
          body: Readable.toWeb(res),
          text: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
          },
          json: async () => JSON.parse(await response.text()),
        };
        resolve(response);
      });

      req.on("error", reject);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    socket.on("error", reject);
  });
}

// Errors that happen before any byte of the request reached the target: the
// proxy refused the TCP connection, its hostname did not resolve, connecting
// timed out, or it refused the CONNECT tunnel.
const CONNECT_STAGE_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT",
]);
const TUNNEL_REFUSED = /Proxy response \(\d+\) !== 200 when HTTP Tunneling/;

export function isProxyConnectStageError(err) {
  for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
    if (CONNECT_STAGE_CODES.has(e.code)) return true;
    if (TUNNEL_REFUSED.test(String(e.message || ""))) return true;
  }
  return false;
}

// A request refused because of the connection's proxy. The message is generic
// (it reaches API clients); the details stay in the server log.
function proxyUnavailable(detail, proxyOptions, cause = null) {
  console.warn(`[ProxyFetch] ${detail}`);
  // Keep the transport's own short reason ("fetch failed", "response lost"),
  // minus anything that looks like a URL or address.
  const reason = cause?.message
    ? String(cause.message)
      .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted]")
      .replace(/\S*@\S+/g, "[redacted]")
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[redacted]")
      .slice(0, 120)
    : "";
  const err = new Error(reason ? `Upstream proxy unavailable: ${reason}` : "Upstream proxy unavailable");
  err.code = PROXY_UNAVAILABLE;
  try { proxyOptions?.onProxyUnavailable?.(err); } catch { /* observer only */ }
  return err;
}

// Throws instead of letting the caller fall back to a direct connection when
// the proxy is strict, or when the request may already have been sent and must
// not be replayed (directFallback: "connect-only", used by token refresh).
function refuseDirectFallback(proxyError, options, proxyOptions) {
  if (options?.signal?.aborted) throw proxyError;
  if (proxyOptions?.strictProxy === true) {
    throw proxyUnavailable(`Proxy required but failed (strictProxy=true): ${proxyError.message}`, proxyOptions, proxyError);
  }
  if (proxyOptions?.directFallback === "connect-only" && !isProxyConnectStageError(proxyError)) {
    throw proxyUnavailable(`Proxy failed after the request may have been sent; not replaying it directly: ${proxyError.message}`, proxyOptions, proxyError);
  }
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  // A caller that brings its own dispatcher (the SSRF guard's IP-pinned agent
  // for client image URLs) chose the transport: never swap it for a scope,
  // connection or global (HTTPS_PROXY) proxy, which would resolve the name
  // itself and skip the IP check the pin enforces.
  if (options?.dispatcher) return rawFetch(url, options);
  // No explicit options: use the connection scope, if any (proxyScope.js).
  if (!proxyOptions) proxyOptions = getScopedProxyOptions();
  const targetUrl = typeof url === "string" ? url : url.toString();

  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const baseHeaders = options.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : { ...(options.headers || {}) };
    const relayHeaders = {
      ...baseHeaders,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return await rawFetch(vercelRelayUrl, { ...options, headers: relayHeaders });
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;
  // Opt-in browser TLS/HTTP2 fingerprint (wreq-js); null → native fetch.
  const impersonation = proxyOptions?.tlsImpersonation || null;

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      try {
        return await fetchWithTlsFallback(url, options, proxyUrl, impersonation);
      } catch (proxyError) {
        refuseDirectFallback(proxyError, options, proxyOptions);
        console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`);
      }
    }
    // No proxy — manually resolve real IP to bypass DNS spoof
    try {
      const parsedUrl = new URL(targetUrl);
      const realIP = await resolveRealIP(parsedUrl.hostname);
      if (realIP) return await createBypassRequest(parsedUrl, realIP, options);
    } catch (error) {
      console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
    }
  }

  if (proxyUrl) {
    try {
      return await fetchWithTlsFallback(url, options, proxyUrl, impersonation);
    } catch (proxyError) {
      // strictProxy: fail hard instead of falling back to direct (and refresh
      // requests only fall back when nothing can have been sent).
      refuseDirectFallback(proxyError, options, proxyOptions);
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct: ${proxyError.message}`);
      return fetchWithTlsFallback(url, options, null, impersonation);
    }
  }

  // Strict mode means "never leave over the direct IP". Reaching here with a
  // proxy configured but unresolved is exactly that case — an inactive or
  // empty pool, or every proxy removed — so refuse instead of silently
  // exposing the real address (#4333). The catch blocks above only cover a
  // proxy that was actually tried.
  //
  // Gate on a proxy being *intended*: callers like the Qoder executor set
  // strictProxy to mean "do not replay this request directly if the proxy
  // fails" (a replayed COSY signature returns 403), not "a proxy is required".
  // With nothing configured they must keep working.
  const proxyIntended = proxyOptions?.proxyPoolId
    || proxyOptions?.enabled === true
    || proxyOptions?.connectionProxyEnabled === true
    || !!normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (proxyOptions?.strictProxy === true && proxyIntended) {
    throw proxyUnavailable("Proxy required but none resolved (strictProxy=true)", proxyOptions);
  }

  // got-scraping disabled — use native fetch directly
  // (Re-enable per-host by wrapping with tryGotScrapingFetch when needed)
  return fetchWithTlsFallback(url, options, null, impersonation);
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
