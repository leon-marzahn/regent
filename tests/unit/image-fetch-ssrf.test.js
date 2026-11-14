// fetchImageAsBase64 (chat image prefetch, client image URLs for cloudflare-ai /
// huggingface) resolves the host, refuses private targets and pins the
// connection to the checked IP. Two holes:
//  1. its own IPv6 check called any colon address without a dot public, so a
//     name with AAAA "::" or "::ffff:7f00:1" reached the gateway's loopback;
//  2. with HTTPS_PROXY set, proxyFetch replaced the pinned dispatcher with the
//     proxy's, which resolves the name itself and skips the IP check.
// DNS is faked and the native fetch is a stub: nothing leaves the process.
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const records = new Map();
vi.mock("node:dns/promises", async (importOriginal) => {
  const real = await importOriginal();
  const lookup = vi.fn(async (host) => {
    if (records.has(host)) return records.get(host);
    throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  });
  return { ...real, default: { ...real, lookup }, lookup };
});

// proxyFetch sends through the undici package's fetch: stub that one.
const sent = vi.hoisted(() => []);
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal()),
  fetch: async (url, options = {}) => {
    sent.push({ url: String(url), dispatcher: options.dispatcher });
    return new Response(PNG, { headers: { "content-type": "image/png" } });
  },
}));

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const realFetch = globalThis.fetch;
const { isBlockedIpAddress } = await import("../../src/shared/utils/ssrfGuard.js");
await import("../../open-sse/utils/proxyFetch.js"); // patches global fetch
const { fetchImageAsBase64 } = await import("../../open-sse/translator/concerns/image.js");
const { ProxyAgent } = await import("undici");

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});
beforeEach(() => {
  sent.length = 0;
  records.clear();
  vi.unstubAllEnvs();
});

const BLOCKED_V6 = [
  "::",
  "::1",
  "::ffff:7f00:1",
  "::ffff:127.0.0.1",
  "::ffff:a9fe:a9fe", // 169.254.169.254
  "64:ff9b::7f00:1",
  "::7f00:1", // IPv4-compatible 127.0.0.1
  "fe80::",
  "fe80::1%en0",
  "fc00::",
  "fd12:3456::1",
];
const PUBLIC_V6 = "2606:4700:4700::1111";

describe("isBlockedIpAddress", () => {
  it.each(BLOCKED_V6)("blocks %s", (ip) => expect(isBlockedIpAddress(ip)).toBe(true));
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "0.0.0.0", "", "not-an-ip"])(
    "blocks %s",
    (ip) => expect(isBlockedIpAddress(ip)).toBe(true),
  );
  it.each([PUBLIC_V6, "93.184.216.34", "[2606:4700:4700::1111]"])("allows %s", (ip) =>
    expect(isBlockedIpAddress(ip)).toBe(false),
  );
});

describe("fetchImageAsBase64 refuses names that resolve to internal IPv6", () => {
  it.each(BLOCKED_V6)("AAAA %s", async (address) => {
    records.set("img.example.test", [{ address, family: 6 }]);
    expect(await fetchImageAsBase64("http://img.example.test:18971/x.png")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("refuses when any record is internal", async () => {
    records.set("img.example.test", [{ address: PUBLIC_V6, family: 6 }, { address: "::", family: 6 }]);
    expect(await fetchImageAsBase64("http://img.example.test/x.png")).toBeNull();
    expect(sent).toEqual([]);
  });

  it("still fetches a public IPv6 host, pinned", async () => {
    records.set("img.example.test", [{ address: PUBLIC_V6, family: 6 }]);
    const out = await fetchImageAsBase64("http://img.example.test/x.png");
    expect(out?.mimeType).toBe("image/png");
    expect(sent).toHaveLength(1);
    expect(sent[0].dispatcher).toBeDefined();
  });
});

describe("the pinned dispatcher is never replaced by a proxy", () => {
  it("keeps the pin with HTTPS_PROXY / HTTP_PROXY set", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
    records.set("img.example.test", [{ address: "93.184.216.34", family: 4 }]);
    for (const url of ["https://img.example.test/x.png", "http://img.example.test/x.png"]) {
      sent.length = 0;
      const out = await fetchImageAsBase64(url);
      expect(out?.mimeType).toBe("image/png");
      expect(sent).toHaveLength(1);
      expect(sent[0].dispatcher).toBeDefined();
      expect(sent[0].dispatcher).not.toBeInstanceOf(ProxyAgent);
    }
  });
});
