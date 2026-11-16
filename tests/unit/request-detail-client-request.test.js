import { describe, it, expect } from "vite-plus/test";
import { extractRequestConfig } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { __test__ } from "../../src/lib/db/repos/requestDetailsRepo.js";

// The Usage drawer shows the stored client request. Each wire format carries
// its prompt in different fields, so the stored request must keep them all.
describe("client request content in request detail", () => {
  it("keeps Responses input and instructions", () => {
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ];
    const config = extractRequestConfig(
      {
        model: "p/m",
        input,
        instructions: "be brief",
        max_output_tokens: 64,
        previous_response_id: "resp_1",
      },
      true,
    );
    expect(config.input).toEqual(input);
    expect(config.instructions).toBe("be brief");
    expect(config.max_output_tokens).toBe(64);
    expect(config.previous_response_id).toBe("resp_1");
    expect(config).not.toHaveProperty("messages");
  });

  it("keeps a string Responses input", () => {
    expect(extractRequestConfig({ model: "p/m", input: "hello" }, false).input).toBe("hello");
  });

  it("keeps Claude system alongside messages", () => {
    const system = [{ type: "text", text: "sys" }];
    const messages = [{ role: "user", content: "hi" }];
    const config = extractRequestConfig(
      { model: "p/m", system, messages, stop_sequences: ["X"] },
      true,
    );
    expect(config.system).toEqual(system);
    expect(config.messages).toEqual(messages);
    expect(config.stop_sequences).toEqual(["X"]);
  });

  it("keeps Gemini contents and systemInstruction", () => {
    const contents = [{ role: "user", parts: [{ text: "hi" }] }];
    const systemInstruction = { parts: [{ text: "sys" }] };
    const config = extractRequestConfig({ contents, systemInstruction }, false);
    expect(config.contents).toEqual(contents);
    expect(config.systemInstruction).toEqual(systemInstruction);
  });

  it("leaves chat completions unchanged", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(extractRequestConfig({ model: "p/m", messages, temperature: 0.2 }, false)).toEqual({
      model: "p/m",
      stream: false,
      messages,
      temperature: 0.2,
    });
  });

  it("does not copy fields outside the allow-list", () => {
    const config = extractRequestConfig(
      { model: "p/m", input: "hi", api_key: "sk-secret", authorization: "Bearer sk-secret" },
      false,
    );
    expect(JSON.stringify(config)).not.toContain("sk-secret");
  });

  it("truncates a large Responses request and keeps regent headers", () => {
    const body = {
      model: "p/m",
      instructions: "sys",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "x".repeat(72 * 1024) }],
        },
      ],
    };
    const config = extractRequestConfig(body, true, { "x-regent-pipeline": "a" });
    const stored = __test__.truncateRequest(config, 50 * 1024);
    expect(stored._truncated).toBe(true);
    expect(stored._originalSize).toBeGreaterThan(72 * 1024);
    expect(stored.regentHeaders).toEqual({ "x-regent-pipeline": "a" });
  });
});
