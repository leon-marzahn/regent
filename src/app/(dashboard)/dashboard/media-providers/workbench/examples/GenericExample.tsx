"use client";

import { useEffect, useState } from "react";
import { Icon, Input, Segmented, Select, Switch } from "@/ui";
import {
  AI_PROVIDERS,
  MEDIA_PROVIDER_KINDS,
  getProviderAlias,
  resolveProviderId,
} from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import type { Connection } from "../../../providers/model";
import { KIND_EXAMPLE_CONFIG, type ExtraField } from "./config";
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

type Model = { id: string; name?: string; capabilities?: string[]; params?: string[] };
type Kind = { id: string; endpoint: { method: string; path: string } };

const SAMPLE_IMAGE = "https://pub-1fb693cb11cc46b2b2f656f51e015a2c.r2.dev/dog.png";
const SAMPLE_MASK = "https://pub-1fb693cb11cc46b2b2f656f51e015a2c.r2.dev/dog-mask.png";
// Kinds whose request names a model (web search/fetch route by provider alone).
const NEEDS_MODEL = new Set(["image", "video", "music", "imageToText", "systemone"]);
const DEFAULT_QUESTION = "Does this request require urgent attention?";

// Edit-capable sample models need a source image; the public dog sample makes them runnable as-is.
function editDefaults(
  providerId: string,
  modelId: string,
): { image?: string; mask_image?: string } {
  if (providerId === "huggingface") return { image: SAMPLE_IMAGE };
  if (providerId !== "cloudflare-ai") return {};
  if (modelId === "@cf/runwayml/stable-diffusion-v1-5-img2img") return { image: SAMPLE_IMAGE };
  if (modelId === "@cf/runwayml/stable-diffusion-v1-5-inpainting")
    return { image: SAMPLE_IMAGE, mask_image: SAMPLE_MASK };
  return {};
}

function previewSrc(value: string): string {
  const v = value.trim();
  if (!v) return "";
  return /^(data:image\/|https?:\/\/)/i.test(v) ? v : `data:image/png;base64,${v}`;
}

type ImageItem = { b64_json?: string; url?: string };
const imageOf = (data: unknown): string => {
  const first = (data as { data?: ImageItem[] } | null)?.data?.[0];
  return first?.b64_json ? `data:image/png;base64,${first.b64_json}` : first?.url || "";
};

export function GenericExample({
  providerId,
  kind,
  connections,
}: {
  providerId: string;
  kind: string;
  /** This provider's connections, for pinning a test to one account. */
  connections: Connection[];
}) {
  const alias = getProviderAlias(providerId) as string;
  const safeAlias = resolveProviderId(alias) === providerId ? alias : providerId;
  const kindConfig = (MEDIA_PROVIDER_KINDS as Kind[]).find((k) => k.id === kind);
  const ex = KIND_EXAMPLE_CONFIG[kind];
  const models = (getModelsByProviderId(providerId) as Model[]).filter(
    (m) => getModelKind(m) === kind,
  );
  const needsModel = NEEDS_MODEL.has(kind);
  const manualModel = needsModel && models.length === 0;
  const env = useExampleEnv();

  const [model, setModel] = useState(models[0]?.id ?? "");
  const modelObj = models.find((m) => m.id === model);
  const supportsEdit = !!modelObj?.capabilities?.includes("edit");
  const supportsMask = !!modelObj?.capabilities?.includes("mask");
  const [input, setInput] = useState(ex?.defaultInput || "");
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [refImage, setRefImage] = useState("");
  const [maskImage, setMaskImage] = useState("");
  // Web fetch offers only the formats the provider's fetchConfig declares (Tavily has no HTML).
  const formats =
    kind === "webFetch"
      ? (AI_PROVIDERS as Record<string, { fetchConfig?: { formats?: string[] } }>)[providerId]
          ?.fetchConfig?.formats
      : undefined;
  const providerFormats = Array.isArray(formats) && formats.length > 0 ? formats : null;
  const extraFields: ExtraField[] = (ex?.extraFields || []).map((f) =>
    f.key === "format" && providerFormats
      ? {
          ...f,
          options: providerFormats,
          default: providerFormats.includes(String(f.default)) ? f.default : providerFormats[0],
        }
      : f,
  );
  const [picked, setExtra] = useState<Record<string, string | number | boolean>>(() =>
    Object.fromEntries(extraFields.map((f) => [f.key, f.default ?? ""])),
  );
  // A format the provider no longer offers falls back to its default.
  const extra =
    providerFormats && !providerFormats.includes(String(picked.format))
      ? { ...picked, format: extraFields.find((f) => f.key === "format")?.default ?? "" }
      : picked;
  const [output, setOutput] = useState<"json" | "binary">("json");
  const [pinned, setPinned] = useState("");
  const [result, setResult] = useState<{ data: unknown; latencyMs: number } | null>(null);
  const [progress, setProgress] = useState<{ stage?: string; bytesReceived?: number } | null>(null);
  const [partial, setPartial] = useState<{ b64_json?: string } | null>(null);
  const [binaryUrl, setBinaryUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const active = connections.filter((c) => c.isActive !== false);
  // A pinned account that was removed or paused would make every run fail.
  const pinnedId = active.some((c) => c.id === pinned) ? pinned : "";

  useEffect(
    () => () => {
      if (binaryUrl) URL.revokeObjectURL(binaryUrl);
    },
    [binaryUrl],
  );

  if (!kindConfig || !ex) return null;

  const apiPath = kindConfig.endpoint.path;
  const modelFull = !needsModel
    ? safeAlias
    : model.trim()
      ? `${safeAlias}/${model.trim()}`
      : manualModel
        ? ""
        : safeAlias;
  const defaults = editDefaults(providerId, model);
  const ref = refImage.trim() || defaults.image || "";
  const mask = maskImage.trim() || defaults.mask_image || "";

  const fields = extraFields.filter(
    (f) =>
      models.length === 0 || (Array.isArray(modelObj?.params) && modelObj.params.includes(f.key)),
  );
  // Only the fields shown for this model go out, so the request (and the curl below)
  // never carries options the model doesn't declare (e.g. SenseNova has no quality).
  const shown = new Set(fields.map((f) => f.key));
  const extraBody = Object.fromEntries(
    Object.entries(extra).filter(
      ([k, v]) =>
        shown.has(k) && v !== "" && v != null && !(typeof v === "number" && Number.isNaN(v)),
    ),
  );
  const body: Record<string, unknown> = {
    model: modelFull,
    [ex.bodyKey]: input,
    ...ex.extraBody,
    ...extraBody,
    ...(kind === "systemone"
      ? {
          questions: {
            is_urgent: { type: "noul", instructions: question.trim() || DEFAULT_QUESTION },
          },
        }
      : {}),
    ...(supportsEdit && ref ? { image: ref } : {}),
    ...(supportsMask && mask ? { mask_image: mask } : {}),
  };

  const wantBinary = kind === "image" && output === "binary";
  // Codex image streams progress + partial images (Plus/Pro accounts).
  const streaming = kind === "image" && providerId === "codex" && !wantBinary;
  const pathWithQuery = `${apiPath}${wantBinary ? "?response_format=binary" : ""}`;

  const curl = (key: string) =>
    [
      `curl -X ${kindConfig.endpoint.method} ${env.endpoint}${pathWithQuery}`,
      `  -H "Content-Type: application/json"`,
      `  -H "Authorization: Bearer ${key}"`,
      pinnedId && `  -H "x-connection-id: ${pinnedId}"`,
      streaming && `  -H "Accept: text/event-stream"`,
      `  -d '${JSON.stringify(body)}'`,
      wantBinary && "  --output image.png",
    ]
      .filter(Boolean)
      .join(" \\\n");

  const run = async () => {
    if (!input.trim() || !modelFull) return;
    setRunning(true);
    setError("");
    setResult(null);
    setProgress(null);
    setPartial(null);
    setBinaryUrl("");
    const start = now();
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...authHeaders(env),
      };
      if (pinnedId) headers["x-connection-id"] = pinnedId;
      if (streaming) headers.Accept = "text/event-stream";
      const res = await fetch(`/api${pathWithQuery}`, {
        method: kindConfig.endpoint.method,
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(errorText(await res.json().catch(() => null), res.status));
        return;
      }
      const ctype = res.headers.get("content-type") || "";
      if (ctype.startsWith("image/")) {
        const blob = await res.blob();
        setBinaryUrl(URL.createObjectURL(blob));
        setResult({
          data: { binary: true, mime: ctype, size: blob.size },
          latencyMs: now() - start,
        });
        return;
      }
      if (ctype.includes("text/event-stream") && res.body) {
        // SSE: progress / partial_image / done / error
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let done: unknown = null;
        let streamErr: string | null = null;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          let sep;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            let evt: string | null = null;
            let data = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) evt = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!evt) continue;
            try {
              const payload = data ? JSON.parse(data) : {};
              if (evt === "progress") setProgress(payload);
              else if (evt === "partial_image") setPartial(payload);
              else if (evt === "done") done = payload;
              else if (evt === "error") streamErr = payload?.message || "Stream error";
            } catch {
              /* skip a malformed event */
            }
          }
        }
        if (streamErr) setError(streamErr);
        else if (done) setResult({ data: done, latencyMs: now() - start });
        else setError("The stream ended without a result");
        return;
      }
      const data = await res.json();
      setResult({ data, latencyMs: now() - start });
    } catch (e) {
      setError((e as Error).message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  const image = kind === "image" ? binaryUrl || (result ? imageOf(result.data) : "") : "";

  return (
    <ExamplePanel method={kindConfig.endpoint.method} path={apiPath}>
      {(models.length > 0 || manualModel) && (
        <Row label="Model">
          {models.length > 0 ? (
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              mono
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Enter model id (provider-specific)"
            />
          )}
        </Row>
      )}
      <EndpointRow env={env} path={apiPath} />
      <KeyRow env={env} />
      {active.length > 0 && (
        <Row label="Account">
          <Select value={pinnedId} onChange={(e) => setPinned(e.target.value)}>
            <option value="">Auto (by priority)</option>
            {active.map((c) => {
              const plan = (c.providerSpecificData as { chatgptPlanType?: string } | undefined)
                ?.chatgptPlanType;
              return (
                <option key={c.id} value={c.id}>
                  {c.email || c.name || c.id.slice(0, 8)}
                  {plan ? ` [${plan}]` : ""}
                </option>
              );
            })}
          </Select>
        </Row>
      )}
      <Row label={ex.inputLabel}>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={ex.inputPlaceholder}
        />
      </Row>
      {kind === "systemone" && (
        <Row label="Question">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Evaluation question or criteria"
          />
        </Row>
      )}
      {supportsEdit && (
        <ImageUrlRow
          label="Source image"
          value={refImage}
          onChange={setRefImage}
          placeholder={defaults.image || "https://example.com/source.png"}
          preview={previewSrc(ref)}
        />
      )}
      {supportsMask && (
        <ImageUrlRow
          label="Mask"
          value={maskImage}
          onChange={setMaskImage}
          placeholder={defaults.mask_image || "https://example.com/mask.png"}
          preview={previewSrc(mask)}
        />
      )}
      {fields.map((f) => (
        <Row key={f.key} label={f.label}>
          {f.type === "boolean" ? (
            <Switch
              label={f.label}
              checked={extra[f.key] === true}
              onChange={(v) => setExtra((s) => ({ ...s, [f.key]: v }))}
            />
          ) : f.type === "select" ? (
            <Select
              value={String(extra[f.key] ?? "")}
              onChange={(e) => setExtra((s) => ({ ...s, [f.key]: e.target.value }))}
            >
              {(f.options || []).map((o) => (
                <option key={o} value={o}>
                  {o === "" ? "(default)" : o}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              type={f.type}
              value={String(extra[f.key] ?? "")}
              min={f.min}
              max={f.max}
              placeholder={f.placeholder}
              onChange={(e) =>
                setExtra((s) => ({
                  ...s,
                  [f.key]:
                    f.type === "number" && e.target.value !== ""
                      ? Number(e.target.value)
                      : e.target.value,
                }))
              }
            />
          )}
        </Row>
      ))}
      {kind === "image" && (
        <Row label="Output">
          <Segmented
            value={output}
            onChange={setOutput}
            options={[
              { value: "json", label: "JSON (base64)" },
              { value: "binary", label: "Binary file" },
            ]}
          />
        </Row>
      )}
      <RequestBlock
        env={env}
        curl={curl}
        onRun={run}
        running={running}
        disabled={!input.trim() || !modelFull}
        runLabel={kind === "image" ? "Generate" : "Run"}
        runningLabel={kind === "image" ? "Generating…" : "Running…"}
      />
      {streaming && (running || progress) && (
        <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-muted">
          <Icon
            name={running ? "progress_activity" : "check_circle"}
            size={16}
            className={running ? "animate-spin" : "text-success-text"}
          />
          {progress?.stage || "Starting"}
          {!running && progress?.bytesReceived
            ? ` · ${(progress.bytesReceived / 1024).toFixed(1)} KB`
            : ""}
        </div>
      )}
      {partial?.b64_json && !result && (
        // oxlint-disable-next-line nextjs/no-img-element -- base64 preview
        <img
          src={`data:image/png;base64,${partial.b64_json}`}
          alt="Partial preview"
          className="max-w-full rounded-lg border border-border opacity-80"
        />
      )}
      <ErrorNote>{error}</ErrorNote>
      <ResponseBlock
        text={result ? JSON.stringify(maskB64(result.data), null, 2) : ""}
        placeholder={ex.defaultResponse}
        latencyMs={result?.latencyMs}
        action={image ? <DownloadLink href={image} filename="image.png" /> : null}
      >
        {image && (
          // oxlint-disable-next-line nextjs/no-img-element -- generated image (blob/data/remote)
          <img
            src={image}
            alt="Generated"
            className="max-w-full rounded-lg border border-border"
            decoding="async"
          />
        )}
      </ResponseBlock>
    </ExamplePanel>
  );
}

function ImageUrlRow({
  label,
  value,
  onChange,
  placeholder,
  preview,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  preview: string;
}) {
  const [broken, setBroken] = useState("");
  return (
    <Row label={label}>
      <div className="space-y-2">
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        {preview && broken !== preview && (
          // oxlint-disable-next-line nextjs/no-img-element -- user-supplied URL preview
          <img
            src={preview}
            alt={label}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setBroken(preview)}
            className="max-h-40 rounded-lg border border-border bg-surface-2 object-contain"
          />
        )}
      </div>
    </Row>
  );
}
