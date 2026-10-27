import { describe, it, expect } from "vite-plus/test";
import { fileTextPart } from "../../open-sse/translator/concerns/file.js";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";

const b64 = (s) => Buffer.from(s).toString("base64");
const textFile = { type: "file", file: { filename: "notes.txt", file_data: `data:text/plain;base64,${b64("hello world")}` } };
const body = { messages: [{ role: "user", content: [{ type: "text", text: "read this" }, textFile] }] };

describe("fileTextPart", () => {
  it("inlines a text data uri with its filename", () => {
    expect(fileTextPart(textFile)).toBe('<file name="notes.txt">\nhello world\n</file>');
  });

  it("accepts raw base64 that decodes to clean text", () => {
    expect(fileTextPart({ type: "file", file: { file_data: b64("# md") } })).toBe("<file>\n# md\n</file>");
  });

  it("skips pdfs and binary payloads", () => {
    expect(fileTextPart({ type: "file", file: { file_data: `data:application/pdf;base64,${b64("%PDF")}` } })).toBeNull();
    expect(fileTextPart({ type: "file", file: { file_data: Buffer.from([0, 0xff, 0xfe]).toString("base64") } })).toBeNull();
  });
});

describe("text file attachments reach the upstream", () => {
  it("openai -> kiro", () => {
    const out = openaiToKiroRequest("claude-sonnet-4.6", body, true, {});
    expect(out.conversationState.currentMessage.userInputMessage.content).toContain("hello world");
  });

  it("openai -> claude", () => {
    const out = openaiToClaudeRequest("claude-sonnet-4-6", body, true);
    const texts = out.messages[0].content.filter((b) => b.type === "text").map((b) => b.text);
    expect(texts.join("\n")).toContain("hello world");
  });
});
