// Same-format translation hands the client body back and edits it in place
// (thinking fields stripped, model set to the upstream id). The stored client
// request must still show what the client sent.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { executeMock, saveRequestDetailMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  saveRequestDetailMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  saveRequestDetail: saveRequestDetailMock,
}));

describe("stored client request after same-format translation", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockRejectedValue(new Error("boom"));
    saveRequestDetailMock.mockClear();
  });

  it("keeps the client's model and thinking fields", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const body = {
      model: "openai/gpt-4.1",
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hello" }],
    };
    await handleChatCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-4.1" },
      credentials: { apiKey: "sk-test" },
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
      connectionId: "test-connection",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(saveRequestDetailMock).toHaveBeenCalled();
    const { request } = saveRequestDetailMock.mock.calls.at(-1)[0];
    expect(request.model).toBe("openai/gpt-4.1");
    expect(request.reasoning_effort).toBe("high");
    expect(request.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});
