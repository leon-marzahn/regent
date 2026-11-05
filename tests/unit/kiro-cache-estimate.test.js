import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildKiroCacheContext,
  estimateKiroCachedTokens,
  resetKiroCacheEstimator,
} from "../../open-sse/utils/kiroCacheEstimate.js";

const MIN = 60 * 1000;
const OPENING = `system prompt and first message ${"s".repeat(400)}`;

const user = (content, extra = {}) => ({ userInputMessage: { content, modelId: "m", ...extra } });
const assistant = (content, extra = {}) => ({ assistantResponseMessage: { content, ...extra } });

// The Kiro body of turn `n` of one chat: n-1 finished exchanges, then the newest user message.
function turn(n, { opening = OPENING, tag = "", model = "m" } = {}) {
  const say = (k) => (k === 1 ? opening : `${tag}user ${k}`);
  const history = [];
  for (let k = 1; k < n; k++) history.push(user(say(k), { modelId: model }), assistant(`${tag}reply ${k}`));
  return { conversationState: { history, currentMessage: user(say(n), { modelId: model }) } };
}

const ctx = (body, scope = "conn-1") => buildKiroCacheContext(body, scope);
// Prompt sizes of a chat that grows 6.6k tokens a turn, as in the live measurement.
const promptOf = (n) => 9000 + (n - 1) * 6600;

// Sends turns `from`..`to` of a chat a second apart; returns the estimate of each.
function runChat(from, to, options = {}) {
  const out = {};
  for (let n = from; n <= to; n++) {
    vi.advanceTimersByTime(1000);
    out[n] = estimateKiroCachedTokens(ctx(turn(n, options), options.scope), promptOf(n));
  }
  return out;
}

describe("buildKiroCacheContext", () => {
  it("returns null without a current message", () => {
    expect(buildKiroCacheContext({})).toBeNull();
    expect(buildKiroCacheContext(null)).toBeNull();
  });

  it("gives a history message the same hash as the request it was current in", () => {
    const earlier = ctx(turn(1));
    const later = ctx(turn(2));
    expect(later.prefixHashes[0]).toBe(earlier.requestHash);
  });

  it("ignores request metadata and reasoning that change once a message is history", () => {
    const sent = { conversationState: { history: [], currentMessage: user(OPENING, {
      origin: "AI_EDITOR", userInputMessageContext: { tools: [{ toolSpecification: { name: "Read" } }] },
    }) } };
    const replayed = { conversationState: { history: [
      { userInputMessage: { content: OPENING } },
      assistant("reply 1", { reasoningContent: { reasoningText: { text: "hmm", signature: "sig" } } }),
    ], currentMessage: user("user 2") } };
    expect(ctx(replayed).prefixHashes[0]).toBe(ctx(sent).requestHash);
  });

  it("separates connections and models", () => {
    const base = ctx(turn(1)).requestHash;
    expect(ctx(turn(1), "conn-2").requestHash).not.toBe(base);
    expect(ctx(turn(1, { model: "m2" })).requestHash).not.toBe(base);
  });
});

describe("estimateKiroCachedTokens", () => {
  beforeEach(() => {
    resetKiroCacheEstimator();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T22:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("bills the newest three turns in full, as measured on Kiro", () => {
    const cached = runChat(1, 7);
    expect([cached[1], cached[2], cached[3]]).toEqual([0, 0, 0]);
    expect(cached[4]).toBe(promptOf(1));
    expect(cached[5]).toBe(promptOf(2));
    expect(cached[7]).toBe(promptOf(4));
  });

  it("falls back to an older request when the one three turns back was not seen", () => {
    runChat(1, 2);
    vi.advanceTimersByTime(1000);
    expect(estimateKiroCachedTokens(ctx(turn(6)), promptOf(6))).toBe(promptOf(2));
  });

  it("counts nothing once an earlier message changed", () => {
    runChat(1, 3);
    const edited = turn(5);
    edited.conversationState.history[0] = user(`[Context: Current time is 2026-11-05T21:59:00.000Z]\n\n${OPENING}`);
    expect(estimateKiroCachedTokens(ctx(edited), promptOf(5))).toBe(0);
  });

  it("serves an exact repeat whole", () => {
    runChat(1, 3);
    vi.advanceTimersByTime(1000);
    expect(estimateKiroCachedTokens(ctx(turn(3)), promptOf(3))).toBe(promptOf(3));
  });

  it("never counts a request that was still in flight when this one started", () => {
    // Two subagents with the same opening, sent together (the hub's parallel pairs).
    const a = ctx(turn(1, { tag: "a" }));
    const b = ctx(turn(1, { tag: "b" }));
    expect(estimateKiroCachedTokens(a, 18000)).toBe(0);
    expect(estimateKiroCachedTokens(b, 18200)).toBe(0);
  });

  it("lets chats that share an opening share only that opening", () => {
    runChat(1, 4, { tag: "a" });
    vi.advanceTimersByTime(1000);
    // Chat b's turn 4 continues chat a's turn 1 (same opening), nothing more.
    expect(estimateKiroCachedTokens(ctx(turn(4, { tag: "b" })), promptOf(4))).toBe(promptOf(1));
  });

  it("keeps connections apart", () => {
    runChat(1, 3, { scope: "conn-1" });
    vi.advanceTimersByTime(1000);
    expect(estimateKiroCachedTokens(ctx(turn(4), "conn-2"), promptOf(4))).toBe(0);
  });

  it("caps the estimate at this request's prompt", () => {
    estimateKiroCachedTokens(ctx(turn(1)), 50000);
    vi.advanceTimersByTime(1000);
    expect(estimateKiroCachedTokens(ctx(turn(1)), 40000)).toBe(40000);
  });

  it("returns 0 without context or prompt tokens", () => {
    expect(estimateKiroCachedTokens(null, 20000)).toBe(0);
    expect(estimateKiroCachedTokens(ctx(turn(1)), 0)).toBe(0);
    expect(estimateKiroCachedTokens(ctx(turn(1)), undefined)).toBe(0);
  });

  describe("cache lifetime", () => {
    it("drops a prefix idle for more than five minutes", () => {
      runChat(1, 3);
      vi.advanceTimersByTime(6 * MIN);
      expect(estimateKiroCachedTokens(ctx(turn(4)), promptOf(4))).toBe(0);
    });

    it("lets a hit extend the lifetime", () => {
      estimateKiroCachedTokens(ctx(turn(1)), promptOf(1));
      vi.advanceTimersByTime(4 * MIN);
      expect(estimateKiroCachedTokens(ctx(turn(4)), promptOf(4))).toBe(promptOf(1));
      vi.advanceTimersByTime(4 * MIN);
      expect(estimateKiroCachedTokens(ctx(turn(5)), promptOf(5))).toBe(promptOf(1));
    });
  });
});
