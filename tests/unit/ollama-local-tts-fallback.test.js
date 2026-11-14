// Ollama Local TTS adapter: phonon model 404 → installed-tag discovery or the
// built-in alternate, voice "not found" 400 → retry with the default voice, and
// the connection-refused message.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import adapter from "../../open-sse/handlers/ttsProviders/ollamaLocal.js";

const HOST = "http://localhost:11434";
const originalFetch = global.fetch;

const audio = () =>
  new Response(Buffer.alloc(200, 1), { status: 200, headers: { "Content-Type": "audio/wav" } });
const status = (code, text = "") => new Response(text, { status: code });
const sentBody = (call) => JSON.parse(call[1].body);

describe("ollamaLocal TTS fallbacks", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("on a phonon 404, retries with an installed phonon tag from /api/tags", async () => {
    global.fetch
      .mockResolvedValueOnce(status(404))
      .mockResolvedValueOnce(Response.json({ models: [{ name: "llama3" }, { model: "phonon:latest" }, { name: "phonon:multilingual" }] }))
      .mockResolvedValueOnce(audio());

    const result = await adapter.synthesize("hi", "phonon:multilingual/zoey", null, "mp3");

    expect(result.format).toBe("wav");
    expect(global.fetch.mock.calls[1][0]).toBe(`${HOST}/api/tags`);
    const retry = sentBody(global.fetch.mock.calls[2]);
    expect(retry).toMatchObject({ model: "phonon:latest", voice: "zoey", input: "hi" });
  });

  it("without installed tags, falls back phonon → phonon:multilingual", async () => {
    global.fetch
      .mockResolvedValueOnce(status(404))
      .mockResolvedValueOnce(status(500))
      .mockResolvedValueOnce(audio());

    await adapter.synthesize("hi", "phonon", null);
    expect(sentBody(global.fetch.mock.calls[2]).model).toBe("phonon:multilingual");
  });

  it("does not retry an unknown phonon tag with no alternate and surfaces the 404", async () => {
    global.fetch
      .mockResolvedValueOnce(status(404, JSON.stringify({ error: { message: "model 'phonon:custom' not found" } })))
      .mockResolvedValueOnce(Response.json({ models: [] }));

    await expect(adapter.synthesize("hi", "phonon:custom", null)).rejects.toThrow("model 'phonon:custom' not found");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("after the alternate model rejects the voice, retries that model with the default voice", async () => {
    global.fetch
      .mockResolvedValueOnce(status(404))
      .mockResolvedValueOnce(status(404))
      .mockResolvedValueOnce(status(400, "voice 'zoey' not found"))
      .mockResolvedValueOnce(audio());

    const result = await adapter.synthesize("hi", "phonon:multilingual/zoey", { apiKey: "k" }, "pcm");

    expect(result.base64).toBeTruthy();
    expect(sentBody(global.fetch.mock.calls[2])).toMatchObject({ model: "phonon:latest", voice: "zoey", response_format: "pcm" });
    expect(sentBody(global.fetch.mock.calls[3])).toMatchObject({ model: "phonon:latest", voice: "default" });
    expect(global.fetch.mock.calls[3][1].headers.Authorization).toBe("Bearer k");
  });

  it("retries with the default voice when the checkpoint lacks the requested voice", async () => {
    global.fetch.mockResolvedValueOnce(status(400, "voice freya not found")).mockResolvedValueOnce(audio());

    await adapter.synthesize("hi", "freya", null);
    expect(sentBody(global.fetch.mock.calls[0])).toMatchObject({ model: "phonon:multilingual", voice: "freya" });
    expect(sentBody(global.fetch.mock.calls[1])).toMatchObject({ model: "phonon:multilingual", voice: "default" });
  });

  it("surfaces a non-voice 400 without retrying", async () => {
    global.fetch.mockResolvedValueOnce(status(400, "input too long"));
    await expect(adapter.synthesize("hi", "freya", null)).rejects.toThrow("input too long");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("turns a refused connection into an actionable message naming the host", async () => {
    global.fetch.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    const creds = { providerSpecificData: { baseUrl: "http://gpu-box:11434/v1/" } };
    await expect(adapter.synthesize("hi", "phonon", creds)).rejects.toThrow(
      "Cannot connect to Ollama at http://gpu-box:11434. Please ensure Ollama is running"
    );
  });

  it("rethrows other fetch errors unchanged", async () => {
    global.fetch.mockRejectedValueOnce(new Error("boom"));
    await expect(adapter.synthesize("hi", "phonon", null)).rejects.toThrow("boom");
  });
});
