// Prompt caching on Claude OAuth for clients other than Claude Code (translated path).
// Anthropic reads the cache only when tools + system stay byte-identical across a
// conversation's requests, and the system prompt is only cached if a block carries
// a cache_control marker.
import { describe, it, expect } from "vite-plus/test";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const creds = () => ({ accessToken: "sk-ant-oat01-test", rawHeaders: {} });
const tools = [{ name: "run", description: "run", input_schema: { type: "object", properties: {} } }];
const turn1 = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
const turn2 = [
  ...turn1,
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "run", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
];

const fromClaude = (messages) =>
  translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, "claude-opus-5-5",
    structuredClone({ model: "x", max_tokens: 1024, stream: true, system: "be brief", tools, messages }),
    true, creds(), "claude", null, [], "conn1", null);

const fromOpenAI = (messages) =>
  translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-opus-5-5",
    { model: "x", stream: true, messages }, true, creds(), "claude", null, [], "conn1", null);

const prefix = (body) => JSON.stringify({ tools: body.tools, system: body.system });

describe("Claude OAuth cache prefix", () => {
  it("keeps tools + system identical across turns (Claude-format client)", () => {
    expect(prefix(fromClaude(turn2))).toBe(prefix(fromClaude(turn1)));
  });

  it("keeps tools + system identical across turns (OpenAI-format client)", () => {
    const sys = { role: "system", content: "be brief" };
    const user = { role: "user", content: "hello" };
    const t1 = fromOpenAI([sys, user]);
    const t2 = fromOpenAI([sys, user, { role: "assistant", content: "hi" }, { role: "user", content: "more" }]);
    expect(prefix(t2)).toBe(prefix(t1));
  });

  it("puts a 1h cache marker on the system prompt when the client sent it as a string", () => {
    const { system } = fromClaude(turn1);
    expect(system.at(-1)).toMatchObject({ text: "be brief", cache_control: { type: "ephemeral", ttl: "1h" } });
  });
});
