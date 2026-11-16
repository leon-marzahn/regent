import { describe, it, expect } from "vite-plus/test";
import { pickRegentHeaders, extractRequestConfig } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { __test__ } from "../../src/lib/db/repos/requestDetailsRepo.js";

describe("regent headers in request detail", () => {
  it("keeps only x-regent-* / x-9router-* headers", () => {
    const h = pickRegentHeaders({ Authorization: "Bearer x", "X-Regent-Pipeline": "a", "x-9router-token-saver": "off", accept: "*/*" });
    expect(h).toEqual({ "x-regent-pipeline": "a", "x-9router-token-saver": "off" });
  });
  it("adds them to the stored request only when present", () => {
    expect(extractRequestConfig({ messages: [] }, false).regentHeaders).toBeUndefined();
    expect(extractRequestConfig({ messages: [] }, false, { "x-regent-time": "1" }).regentHeaders).toEqual({ "x-regent-time": "1" });
  });
  it("survives truncation of a large stored request", () => {
    const request = { messages: [{ role: "user", content: "x".repeat(2000) }], regentHeaders: { "x-regent-pipeline": "a" } };
    const stored = __test__.truncateRequest(request, 100);
    expect(stored._truncated).toBe(true);
    expect(stored.regentHeaders).toEqual({ "x-regent-pipeline": "a" });
    expect(__test__.truncateRequest({ messages: [] }, 100)).toEqual({ messages: [] });
  });
});
