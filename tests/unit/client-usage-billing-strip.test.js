// Upstream billing data (OpenRouter's usage.cost / is_byok / cost_details) must
// never reach the client, in any client format, streamed or not: the client's
// usage holds only the fields filterUsageForFormat allows. The usage regent
// records keeps the upstream's full counts.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { fetchMock, saveRequestUsage } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage,
  trackPendingRequest: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: fetchMock,
  proxyAwareFetch: fetchMock,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { stripClientUsage } = await import("../../open-sse/utils/usageTracking.js");

const MODEL = "anthropic/claude-opus-5.5";
const BILLING = { cost: 0.0005, is_byok: true, cost_details: { upstream_inference_cost: 0.01 } };
const USAGE = { prompt_tokens: 5000, completion_tokens: 3, total_tokens: 5003, ...BILLING };
const LEAK = /"cost"\s*:|is_byok|cost_details|upstream_inference_cost/;
const base = {
  id: "chatcmpl-fake-0001",
  object: "chat.completion.chunk",
  created: 1700000000,
  model: MODEL,
};

// OpenRouter-shaped upstream: usage (with its billing fields) on the include_usage
// trailer when streaming, on the body otherwise.
function openRouterUpstream(_url, init) {
  const body = JSON.parse(init.body);
  if (!body.stream) {
    return Response.json({
      ...base,
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: USAGE,
    });
  }
  const chunks = [
    {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { ...base, choices: [], usage: USAGE },
  ];
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

const CLIENTS = {
  openai: {
    endpoint: "/v1/chat/completions",
    body: (stream) => ({
      model: MODEL,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      messages: [{ role: "user", content: "hi" }],
    }),
  },
  claude: {
    endpoint: "/v1/messages",
    body: (stream) => ({
      model: MODEL,
      stream,
      max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
    }),
  },
  responses: {
    endpoint: "/v1/responses",
    body: (stream) => ({
      model: MODEL,
      stream,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  },
  gemini: {
    endpoint: "/v1beta/models/x:streamGenerateContent",
    body: () => ({ model: MODEL, contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
  },
};

async function run({ client, stream, provider = "openrouter" }) {
  const c = CLIENTS[client];
  const body = c.body(stream);
  const result = await handleChatCore({
    body,
    modelInfo: { provider, model: MODEL },
    credentials: { apiKey: "sk-test-fake" },
    clientRawRequest: { endpoint: c.endpoint, body, headers: {} },
    connectionId: "conn-test",
    apiKey: "sk-client-test",
  });
  expect(result.success).toBe(true);
  const text = await result.response.text();
  await new Promise((r) => setTimeout(r, 0));
  return text;
}

const recorded = () => saveRequestUsage.mock.calls.at(-1)[0].tokens;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(openRouterUpstream);
  saveRequestUsage.mockClear();
});

describe("OpenRouter billing fields never reach the client", () => {
  it("OpenAI stream with include_usage: the trailer carries tokens only", async () => {
    const text = await run({ client: "openai", stream: true });
    expect(text).not.toMatch(LEAK);
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)));
    const trailers = events.filter((e) => Array.isArray(e.choices) && e.choices.length === 0);
    expect(trailers).toHaveLength(1);
    expect(trailers[0].usage).toEqual({
      prompt_tokens: 5000,
      completion_tokens: 3,
      total_tokens: 5003,
    });
    // Recording still sees the upstream's real counts and its billed cost (BYOK: fee + upstream).
    expect(recorded()).toMatchObject({ prompt_tokens: 5000, completion_tokens: 3 });
    expect(recorded().cost_usd).toBeCloseTo(0.0105, 10);
  });

  it.each([
    ["openai", true],
    ["openai", false],
    ["claude", true],
    ["claude", false],
    ["responses", true],
    ["responses", false],
    ["gemini", true],
  ])("%s client, stream=%s", async (client, stream) => {
    const text = await run({ client, stream });
    expect(text).not.toMatch(LEAK);
    expect(recorded()).toMatchObject({ prompt_tokens: 5000, completion_tokens: 3 });
  });

  it("OpenAI stream whose trailer is an unterminated last line (flushed tail)", async () => {
    fetchMock.mockImplementation(() => {
      const chunks = [
        {
          ...base,
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      const text =
        chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
        `data: ${JSON.stringify({ ...base, choices: [], usage: USAGE })}`;
      return new Response(text, { headers: { "content-type": "text/event-stream" } });
    });
    const text = await run({ client: "openai", stream: true });
    expect(text).not.toMatch(LEAK);
    expect(text).toContain(
      '"usage":{"prompt_tokens":5000,"completion_tokens":3,"total_tokens":5003}',
    );
    expect(recorded()).toMatchObject({ prompt_tokens: 5000, completion_tokens: 3 });
  });

  it("forced-stream upstream answering a non-streaming OpenAI client", async () => {
    // `openai` is forceStream: the upstream SSE is folded into one JSON body.
    const text = await run({ client: "openai", stream: false, provider: "openai" });
    expect(text).not.toMatch(LEAK);
    expect(JSON.parse(text).usage).toEqual({
      prompt_tokens: 5000,
      completion_tokens: 3,
      total_tokens: 5003,
    });
    expect(recorded()).toMatchObject({ prompt_tokens: 5000, completion_tokens: 3 });
  });
});

describe("stripClientUsage", () => {
  it("filters each usage container by its own format and leaves clean chunks untouched", () => {
    const clean = {
      ...base,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    expect(stripClientUsage(clean)).toBe(clean);

    const original = { ...base, choices: [], usage: { ...USAGE } };
    const stripped = stripClientUsage(original);
    expect(stripped.usage).toEqual({
      prompt_tokens: 5000,
      completion_tokens: 3,
      total_tokens: 5003,
    });
    expect(original.usage.cost).toBe(0.0005); // not mutated: recording may still hold it

    expect(
      stripClientUsage({
        type: "message_start",
        message: { usage: { input_tokens: 4, output_tokens: 1, ...BILLING } },
      }).message.usage,
    ).toEqual({ input_tokens: 4, output_tokens: 1 });
    expect(
      stripClientUsage({ type: "message_delta", usage: { output_tokens: 9, ...BILLING } }).usage,
    ).toEqual({ output_tokens: 9 });
    expect(
      stripClientUsage({
        type: "response.completed",
        response: { usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5, ...BILLING } },
      }).response.usage,
    ).toEqual({ input_tokens: 4, output_tokens: 1, total_tokens: 5 });
    expect(
      stripClientUsage({
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 1,
          totalTokenCount: 5,
          ...BILLING,
        },
      }).usageMetadata,
    ).toEqual({ promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 });
    expect(
      stripClientUsage({ response: { usageMetadata: { promptTokenCount: 4, ...BILLING } } })
        .response.usageMetadata,
    ).toEqual({ promptTokenCount: 4 });
  });
});
