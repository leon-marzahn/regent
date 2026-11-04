import { describe, it, expect } from "vite-plus/test";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { buildKiroAdditionalModelRequestFieldsForModel } from "../../open-sse/config/kiroConstants.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("getThinkingLevels for Kiro", () => {
  it("does not advertise native intensity for legacy Kiro models", () => {
    expect(getThinkingLevels("kiro", "claude-sonnet-4.5")).toBeNull();
    expect(getThinkingLevels("kiro", "glm-5")).toBeNull();
  });

  it("advertises native levels for supported Kiro models", () => {
    expect(getThinkingLevels("kiro", "claude-sonnet-5")).toContain("high");
    expect(getThinkingLevels("kiro", "claude-sonnet-5")).toContain("xhigh");
    expect(getThinkingLevels("kiro", "claude-sonnet-5")).toContain("max");
    expect(getThinkingLevels("kiro", "gpt-5.6-sol")).toContain("xhigh");
  });

  it("omits xhigh on 4.6 models (upstream rejects it there)", () => {
    for (const model of ["claude-opus-4.6", "claude-opus-4-6", "claude-sonnet-4.6"]) {
      expect(getThinkingLevels("kiro", model)).not.toContain("xhigh");
      expect(getThinkingLevels("kiro", model)).toContain("max");
    }
  });

  it("passes xhigh/max through on the wire for 4.7+, clamps xhigh on 4.6", () => {
    const xhigh = { output_config: { effort: "xhigh" } };
    expect(buildKiroAdditionalModelRequestFieldsForModel(xhigh, "claude-sonnet-5")?.output_config?.effort).toBe("xhigh");
    expect(buildKiroAdditionalModelRequestFieldsForModel({ output_config: { effort: "max" } }, "claude-opus-4.6")?.output_config?.effort).toBe("max");
    expect(buildKiroAdditionalModelRequestFieldsForModel(xhigh, "claude-opus-4.6")?.output_config?.effort).toBe("high");
    // Anthropic-wire path: suffix override sends real xhigh on 4.7+, high on 4.6.
    expect(applyThinking("claude", "claude-opus-5.5(xhigh)", { messages: [] }, "claude").output_config?.effort).toBe("xhigh");
    expect(applyThinking("claude", "claude-opus-4.6(xhigh)", { messages: [] }, "claude").output_config?.effort).toBe("high");
  });

  // Kiro only accepts thinking.type "adaptive" (400 on "disabled"), so "off" clamps to low
  // instead of omitting the fields and getting Kiro's default effort.
  it.each([
    ["reasoning_effort none", { reasoning_effort: "none" }],
    ["reasoning.effort off", { reasoning: { effort: "off" } }],
    ["output_config.effort minimal", { output_config: { effort: "minimal" } }],
    ["Claude thinking disabled", { thinking: { type: "disabled" } }],
    ["thinking disabled beats an effort", { thinking: { type: "disabled" }, output_config: { effort: "high" } }],
  ])("clamps %s to adaptive low", (_, body) => {
    expect(buildKiroAdditionalModelRequestFieldsForModel(body, "claude-opus-5.5")).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "low" },
    });
  });

  it("still omits the fields when the client asks nothing", () => {
    expect(buildKiroAdditionalModelRequestFieldsForModel({}, "claude-opus-5.5")).toBeUndefined();
  });

  it("does not send effort fields to legacy 4.5 models even when off is asked", () => {
    expect(buildKiroAdditionalModelRequestFieldsForModel({ reasoning_effort: "none" }, "claude-sonnet-4.5")).toBeUndefined();
  });
});
