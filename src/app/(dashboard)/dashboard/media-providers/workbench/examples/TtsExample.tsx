"use client";

import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  IconButton,
  Input,
  SearchInput,
  Segmented,
  Tag,
  cn,
  inputClass,
  Select,
} from "@/ui";
import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { TTS_PROVIDER_CONFIG } from "@/shared/constants/ttsProviders";
import { translate } from "@/i18n/runtime";
import { getTtsVoicesForModel } from "open-sse/config/ttsModels.js";
import { GOOGLE_TTS_LANGUAGES } from "open-sse/config/googleTtsLanguages.js";
import {
  DownloadLink,
  EndpointRow,
  ErrorNote,
  ExamplePanel,
  KeyRow,
  RequestBlock,
  ResponseBlock,
  Row,
  authHeaders,
  errorText,
  maskB64,
  now,
  useExampleEnv,
} from "./shared";

interface TtsConfig {
  hasLanguageDropdown?: boolean;
  hasModelSelector?: boolean;
  hasBrowseButton?: boolean;
  hasVoiceIdInput?: boolean;
  hasLanguageHint?: boolean;
  hasStyleInput?: boolean;
  voicesPerModel?: boolean;
  voiceSource?: "hardcoded" | "api-language" | "manual" | "config";
  modelKey?: string;
  voiceKey?: string;
  apiEndpoint?: string;
  defaultVoiceId?: string;
  languageOptions?: (string | { id: string; name: string })[];
  defaultFormat?: string;
  formatOptions?: { value: string; label: string }[];
}
interface Voice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
  free_users_allowed?: boolean;
}
interface Language {
  code: string;
  name: string;
  voices: Voice[];
}
type Model = { id: string; name?: string };

const CONFIGS = TTS_PROVIDER_CONFIG as Record<string, TtsConfig>;
const PROVIDERS = AI_PROVIDERS as Record<string, { ttsConfig?: { models?: { id: string }[] } }>;
const ttsModelsOf = (id: string) =>
  (getModelsByProviderId(id) as Model[]).filter((m) => getModelKind(m) === "tts") as Voice[];
const voicesFor = (providerId: string, model: string) =>
  (getTtsVoicesForModel(providerId, model) || []) as Voice[];

const DEFAULT_FORMATS = [
  { value: "mp3", label: "MP3 file" },
  { value: "json", label: "JSON (base64)" },
];

/** Wrap raw 16-bit PCM (Ollama's `pcm` output) in a WAV header so `<audio>` can play it. */
function pcmToWav(pcm: ArrayBuffer, sampleRate = 24000, channels = 1): Blob {
  const blockAlign = channels * 2;
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm));
  return new Blob([buffer], { type: "audio/wav" });
}

const PLACEHOLDER = `// Audio plays here after running.
// With JSON output the response looks like:
{
  "format": "mp3",
  "audio": "//NExAANaAIIAUAAANNNNNNNN..." // base64 MP3
}`;

export function TtsExample({ providerId }: { providerId: string }) {
  const alias = getProviderAlias(providerId) as string;
  const config = CONFIGS[providerId] || CONFIGS["edge-tts"];
  const env = useExampleEnv();

  const [voice, setVoice] = useState(config.defaultVoiceId || "");
  const [voiceId, setVoiceId] = useState(config.defaultVoiceId || ""); // editable id (ElevenLabs etc.)
  const [voices, setVoices] = useState<Voice[]>([]);
  const [lang, setLang] = useState("");
  const [model, setModel] = useState(() => {
    const cfgModels = PROVIDERS[providerId]?.ttsConfig?.models;
    if (cfgModels?.length) return cfgModels[0].id;
    if (config.hasModelSelector && config.modelKey)
      return (getModelsByProviderId(config.modelKey) as Model[])?.[0]?.id || "";
    return "";
  });
  const [input, setInput] = useState("Hello, this is a text to speech test.");
  const [style, setStyle] = useState("");
  const [languageHint, setLanguageHint] = useState("");
  const formatOptions = config.formatOptions || DEFAULT_FORMATS;
  const [format, setFormat] = useState(config.defaultFormat || formatOptions[0].value);
  const [audioUrl, setAudioUrl] = useState("");
  // Raw PCM is wrapped in a WAV header to play, but downloads as the bytes the API sent
  const [downloadUrl, setDownloadUrl] = useState("");
  const [json, setJson] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [latency, setLatency] = useState<number | null>(null);
  const [connectionCount, setConnectionCount] = useState(0);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [byLang, setByLang] = useState<Record<string, Language>>({});
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");

  useEffect(() => {
    fetch("/api/providers", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { connections: [] }))
      .then((d: { connections?: { provider: string; isActive?: boolean }[] }) =>
        setConnectionCount(
          (d.connections || []).filter((c) => c.provider === providerId && c.isActive !== false)
            .length,
        ),
      )
      .catch(() => {
        /* only used for the key hint */
      });

    // Hardcoded voices are preselected; api-language providers wait for a language pick.
    if (config.voiceSource !== "hardcoded") return;
    const defaultModel = model;
    const list =
      config.voicesPerModel && defaultModel
        ? voicesFor(providerId, defaultModel)
        : ttsModelsOf(config.voiceKey || providerId);
    if (!list.length) return;
    if (config.hasBrowseButton) {
      // Google TTS: English by default, shown as a single chip
      const v = list.find((x) => x.id === "en") || list[0];
      setLang(v.id);
      setVoice(v.id);
      setVoices([{ id: v.id, name: v.name }]);
    } else {
      setVoices(list);
      setVoice(list[0].id);
      if (config.hasVoiceIdInput) setVoiceId(list[0].id);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- config derives from providerId
  }, [providerId]);

  // Providers with per-model voices: refresh the chips when the model changes
  useEffect(() => {
    if (!config.voicesPerModel || !model) return;
    const list = voicesFor(providerId, model);
    setVoices(list);
    // A model without preset voices (voicedesign/voiceclone) drops the stale voice
    setVoice(list[0]?.id ?? "");
    // The typed voice id follows too, so a checkpoint without the old voice doesn't keep it
    if (config.hasVoiceIdInput && list[0]) setVoiceId(list[0].id);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- config derives from providerId
  }, [model]);

  useEffect(
    () => () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    },
    [audioUrl],
  );
  useEffect(
    () => () => {
      if (downloadUrl && downloadUrl !== audioUrl) URL.revokeObjectURL(downloadUrl);
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- revoke only when the download changes
    [downloadUrl],
  );

  const openPicker = async () => {
    setPickerOpen(true);
    setPickerError("");
    if (languages.length) return;
    setPickerLoading(true);
    try {
      if (config.voiceSource === "hardcoded") {
        const map: Record<string, Language> = {};
        for (const v of ttsModelsOf(config.voiceKey || providerId))
          map[v.id] ??= { code: v.id, name: v.name, voices: [{ id: v.id, name: v.name }] };
        setByLang(map);
        setLanguages(Object.values(map).sort((a, b) => a.name.localeCompare(b.name)));
      } else {
        const url =
          config.apiEndpoint ||
          `/api/media-providers/tts/voices?provider=${providerId === "local-device" ? "local-device" : "edge-tts"}`;
        const r = await fetch(url);
        const d = (await r.json().catch(() => ({}))) as {
          error?: string;
          languages?: Language[];
          byLang?: Record<string, Language>;
        };
        if (!r.ok || d.error) {
          setPickerError(d.error || `Couldn't load voices (HTTP ${r.status})`);
          return;
        }
        setLanguages(d.languages || []);
        setByLang(d.byLang || {});
      }
    } catch (e) {
      setPickerError((e as Error).message || "Couldn't load voices");
    } finally {
      setPickerLoading(false);
    }
  };

  const pickLanguage = (l: Language) => {
    setPickerOpen(false);
    setLang(l.code);
    const list = byLang[l.code]?.voices || [];
    setVoices(list);
    if (list.length) {
      setVoice(list[0].id);
      if (config.hasVoiceIdInput) setVoiceId(list[0].id);
    }
  };

  const activeVoice = config.hasVoiceIdInput ? voiceId || voice : voice;
  const modelFull = (() => {
    if (providerId === "selfhosted-tts") {
      const m = model.trim();
      const v = activeVoice.trim();
      return m ? `${alias}/${m}${v ? `/${v}` : ""}` : "";
    }
    if (providerId === "ollama-local") {
      // "default" is the checkpoint's own voice: leave it off the path
      const m = (model || "phonon:multilingual").trim();
      const v = activeVoice.trim();
      return `${alias}/${m}${v && v !== "default" ? `/${v}` : ""}`;
    }
    if (config.hasModelSelector && model && activeVoice) return `${alias}/${model}/${activeVoice}`;
    if (config.hasModelSelector && model) return `${alias}/${model}`;
    if (activeVoice) return `${alias}/${activeVoice}`;
    return "";
  })();

  const body: Record<string, unknown> = { model: modelFull, input };
  if (config.hasLanguageHint && languageHint) body.language = languageHint;
  if (config.hasStyleInput && style.trim()) body.style = style.trim();
  // mp3 is the server default and json goes in the query; other formats ride in the body
  if (format !== "json" && format !== "mp3") body.response_format = format;
  const query = format === "json" ? "?response_format=json" : "";
  const ext =
    format === "pcm" ? "pcm" : format === "wav" || providerId === "ollama-local" ? "wav" : "mp3";

  const curl = (key: string) =>
    [
      `curl -X POST ${env.endpoint}/v1/audio/speech${query}`,
      `  -H "Content-Type: application/json"`,
      `  -H "Authorization: Bearer ${key}"`,
      `  -d '${JSON.stringify(body)}'`,
      format !== "json" && `  --output speech.${ext}`,
    ]
      .filter(Boolean)
      .join(" \\\n");

  const run = async () => {
    if (!input.trim() || !modelFull) return;
    setRunning(true);
    setError("");
    setAudioUrl("");
    setDownloadUrl("");
    setJson(null);
    setLatency(null);
    const start = now();
    try {
      const res = await fetch(`/api/v1/audio/speech${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(env) },
        body: JSON.stringify({ ...body, input: input.trim() }),
      });
      setLatency(now() - start);
      if (!res.ok) {
        setError(errorText(await res.json().catch(() => null), res.status));
        return;
      }
      if (format === "json") {
        const data = (await res.json()) as { format?: string; audio?: string };
        setJson(data);
        if (!data.audio) {
          setError("The response had no audio");
          return;
        }
        const blob = await fetch(`data:audio/${data.format || "mp3"};base64,${data.audio}`).then(
          (r) => r.blob(),
        );
        setAudioUrl(URL.createObjectURL(blob));
      } else if (format === "pcm") {
        const pcm = await res.arrayBuffer();
        setDownloadUrl(URL.createObjectURL(new Blob([pcm], { type: "audio/pcm" })));
        setAudioUrl(URL.createObjectURL(pcmToWav(pcm)));
      } else {
        setAudioUrl(URL.createObjectURL(await res.blob()));
      }
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  const modelOptions = (() => {
    const own = ttsModelsOf(providerId);
    return own.length ? own : (getModelsByProviderId(config.modelKey) as Model[]) || [];
  })();
  const showModelSelect =
    providerId !== "selfhosted-tts" &&
    config.hasModelSelector &&
    (!!config.modelKey || ttsModelsOf(providerId).length > 0);

  return (
    <ExamplePanel method="POST" path="/v1/audio/speech">
      <EndpointRow env={env} path="/v1/audio/speech" />
      <KeyRow
        env={env}
        fallback={
          connectionCount > 0
            ? `Uses the stored provider key${connectionCount > 1 ? `s (${connectionCount})` : ""}`
            : undefined
        }
      />
      {providerId === "selfhosted-tts" && (
        <Row label="Model">
          <Input
            mono
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. kokoro or Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16"
          />
        </Row>
      )}
      {showModelSelect && (
        <Row label="Model">
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))}
          </Select>
        </Row>
      )}
      {config.hasLanguageHint && (
        <Row label="Language">
          <Select value={languageHint} onChange={(e) => setLanguageHint(e.target.value)}>
            <option value="">Auto-detect</option>
            {(
              config.languageOptions || (GOOGLE_TTS_LANGUAGES as { id: string; name: string }[])
            ).map((l) =>
              typeof l === "string" ? (
                <option key={l} value={l}>
                  {l}
                </option>
              ) : (
                <option key={l.id} value={l.name}>
                  {l.name}
                </option>
              ),
            )}
          </Select>
        </Row>
      )}
      {config.hasBrowseButton && (
        <Row label="Language">
          <button
            type="button"
            onClick={() => void openPicker()}
            className={cn(inputClass, "flex items-center justify-between gap-2 text-left")}
          >
            <span className={cn("truncate", !lang && "text-text-subtle")}>
              {lang ? languages.find((l) => l.code === lang)?.name || lang : "Choose a language"}
            </span>
            <span className="shrink-0 text-xs text-text-muted">Browse</span>
          </button>
        </Row>
      )}
      {voices.length > 0 && (
        <Row label="Voice">
          <div className="flex flex-wrap gap-1.5">
            {voices.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={voice === v.id}
                onClick={() => {
                  setVoice(v.id);
                  if (config.hasVoiceIdInput) setVoiceId(v.id);
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                  voice === v.id
                    ? "border-accent-ring bg-accent-soft font-medium text-accent-text"
                    : "border-border text-text-muted hover:text-text",
                )}
              >
                {v.name}
                {v.language ? ` · ${v.language}` : ""}
                {v.gender ? ` · ${v.gender[0].toUpperCase()}` : ""}
                {v.free_users_allowed === true && <Tag tone="success">Free</Tag>}
                {v.free_users_allowed === false && <Tag tone="warning">Paid</Tag>}
              </button>
            ))}
          </div>
        </Row>
      )}
      {config.hasVoiceIdInput && (
        <Row label="Voice ID">
          <Input
            mono
            value={voiceId}
            onChange={(e) => {
              setVoiceId(e.target.value);
              setVoice(e.target.value);
            }}
            placeholder={
              providerId === "selfhosted-tts"
                ? "e.g. af_heart or vivian (optional)"
                : providerId === "ollama-local"
                  ? "e.g. Zoey, Easton, Freya, or default"
                  : "e.g. CwhRBWXzGAHq8TQ4Fs17"
            }
          />
        </Row>
      )}
      {config.hasLanguageDropdown && (
        <Row label="Language">
          <Select value={voice} onChange={(e) => setVoice(e.target.value)}>
            {ttsModelsOf(providerId).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))}
          </Select>
        </Row>
      )}
      <Row label="Input">
        <Input value={input} onChange={(e) => setInput(e.target.value)} />
      </Row>
      {config.hasStyleInput && (
        <Row label={translate("Style") as string}>
          <textarea
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            rows={2}
            placeholder={
              translate(
                "e.g. a warm, gentle voice, speaking slowly with a British accent",
              ) as string
            }
            className={cn(inputClass, "h-auto resize-none py-2")}
          />
        </Row>
      )}
      <Row label="Output">
        <Segmented value={format} onChange={setFormat} options={formatOptions} />
      </Row>
      <RequestBlock
        env={env}
        curl={curl}
        onRun={run}
        running={running}
        disabled={!input.trim() || !modelFull}
        runLabel="Speak"
        runningLabel="Generating…"
      />
      {!modelFull && (
        <p className="text-[11px] text-text-muted">
          {config.hasBrowseButton ? "Choose a language and voice to run." : "Pick a voice to run."}
        </p>
      )}
      <ErrorNote>{error}</ErrorNote>
      <ResponseBlock
        latencyMs={audioUrl ? latency : null}
        text={json ? JSON.stringify(maskB64(json), null, 2) : ""}
        placeholder={audioUrl ? undefined : PLACEHOLDER}
        action={
          audioUrl ? (
            <DownloadLink
              href={downloadUrl || audioUrl}
              filename={`speech.${format === "json" ? "mp3" : ext}`}
            />
          ) : null
        }
      >
        {audioUrl && <audio controls src={audioUrl} className="w-full" />}
      </ResponseBlock>

      {pickerOpen && (
        <LanguagePicker
          languages={languages}
          selected={lang}
          loading={pickerLoading}
          error={pickerError}
          onPick={pickLanguage}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </ExamplePanel>
  );
}

function LanguagePicker({
  languages,
  selected,
  loading,
  error,
  onPick,
  onClose,
}: {
  languages: Language[];
  selected: string;
  loading: boolean;
  error: string;
  onPick: (l: Language) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? languages.filter(
        (l) => l.name.toLowerCase().includes(needle) || l.code.toLowerCase().includes(needle),
      )
    : languages;
  return (
    <Dialog open onClose={onClose} title="Choose a language">
      <SearchInput
        data-autofocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search languages"
        aria-label="Search languages"
        className="mb-2"
      />
      <div className="-mx-3">
        {error && <p className="px-2 py-1 text-xs text-danger-text">{error}</p>}
        {loading ? (
          <p className="px-2 py-3 text-xs text-text-muted">Loading voices…</p>
        ) : (
          <>
            {shown.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => onPick(l)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-surface-2",
                  selected === l.code && "bg-accent-soft text-accent-text",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{l.name}</span>
                <span className="shrink-0 text-[11px] text-text-muted">
                  {l.voices.length} voices
                </span>
              </button>
            ))}
            {!error && shown.length === 0 && (
              <p className="px-2 py-3 text-xs text-text-muted">No languages match.</p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
