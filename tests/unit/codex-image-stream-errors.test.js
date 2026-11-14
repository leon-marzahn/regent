// Codex image adapter (Responses-API path): errors carried inside the SSE stream
// — an image_generation_call without a result, or text instead of an image — are
// surfaced to the caller, both collected and when streamed to the client.
import { describe, it, expect, vi } from "vite-plus/test";
import adapter from "../../open-sse/handlers/imageProviders/codex.js";

const RESPONSES_BODY = { input: [{ type: "message" }] };

function sse(events) {
  const text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}

const parse = (response, opts = {}) => adapter.parseResponse(response, { requestBody: RESPONSES_BODY, ...opts });

async function readSse(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const [ev, data] = block.split("\n");
      return { event: ev.slice(7), data: JSON.parse(data.slice(6)) };
    });
}

describe("codex image adapter — in-stream errors", () => {
  it.each([
    ["error.message", { error: { message: "blocked by safety" } }, "blocked by safety"],
    ["response.error", { response: { error: { message: "nested failure" } } }, "nested failure"],
    ["item.error", { item: { error: { message: "inner item" } } }, "inner item"],
    ["status_details", { response: { status_details: { error: { message: "moderation" } } } }, "moderation"],
    ["string error", { error: "quota" }, "quota"],
    ["message", { message: "plain message" }, "plain message"],
  ])("throws the image_generation_call %s when it has no result", async (_label, extra, expected) => {
    const response = sse([["response.output_item.done", { item: { type: "image_generation_call", ...extra } }]]);
    await expect(parse(response)).rejects.toThrow(expected);
  });

  it("an image result later in the stream wins over an earlier item error", async () => {
    const response = sse([
      ["response.output_item.done", { item: { type: "image_generation_call", error: { message: "first try failed" } } }],
      ["response.completed", { response: { output: [{ type: "image_generation_call", result: "QUJD" }] } }],
    ]);
    const result = await parse(response);
    expect(result.data).toEqual([{ b64_json: "QUJD" }]);
  });

  it("reports streamed assistant text when no image came back", async () => {
    const response = sse([
      ["response.output_text.delta", { delta: "I can't " }],
      ["response.output_text.delta", { delta: "draw that." }],
    ]);
    await expect(parse(response)).rejects.toThrow('Codex returned text instead of an image: "I can\'t draw that."');
  });

  it("prefers the final message item text over the deltas", async () => {
    const response = sse([
      ["response.output_text.delta", { delta: "partial" }],
      ["response.output_item.done", { item: { type: "message", content: [{ type: "output_text", text: "Refused." }, "extra"] } }],
    ]);
    await expect(parse(response)).rejects.toThrow('instead of an image: "Refused. extra"');
  });

  it("falls back to the generic error when the failed image call carries no message", async () => {
    const response = sse([["response.output_item.done", { item: { type: "image_generation_call", status: "failed" } }]]);
    await expect(parse(response)).rejects.toThrow("Codex completed without an image");
  });

  it("throws the generic no-image error when the stream is empty", async () => {
    await expect(parse(sse([["response.created", {}]]))).rejects.toThrow("Codex completed without an image");
  });

  it("streams an error event (and skips success callbacks) when no image arrives", async () => {
    const onRequestSuccess = vi.fn();
    const onUsage = vi.fn();
    const response = sse([
      ["response.output_item.done", { item: { type: "image_generation_call", error: { message: "content policy" } } }],
      ["response.completed", { response: { usage: { input_tokens: 3, output_tokens: 4 } } }],
    ]);
    const { sseResponse } = await parse(response, { streamToClient: true, onRequestSuccess, onUsage });
    const events = await readSse(sseResponse);
    expect(events.at(-1)).toEqual({ event: "error", data: { message: "content policy" } });
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(onUsage).not.toHaveBeenCalled();
  });
});
