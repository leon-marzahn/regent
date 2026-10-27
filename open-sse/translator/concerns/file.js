// OpenAI `file` content parts carrying text (txt, md, json, csv, code…) for
// targets with no text-document block (Kiro, Claude): decode and inline them.
import { parseDataUri } from "./image.js";

const TEXT_MIME_RE = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|x-sh|csv|x-ndjson|sql|toml))|\+(json|xml)$/;

// Inline text for an OpenAI file part, or null when it isn't a text file
// (PDFs/binaries are left to each target's own document handling).
export function fileTextPart(part) {
  const file = part?.file;
  const data = file?.file_data;
  if (typeof data !== "string" || !data) return null;
  const parsed = parseDataUri(data);
  const mime = parsed?.mimeType || "";
  if (mime && !TEXT_MIME_RE.test(mime)) return null;
  let text;
  try {
    text = Buffer.from(parsed ? parsed.base64 : data, "base64").toString("utf8");
  } catch {
    return null;
  }
  // No mime given: only accept payloads that decode as clean text.
  if (!mime && (text.includes("\0") || text.includes("�"))) return null;
  const name = typeof file.filename === "string" && file.filename ? ` name="${file.filename.replace(/"/g, "'")}"` : "";
  return `<file${name}>\n${text}\n</file>`;
}
