// Per-connection upstream routing for aggregators that take an OpenRouter-style
// `provider` object in the request body (e.g. { only: ["google-vertex/global"] }).
// Stored on providerSpecificData.providerRouting; absent = the aggregator's default routing.
// Providers opt in with the registry quirk `providerRouting: true`.

export const PROVIDER_ROUTING_FIELD = "providerRouting";
export const PROVIDER_ROUTING_BODY_FIELD = "provider";

// Upstream slugs as the aggregator lists them: "anthropic", "google-vertex/global",
// "amazon-bedrock/us-east-1", "deepinfra/fp8".
const SLUG = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)?$/;
const MAX_SLUG_LENGTH = 64;
const MAX_SLUGS = 32;
const LIST_KEYS = ["only", "order", "ignore"];

/** Slug list from an array or a comma/whitespace-separated string; invalid entries dropped. */
export function parseProviderSlugs(value) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  const slugs = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const slug = entry.trim().toLowerCase();
    if (!slug || slug.length > MAX_SLUG_LENGTH || !SLUG.test(slug) || slugs.includes(slug)) continue;
    slugs.push(slug);
    if (slugs.length === MAX_SLUGS) break;
  }
  return slugs;
}

/** Validated { only?, order?, ignore?, allow_fallbacks? }, or null when nothing is set. Used on write and on read. */
export function normalizeProviderRouting(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const routing = {};
  for (const key of LIST_KEYS) {
    const slugs = parseProviderSlugs(value[key]);
    if (slugs.length) routing[key] = slugs;
  }
  if (typeof value.allow_fallbacks === "boolean") routing.allow_fallbacks = value.allow_fallbacks;
  return Object.keys(routing).length ? routing : null;
}

/**
 * Merge the connection's routing into the outgoing body. The connection is the
 * operator's policy (e.g. "only Vertex"), so its keys win over a client-sent
 * `provider` object; keys it leaves unset still come from the client.
 */
export function applyProviderRouting(body, stored) {
  const routing = normalizeProviderRouting(stored);
  if (!routing || !body || typeof body !== "object" || Array.isArray(body)) return body;
  const clientValue = body[PROVIDER_ROUTING_BODY_FIELD];
  const client = clientValue && typeof clientValue === "object" && !Array.isArray(clientValue) ? clientValue : {};
  return { ...body, [PROVIDER_ROUTING_BODY_FIELD]: { ...client, ...routing } };
}
