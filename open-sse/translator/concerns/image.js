// Build a base64 data URI from mime + base64 payload
export function encodeDataUri(mimeType, base64) {
  return `data:${mimeType};base64,${base64}`;
}

// Parse a base64 data URI → { mimeType, base64 }, or null if not a data URI.
// [\s\S] tolerates newlines inside the base64 payload.
// Image mimes are corrected from the magic bytes: clients (e.g. Tavo) label WebP
// as image/jpeg, and Bedrock-backed upstreams reject the mismatch with a 400.
const DATA_URI_RE = /^data:([^;]+);base64,([\s\S]+)$/;
export function parseDataUri(url) {
  if (typeof url !== "string") return null;
  const m = url.match(DATA_URI_RE);
  if (!m) return null;
  let mimeType = m[1];
  if (mimeType.startsWith("image/")) {
    const head = Buffer.from(m[2].slice(0, 32).replace(/\s/g, ""), "base64");
    mimeType = detectImageMime(head) || mimeType;
  }
  return { mimeType, base64: m[2] };
}

import { lookup } from "node:dns/promises";
import { Agent } from "undici";
import { MAX_IMAGE_BYTES, FETCH_TIMEOUT_MS, IMAGE_SIGNATURES, BLOCKED_HOSTS } from "../../config/mediaConfig.js";
import { isBlockedIpAddress } from "../../../src/shared/utils/ssrfGuard.js";

// True if an IPv4/IPv6 address is private/reserved (SSRF target). One source of
// truth with the SSRF guard: its IPv6 parser covers ::, ::ffff:7f00:1, NAT64
// and IPv4-compatible forms the old string checks here let through.
function isPrivateIp(ip) {
  return isBlockedIpAddress(ip);
}

// Resolve host once and return only public IPs (SSRF guard).
// Rejects if any resolved record is private/reserved (defeats multi-A tricks).
async function resolvePinnedIps(hostname) {
  if (!hostname || BLOCKED_HOSTS.has(hostname.toLowerCase())) return null;
  try {
    const records = await lookup(hostname, { all: true });
    if (!records.length || records.some((r) => isPrivateIp(r.address))) return null;
    return records;
  } catch {
    return null;
  }
}

// Verify buffer magic bytes match a known image signature; return its mime or null.
function detectImageMime(buf) {
  for (const { sig, offset, mime, verifyWebp } of IMAGE_SIGNATURES) {
    if (buf.length < offset + sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (buf[offset + i] !== sig[i]) { match = false; break; }
    }
    if (!match) continue;
    // WEBP: RIFF....WEBP — bytes 8..11 must be "WEBP".
    if (verifyWebp && !(buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)) continue;
    return mime;
  }
  return null;
}

/**
 * Fetch a remote image URL and return it as a base64 data URI.
 * Hardened against SSRF (private/metadata IPs), memory DoS (size cap),
 * and disguised non-image payloads (magic-byte verification).
 * Returns null on any failure or rejection.
 *
 * @param {string} imageUrl - HTTP(S) URL of the image
 * @param {object} options - { signal, timeoutMs, maxBytes }
 * @returns {Promise<{url: string, mimeType: string}|null>}
 */
export async function fetchImageAsBase64(imageUrl, options = {}) {
  const { signal, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_IMAGE_BYTES } = options;
  if (!imageUrl || (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://"))) {
    return null;
  }

  let url;
  try { url = new URL(imageUrl); } catch { return null; }
  const pinnedIps = await resolvePinnedIps(url.hostname);
  if (!pinnedIps) return null;

  const controller = new AbortController();
  const timeout = signal ? null : setTimeout(() => controller.abort(), timeoutMs);
  const fetchSignal = signal || controller.signal;

  // Pin connect to the validated IP so no second DNS resolution can rebind (TOCTOU fix).
  const dispatcher = new Agent({
    connect: { lookup: (_h, _o, cb) => cb(null, [{ address: pinnedIps[0].address, family: pinnedIps[0].family }]) },
  });

  try {
    // redirect:"manual" prevents a public URL redirecting to a private one (SSRF bypass).
    const response = await fetch(imageUrl, { signal: fetchSignal, redirect: "manual", dispatcher });
    if (!response.ok || !response.body) return null;

    // Stream-read with a hard byte cap to avoid loading huge payloads into memory.
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
      chunks.push(value);
    }

    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const mimeType = detectImageMime(buf);
    if (!mimeType) return null; // not a recognized image — reject disguised payloads

    return { url: `data:${mimeType};base64,${buf.toString("base64")}`, mimeType };
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
    dispatcher.close().catch(() => {});
  }
}
