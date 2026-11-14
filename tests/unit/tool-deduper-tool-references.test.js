// dedupeTools: when a built-in tool is stripped (e.g. WebSearch because the Exa MCP
// is present), tool_reference blocks naming it are removed from tool_result content,
// since strict Claude-compatible upstreams reject a reference to a tool not in the request.
import { describe, it, expect } from "vite-plus/test";
import { dedupeTools } from "../../open-sse/utils/toolDeduper.js";

const MCP_EXA = { name: "mcp__exa__web_search_exa", description: "search" };
const WEB_SEARCH = { name: "WebSearch", description: "web" };
const WEB_FETCH = { name: "WebFetch", description: "web" };
const BASH = { name: "Bash", description: "shell" };

const ref = (tool_name) => ({ type: "tool_reference", tool_name });

describe("dedupeTools — stripped tool_reference cleanup", () => {
  it("drops references to stripped tools and keeps the rest", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [ref("WebSearch"), ref("Bash")] },
        ],
      },
    ];
    const { stripped } = dedupeTools([MCP_EXA, WEB_SEARCH, BASH], { clientTool: "claude", messages });
    expect(stripped).toEqual(["WebSearch"]);
    expect(messages[0].content[0].content).toEqual([ref("Bash")]);
  });

  it("replaces an all-stripped reference list with a text note instead of an empty array", () => {
    const messages = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [ref("WebSearch"), ref("WebFetch")] }] },
    ];
    dedupeTools([MCP_EXA, WEB_SEARCH, WEB_FETCH], { clientTool: "claude", messages });
    expect(messages[0].content[0].content).toEqual([
      { type: "text", text: "[Tool WebSearch is unavailable]\n[Tool WebFetch is unavailable]" },
    ]);
  });

  it("leaves string content, non-tool_result blocks and unrelated references untouched", () => {
    const messages = [
      { role: "user", content: "plain string" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "string result" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", content: [ref("Bash")] }] },
      null,
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));
    const { tools } = dedupeTools([MCP_EXA, WEB_SEARCH, BASH], { clientTool: "claude", messages });
    expect(tools.map((t) => t.name)).toEqual(["mcp__exa__web_search_exa", "Bash"]);
    expect(messages).toEqual(snapshot);
  });

  it("does not touch references when only DeepSeek duplicate names are dropped", () => {
    const messages = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [ref("Bash")] }] }];
    const { tools, stripped } = dedupeTools([BASH, { ...BASH }], { model: "deepseek-chat", messages });
    expect(tools).toHaveLength(1);
    expect(stripped).toEqual(["Bash"]);
    expect(messages[0].content[0].content).toEqual([ref("Bash")]);
  });
});
