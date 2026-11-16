// Per-connection upstream routing for aggregators that take an OpenRouter-style
// `provider` object in the request body (e.g. { only: ["google-vertex/global"] }).
// Stored on providerSpecificData.providerRouting; absent = the aggregator's default routing.
// Providers opt in with the registry quirk `providerRouting: true`.
//
// Two entry points on purpose:
// - validateProviderRouting: strict, for writes. Anything it can't use is reported, so a
//   typo can never silently loosen the operator's policy (e.g. drop the only "only" entry).
// - normalizeProviderRouting: tolerant, for reads. Keeps what is valid and drops the rest,
//   so a tampered or legacy stored value can't break or inject into a request (fail-open).

export const PROVIDER_ROUTING_FIELD = "providerRouting";
export const PROVIDER_ROUTING_BODY_FIELD = "provider";
export const PROVIDER_ROUTING_LIST_KEYS = ["only", "order", "ignore"];
export const PROVIDER_ROUTING_MAX_SLUGS = 32;

import { PROVIDERS } from "./providers.js";

// Upstream slugs as the aggregator lists them: "anthropic", "google-vertex/global",
// "amazon-bedrock/us-east-1", "deepinfra/fp8".
const SLUG = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)?$/;
const MAX_SLUG_LENGTH = 64;
const KNOWN_KEYS = new Set([...PROVIDER_ROUTING_LIST_KEYS, "allow_fallbacks"]);

// Entries are separated by commas or line breaks only: "google vertex" stays one
// (invalid) entry instead of quietly becoming two different slugs.
function splitEntries(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[,\n]+/).filter((s) => s.trim());
  return null;
}

/** { slugs, rejected } for one list; rejected holds the entries as written. */
export function checkProviderSlugs(value) {
  const entries = splitEntries(value);
  if (entries === null) return { slugs: [], rejected: value == null ? [] : [String(value)] };
  const slugs = [];
  const rejected = [];
  for (const entry of entries) {
    const slug = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (!slug || slug.length > MAX_SLUG_LENGTH || !SLUG.test(slug)) {
      rejected.push(typeof entry === "string" ? entry.trim() : JSON.stringify(entry));
    } else if (!slugs.includes(slug)) {
      slugs.push(slug);
    }
  }
  return { slugs, rejected };
}

/** Tolerant slug list: valid entries only, capped. */
export function parseProviderSlugs(value) {
  return checkProviderSlugs(value).slugs.slice(0, PROVIDER_ROUTING_MAX_SLUGS);
}

/**
 * Strict check for writes. Returns { routing, errors }: routing is the validated object
 * (null when empty), errors lists every problem in plain words. Callers must refuse to
 * store anything while errors is non-empty.
 */
export function validateProviderRouting(value) {
  if (value == null) return { routing: null, errors: [] };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { routing: null, errors: ["Upstream routing must be an object."] };
  }
  const errors = [];
  const routing = {};
  for (const key of Object.keys(value)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`Unknown routing field "${key}".`);
  }
  for (const key of PROVIDER_ROUTING_LIST_KEYS) {
    const { slugs, rejected } = checkProviderSlugs(value[key]);
    if (rejected.length) errors.push(`"${key}" has invalid provider slugs: ${rejected.join(", ")}.`);
    if (slugs.length > PROVIDER_ROUTING_MAX_SLUGS) {
      errors.push(`"${key}" lists ${slugs.length} providers; the limit is ${PROVIDER_ROUTING_MAX_SLUGS}.`);
    }
    if (slugs.length) routing[key] = slugs;
  }
  if (value.allow_fallbacks !== undefined && value.allow_fallbacks !== null) {
    if (typeof value.allow_fallbacks === "boolean") routing.allow_fallbacks = value.allow_fallbacks;
    else errors.push('"allow_fallbacks" must be true or false.');
  }
  return { routing: Object.keys(routing).length ? routing : null, errors };
}

export function supportsProviderRouting(provider) {
  return !!PROVIDERS[provider]?.quirks?.providerRouting;
}

/**
 * The one write-path check, shared by every route that stores a connection.
 * `body` is the request body; routing may come top-level or inside providerSpecificData
 * (top-level wins). Returns { supplied, routing, error }: when error is set the caller
 * answers 400 and stores nothing; otherwise it stores `routing` (null = none) if supplied.
 */
export function checkProviderRoutingWrite(provider, body) {
  const psd = body?.providerSpecificData;
  const topLevel = !!body && Object.prototype.hasOwnProperty.call(body, PROVIDER_ROUTING_FIELD);
  const nested = !!psd && typeof psd === "object" && Object.prototype.hasOwnProperty.call(psd, PROVIDER_ROUTING_FIELD);
  if (!topLevel && !nested) return { supplied: false, routing: null, error: null };
  const { routing, errors } = validateProviderRouting(topLevel ? body[PROVIDER_ROUTING_FIELD] : psd[PROVIDER_ROUTING_FIELD]);
  if (routing && !supportsProviderRouting(provider)) {
    return { supplied: true, routing: null, error: "This provider does not support upstream routing." };
  }
  if (errors.length) return { supplied: true, routing: null, error: errors.join(" ") };
  return { supplied: true, routing, error: null };
}

/** Validated { only?, order?, ignore?, allow_fallbacks? }, or null when nothing is usable. Read path. */
export function normalizeProviderRouting(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const routing = {};
  for (const key of PROVIDER_ROUTING_LIST_KEYS) {
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
