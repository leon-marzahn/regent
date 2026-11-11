// Optional TLS/HTTP2 fingerprint impersonation for upstream requests via wreq-js.
//
// Opt-in per connection (providerSpecificData.tlsImpersonation) and fail-open: if the native binding is
// missing or a request errors before a response arrives, callers fall back to
// the normal undici fetch path. Impersonating a client can break provider ToS.
import { dbg } from "./debugLog.js";

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const STALE_AFTER_DECODE = new Set(["content-encoding", "content-length"]);

// Resolved only at runtime: a non-literal, bundler-ignored specifier keeps webpack/turbopack from
// failing the build when the optional package isn't installed (it's in serverExternalPackages anyway).
const WREQ_MODULE = "wreq-js";
const importWreq = () => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ WREQ_MODULE);

let loader = importWreq;
let wreqPromise = null;
let loadFailureLogged = false;
const loggedHosts = new Set();

async function loadWreq() {
  if (!wreqPromise) {
    wreqPromise = loader()
      .then((mod) => (typeof mod?.fetch === "function" ? mod : (mod?.default ?? null)))
      .catch((err) => {
        if (!loadFailureLogged) {
          loadFailureLogged = true;
          console.warn(`[TLS] wreq-js unavailable, using native fetch: ${err.message}`);
        }
        return null;
      });
  }
  return wreqPromise;
}

// Error text can echo the proxy URL; never log its user:pass.
export function redactUserinfo(message) {
  return String(message || "").replace(/\/\/[^/@\s]+@/g, "//***@");
}

function isReplayableBody(body) {
  return body == null || typeof body === "string" || body instanceof Uint8Array;
}

function toHeaderObject(headers) {
  if (!headers) return {};
  if (typeof headers.entries === "function") return Object.fromEntries(headers.entries());
  return { ...headers };
}

/**
 * Send via wreq-js. Returns a native Response, or null when the caller should
 * fall back to fetch (binding unavailable, non-replayable body, transport error).
 * Abort errors are rethrown so cancellation is never turned into a retry.
 */
export async function wreqFetch(url, options, impersonation, proxyUrl) {
  if (!impersonation || !isReplayableBody(options.body)) return null;
  const wreq = await loadWreq();
  if (!wreq) return null;

  let res;
  try {
    res = await wreq.fetch(url, {
      method: options.method || "GET",
      headers: toHeaderObject(options.headers),
      body: options.body ?? undefined,
      signal: options.signal,
      redirect: options.redirect || "follow",
      browser: impersonation.browser,
      os: impersonation.os,
      // Send only our headers: browser defaults (sec-ch-ua, …) would contradict the provider client UA.
      disableDefaultHeaders: true,
      // 0 = no wreq-side timeout; executors own timeouts through the abort signal.
      timeout: 0,
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    });
  } catch (err) {
    if (options.signal?.aborted || err?.name === "AbortError") throw err;
    console.warn(
      `[TLS] wreq-js request failed, falling back to native fetch: ${redactUserinfo(err?.message)}`,
    );
    return null;
  }

  try {
    const host = new URL(url).hostname;
    if (!loggedHosts.has(host)) {
      loggedHosts.add(host);
      dbg("TLS", `impersonating ${impersonation.browser}/${impersonation.os} for ${host}`);
    }
  } catch {}

  // wreq-js decompresses bodies, so the original encoding/length no longer describe them.
  const headers = toHeaderObject(res.headers);
  for (const name of Object.keys(headers)) {
    if (STALE_AFTER_DECODE.has(name.toLowerCase())) delete headers[name];
  }
  const body = NULL_BODY_STATUSES.has(res.status) ? null : res.body;
  return new Response(body, { status: res.status, statusText: res.statusText || "", headers });
}

/** Test hook: swap the module loader and reset cached state. */
export function __setWreqLoaderForTests(fn) {
  loader = fn || importWreq;
  wreqPromise = null;
  loadFailureLogged = false;
  loggedHosts.clear();
}
