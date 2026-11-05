// Kiro never reports cache counts, so this estimates them. What Kiro caches was measured
// from the credits it bills (2026-11, claude-opus-5.5): a cached input token costs about
// 27% of an uncached one, so the credits show how much of a prompt was served from cache.
//   - Kiro caches by content, per account, and only serves a prefix that an earlier
//     request sent in full. It is not the previous turn: the newest three turns (six
//     history messages) are always billed in full, even when every message is unchanged.
//     A chat growing ~6.6k tokens a turn paid full price on turns 1-3, then turn N was
//     cached up to what turn N-3 sent.
//   - So a request is counted as cached up to the longest earlier request it continues,
//     as long as that request is at least three turns back. Matching is on content
//     (chained hashes of the messages), never on a session id, so concurrent chats that
//     share an opening (subagents) only share what they really have in common, and a
//     request still in flight when this one started never counts.
//   - An exact repeat (same history, same last message) is served whole.
//   - Kiro drops an idle prefix after about five minutes (measured between 3.5 and 6
//     minutes, and a hit extends it), so an older entry no longer counts.
//   - Not modeled, so this under-reports there: one chat whose first message alone was
//     64k tokens was fully cached from turn 2. Smaller openings (9k, 14k) were not.
// Prompt sizes are themselves approximations (context percentage), so this is an estimate.
// State is in memory and a restart simply forgets it (cached = 0).

import { createHash } from "node:crypto";

const MAX_ENTRIES = 5000;
const TTL_MS = 5 * 60 * 1000;
// Three turns of a user message and an assistant reply that Kiro always bills in full.
const UNCACHED_TAIL_MESSAGES = 6;

const sent = new Map(); // hash of a full request -> { prompt, startedAt, at }

const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

// What the model sees of a message. Request metadata (origin, the tool list on the
// current message, modelId) and reasoning are left out: they differ between the turn a
// message was current and the turns that replay it in history.
function messageDigest(item) {
  const user = item?.userInputMessage;
  if (user) {
    const ctx = user.userInputMessageContext;
    return digest(JSON.stringify(["user", user.content ?? "", ctx?.toolResults ?? null, user.images ?? null]));
  }
  const assistant = item?.assistantResponseMessage;
  return digest(JSON.stringify(["assistant", assistant?.content ?? "", assistant?.toolUses ?? null]));
}

/**
 * Pull what the estimator needs out of the Kiro payload sent upstream. Call it when the
 * request is sent: its time decides which earlier requests could have warmed the cache.
 * @param {object} body Kiro request body
 * @param {string} [scope] connection id; Kiro's cache is per account
 * @returns {{prefixHashes: string[], requestHash: string, startedAt: number} | null}
 */
export function buildKiroCacheContext(body, scope = "") {
  const state = body?.conversationState;
  const message = state?.currentMessage?.userInputMessage;
  if (!message) return null;
  const history = Array.isArray(state.history) ? state.history : [];
  const modelId = message.modelId || history.find((h) => h?.userInputMessage?.modelId)?.userInputMessage.modelId || "";
  // prefixHashes[i] identifies history[0..i]; it equals the requestHash of the earlier
  // request whose last (current) message was history[i].
  let chain = digest(`${scope}\n${modelId}`);
  const prefixHashes = history.map((item) => (chain = digest(`${chain}\n${messageDigest(item)}`)));
  return {
    prefixHashes,
    requestHash: digest(`${chain}\n${messageDigest(state.currentMessage)}`),
    startedAt: Date.now(),
  };
}

// An earlier request that could have warmed Kiro's cache for one starting at `startedAt`.
function warmEntry(hash, startedAt) {
  const entry = sent.get(hash);
  if (!entry || entry.startedAt >= startedAt || startedAt - entry.at > TTL_MS) return null;
  return entry;
}

/**
 * @param {ReturnType<typeof buildKiroCacheContext>} context
 * @param {number} promptTokens total prompt tokens of this request
 * @returns {number} estimated cached prompt tokens (0 when nothing earlier is known)
 */
export function estimateKiroCachedTokens(context, promptTokens) {
  if (!context?.requestHash || !(promptTokens > 0)) return 0;
  const { prefixHashes, requestHash, startedAt } = context;

  let hit = warmEntry(requestHash, startedAt);
  for (let i = prefixHashes.length - UNCACHED_TAIL_MESSAGES; !hit && i >= 0; i--) {
    hit = warmEntry(prefixHashes[i], startedAt);
  }
  if (hit) hit.at = startedAt; // a hit keeps Kiro's prefix alive

  sent.delete(requestHash);
  if (sent.size >= MAX_ENTRIES) sent.delete(sent.keys().next().value);
  sent.set(requestHash, { prompt: promptTokens, startedAt, at: startedAt });

  return hit ? Math.min(hit.prompt, promptTokens) : 0;
}

/** Test helper. */
export function resetKiroCacheEstimator() {
  sent.clear();
}
