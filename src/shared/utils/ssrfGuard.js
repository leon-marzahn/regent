// SSRF guard: block internal/private/metadata targets for server-side fetch.
//
// Three layers, each closing a distinct bypass class documented in #3714:
//   1. assertPublicUrl        - synchronous literal-IP/hostname checks (cheap, for
//                                immediate rejection of obviously-bad input at request-build time).
//   2. assertPublicUrlResolved - adds DNS resolution so a hostname that merely
//                                *resolves* to a private/loopback address (e.g. a
//                                nip.io/sslip.io wildcard-DNS domain, or an attacker's
//                                own domain pointed at 127.0.0.1) is also rejected.
//   3. fetchPublic             - wraps fetch() with manual redirect handling so a
//                                validated public URL can't 30x its way to an
//                                internal target without the redirect target being
//                                re-validated through layer 2 first.
//
// Layer 1 alone previously had matching bugs, not just missing coverage: hostname
// checks ran on the raw string without normalizing a trailing dot ("localhost."),
// and the IPv6 check only recognized one textual representation of an IPv4-mapped
// address (dotted "::ffff:a.b.c.d") while Node/WHATWG URL parsing can normalize the
// same address to hex form ("::ffff:7f00:1") — a mismatch, not an oversight.

import dns from "node:dns";

const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost"];

// Parse dotted IPv4 to 32-bit integer, or null if not a valid IPv4 literal.
function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

// Private/reserved IPv4 ranges as [startInt, maskBits].
const BLOCKED_V4_RANGES = [
  [ipv4ToInt("0.0.0.0"), 8],
  [ipv4ToInt("10.0.0.0"), 8],
  [ipv4ToInt("100.64.0.0"), 10], // CGNAT — also used by some cloud metadata proxies
  [ipv4ToInt("127.0.0.0"), 8],
  [ipv4ToInt("169.254.0.0"), 16], // includes 169.254.169.254 cloud metadata
  [ipv4ToInt("172.16.0.0"), 12],
  [ipv4ToInt("192.168.0.0"), 16],
];

// Private-network mode (allowPrivateNetwork): the LAN and Tailscale ranges a signed-in
// admin may reach when testing their own endpoint. Loopback, 0/8 and link-local
// (169.254.169.254 metadata) stay blocked in every mode. 100.100.100.0/24 is carved out
// of the CGNAT range: Alibaba Cloud's metadata service is 100.100.100.200 and Tailscale
// keeps that /24 for its own services, never for nodes.
const PRIVATE_NETWORK_V4_RANGES = [
  [ipv4ToInt("10.0.0.0"), 8],
  [ipv4ToInt("100.64.0.0"), 10],
  [ipv4ToInt("172.16.0.0"), 12],
  [ipv4ToInt("192.168.0.0"), 16],
];
const PRIVATE_NETWORK_V4_EXCLUDED = [[ipv4ToInt("100.100.100.0"), 24]];

function inV4Ranges(ip, ranges) {
  return ranges.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  });
}

function isBlockedIpv4Int(ip, allowPrivate = false) {
  if (!inV4Ranges(ip, BLOCKED_V4_RANGES)) return false;
  if (!allowPrivate) return true;
  return !inV4Ranges(ip, PRIVATE_NETWORK_V4_RANGES) || inV4Ranges(ip, PRIVATE_NETWORK_V4_EXCLUDED);
}

function isBlockedIpv4(host, allowPrivate = false) {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  return isBlockedIpv4Int(ip, allowPrivate);
}

function parseHextets(s) {
  if (s === "") return [];
  const segs = s.split(":");
  const out = [];
  for (const seg of segs) {
    if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
    out.push(parseInt(seg, 16));
  }
  return out;
}

// Parse any textual IPv6 representation (including an embedded dotted-IPv4 tail,
// "::" compression in any position, and full/partial forms) into 8 16-bit groups.
// Returns null if the string isn't a valid IPv6 literal. Parsing into groups once
// and reasoning about the numeric value — rather than pattern-matching the source
// string — is what makes this immune to "which textual form did the URL parser
// pick" bugs: "::ffff:127.0.0.1" and "::ffff:7f00:1" produce identical groups.
function parseIPv6ToGroups(rawHost) {
  let host = rawHost.toLowerCase();

  const v4TailMatch = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let v4Groups = null;
  if (v4TailMatch) {
    const v4Int = ipv4ToInt(v4TailMatch[1]);
    if (v4Int === null) return null;
    v4Groups = [(v4Int >>> 16) & 0xffff, v4Int & 0xffff];
    host = host.slice(0, host.length - v4TailMatch[1].length);
    if (host.endsWith("::")) {
      // "::" compression marker itself — leave both colons, the removed IPv4
      // fills the gap it represents.
    } else if (host.endsWith(":")) {
      host = host.slice(0, -1); // was just the "prevgroup:ipv4" separator
    }
  }

  const doubleColonParts = host.split("::");
  if (doubleColonParts.length > 2) return null;

  let groups;
  if (doubleColonParts.length === 2) {
    const head = parseHextets(doubleColonParts[0]);
    const tail = parseHextets(doubleColonParts[1]);
    if (head === null || tail === null) return null;
    const v4Len = v4Groups ? v4Groups.length : 0;
    const missing = 8 - head.length - tail.length - v4Len;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill(0), ...tail, ...(v4Groups || [])];
  } else {
    const all = parseHextets(host);
    if (all === null) return null;
    groups = [...all, ...(v4Groups || [])];
  }
  return groups.length === 8 ? groups : null;
}

function isBlockedIpv6Groups(g, allowPrivate = false) {
  const isZero = (n) => g[n] === 0;
  // loopback ::1
  if ([0, 1, 2, 3, 4, 5, 6].every(isZero) && g[7] === 1) return true;
  // unspecified ::
  if (g.every((x) => x === 0)) return true;
  // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // unique local fc00::/7. Private-network mode admits only Tailscale's fd7a:115c:a1e0::/48:
  // cloud metadata also lives in ULA space (AWS fd00:ec2::254, GCP fd20:ce::254).
  if ((g[0] & 0xfe00) === 0xfc00) {
    return !(allowPrivate && g[0] === 0xfd7a && g[1] === 0x115c && g[2] === 0xa1e0);
  }
  // IPv4-mapped ::ffff:0:0/96 (0:0:0:0:0:ffff:a.b.c.d — the 0xffff marker is
  // group index 5) and NAT64 well-known prefix 64:ff9b::/96 — both embed a
  // real IPv4 address in the low 32 bits; check it against the same IPv4
  // blocklist regardless of which prefix wraps it.
  const low32 = ((g[6] << 16) | g[7]) >>> 0;
  if ([0, 1, 2, 3, 4].every(isZero) && g[5] === 0xffff) return isBlockedIpv4Int(low32, allowPrivate);
  if (g[0] === 0x0064 && g[1] === 0xff9b && [2, 3, 4, 5].every(isZero)) return isBlockedIpv4Int(low32, allowPrivate);
  // IPv4-compatible ::a.b.c.d/96 (deprecated, still parseable) — excludes :: and ::1
  // which already matched above.
  if ([0, 1, 2, 3, 4, 5].every(isZero) && low32 !== 0 && low32 !== 1) return isBlockedIpv4Int(low32, allowPrivate);
  return false;
}

// True if a resolved IP address (what dns.lookup returns, IPv4 or IPv6, with
// or without brackets/zone id) is not a public target. Anything that doesn't
// parse as an IP counts as blocked. Shared with the image fetch guard so both
// use one IPv6 parser (::, ::ffff:7f00:1, 64:ff9b::/96, ::a.b.c.d …).
export function isBlockedIpAddress(address) {
  if (typeof address !== "string" || !address) return true;
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (ipv4ToInt(ip) !== null) return isBlockedIpv4(ip);
  if (!ip.includes(":")) return true;
  const groups = parseIPv6ToGroups(ip);
  return !groups || isBlockedIpv6Groups(groups);
}

function normalizeHost(hostname) {
  // A trailing dot marks an FQDN and is semantically insignificant
  // ("localhost." and "localhost" are the same host) but was being compared
  // as a literal character, letting it slip past every string-based check.
  return hostname.toLowerCase().replace(/\.+$/, "");
}

// Private-network mode resolves every name and checks the addresses, so mDNS LAN names
// (mac-studio.local) can pass; .internal (metadata.google.internal) and .localhost cannot.
const PRIVATE_NETWORK_BLOCKED_SUFFIXES = BLOCKED_SUFFIXES.filter((s) => s !== ".local");

function isBlockedHost(host, allowPrivate = false) {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  const suffixes = allowPrivate ? PRIVATE_NETWORK_BLOCKED_SUFFIXES : BLOCKED_SUFFIXES;
  if (suffixes.some((s) => host.endsWith(s))) return true;
  if (isBlockedIpv4(host, allowPrivate)) return true;
  if (host.includes(":")) {
    const groups = parseIPv6ToGroups(host.replace(/^\[|\]$/g, ""));
    if (groups && isBlockedIpv6Groups(groups, allowPrivate)) return true;
  }
  return false;
}

// Throw if URL targets a non-public host by literal hostname/IP alone (no DNS
// resolution — see assertPublicUrlResolved for that). Caller should map to 400.
export function assertPublicUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = normalizeHost(parsed.hostname);
  if (isBlockedHost(host)) throw new Error("Blocked URL: internal host");
}

// Async: assertPublicUrl plus DNS resolution of non-literal hostnames, so a
// domain that merely *resolves* to a private/loopback/metadata address (wildcard-DNS
// services like nip.io/sslip.io, or an attacker-controlled domain with an A record
// pointed at 127.0.0.1) is rejected too, not just IPs typed directly into the URL.
//
// failClosed: reject a hostname that does not resolve locally. fetchPublic uses
// it because its request may go through a proxy that resolves names itself: a
// name only the proxy knows (split-horizon DNS) would otherwise skip the check.
//
// allowPrivateNetwork: also admit LAN and Tailscale addresses (PRIVATE_NETWORK_V4_RANGES,
// Tailscale IPv6). Only for a caller already trusted to point the server at its own
// network, such as a signed-in admin testing a custom endpoint. Loopback, link-local and
// cloud metadata stay blocked.
export async function assertPublicUrlResolved(rawUrl, { failClosed = false, allowPrivateNetwork = false } = {}) {
  const parsed = new URL(rawUrl);
  const host = normalizeHost(parsed.hostname);
  if (isBlockedHost(host, allowPrivateNetwork)) throw new Error("Blocked URL: internal host");

  // Already a literal IPv4/IPv6 address — isBlockedHost above already covered it,
  // no DNS lookup applies (and dns.lookup would just echo it back anyway).
  const bracketless = host.replace(/^\[|\]$/g, "");
  if (ipv4ToInt(bracketless) !== null || bracketless.includes(":")) return;

  let addresses;
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    if (failClosed) throw new Error("Blocked URL: hostname does not resolve");
    // Resolution failure isn't an SSRF signal by itself — let the subsequent
    // fetch() fail with its own (clearer) network error.
    return;
  }
  for (const { address, family } of addresses) {
    const blocked = family === 4
      ? isBlockedIpv4(address, allowPrivateNetwork)
      : isBlockedIpv6Groups(parseIPv6ToGroups(address) || [], allowPrivateNetwork);
    if (blocked) {
      throw new Error("Blocked URL: hostname resolves to an internal host");
    }
  }
}

// fetch() with SSRF-safe manual redirect handling: each hop's target is
// re-validated through assertPublicUrlResolved before being followed, so a
// validated public URL can't 30x its way to an internal target. Bounded to
// maxRedirects hops (fetch's own default following behavior has no bound
// relevant here since we never let it auto-follow).
//
// Like fetch()'s own redirect mode, a hop to another origin drops the credential
// headers, so an API key sent to the first host is not handed to the redirect target.
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "x-api-key", "cookie"];

export async function fetchPublic(url, init = {}, { maxRedirects = 5, allowPrivateNetwork = false } = {}) {
  const guard = { failClosed: true, allowPrivateNetwork };
  await assertPublicUrlResolved(url, guard);
  let currentUrl = url;
  let hopInit = init;
  for (let hop = 0; ; hop++) {
    const res = await fetch(currentUrl, { ...hopInit, redirect: "manual" });
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = isRedirect ? res.headers.get("location") : null;
    if (!location) return res;
    if (hop >= maxRedirects) throw new Error("Blocked URL: too many redirects");
    const nextUrl = new URL(location, currentUrl).toString();
    await assertPublicUrlResolved(nextUrl, guard);
    if (new URL(nextUrl).origin !== new URL(currentUrl).origin && hopInit.headers) {
      const headers = new Headers(hopInit.headers);
      for (const name of CREDENTIAL_HEADERS) headers.delete(name);
      hopInit = { ...hopInit, headers };
    }
    currentUrl = nextUrl;
  }
}
