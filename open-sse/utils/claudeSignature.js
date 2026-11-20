// Claude thinking signature validation (ported from CLIProxyAPI internal/signature).
// E-form: single-layer base64, decoded[0] == 0x12 (Claude marker).
// R-form: double-layer base64, outer decoded[0] == 'E', inner decoded[0] == 0x12.
// C-form (current Claude models, all of them by 2026-11): the E-form message behind a
// version field, decoded = 0x08 <varint version> 0x12 …, so base64 starts with "C".
// Gemini's thought signatures also start with "C" but open with 0x0a, not 0x08.
// Cache prefix "...#sig" stripped before validation.

const MAX_CLAUDE_SIGNATURE_LEN = 32 * 1024 * 1024;
const CLAUDE_SIGNATURE_MARKER = 0x12;

function stripCachePrefix(rawSignature) {
  const sig = (rawSignature || "").trim();
  if (!sig) return "";
  const idx = sig.indexOf("#");
  return idx >= 0 ? sig.slice(idx + 1).trim() : sig;
}

// 0x08 <varint> 0x12: field 1 (version) then the E-form's field 2.
function isVersionedClaudeSignature(decoded) {
  if (decoded[0] !== 0x08) return false;
  let i = 1;
  while (i < decoded.length && i < 6 && decoded[i] & 0x80) i++;
  return decoded[i + 1] === CLAUDE_SIGNATURE_MARKER;
}

// Strict-ish: validates base64 layers + Claude marker byte.
export function isValidClaudeSignature(rawSignature) {
  const sig = stripCachePrefix(rawSignature);
  if (!sig || sig.length > MAX_CLAUDE_SIGNATURE_LEN) return false;

  try {
    if (sig[0] === "E") {
      const decoded = Buffer.from(sig, "base64");
      return decoded.length > 0 && decoded[0] === CLAUDE_SIGNATURE_MARKER;
    }
    if (sig[0] === "R") {
      const outer = Buffer.from(sig, "base64");
      if (!outer.length || outer[0] !== 0x45) return false; // 'E'
      const inner = Buffer.from(outer.toString(), "base64");
      return inner.length > 0 && inner[0] === CLAUDE_SIGNATURE_MARKER;
    }
    if (sig[0] === "C") return isVersionedClaudeSignature(Buffer.from(sig, "base64"));
    return false;
  } catch {
    return false;
  }
}
