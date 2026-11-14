"use client";

import { Select } from "@/ui";
import type { ExtrasProps, ToolStatus, Values } from "./specs";

/** Pi's per-model context window / max output, as written to models.json. */
export type Caps = { contextWindow: number; maxTokens: number };

const CONTEXT_WINDOWS = [200000, 400000, 600000, 1000000];
const MAX_TOKENS = [16000, 32000, 64000, 128000];
export const PI_DEFAULT_CAPS: Caps = { contextWindow: 200000, maxTokens: 64000 };
// Same bounds the pi-settings route enforces; anything outside falls back to the default.
const LIMITS: Caps = { contextWindow: 2000000, maxTokens: 200000 };

const formatTokens = (n: number) => (n >= 1000000 ? `${+(n / 1000000).toFixed(2)}M` : `${Math.round(n / 1000)}k`);

const sanitize = (v: unknown, fallback: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= max ? n : fallback;
};

/** Presets, plus a hand-edited value from models.json so it stays selectable. */
const optionsWith = (values: number[], current: number) =>
  values.includes(current) ? values : [...values, current].sort((a, b) => a - b);

const capsOf = (extra: Record<string, unknown>) => (extra.caps ?? {}) as Record<string, Partial<Caps>>;

export const capsFor = (extra: Record<string, unknown>, id: string): Caps => ({ ...PI_DEFAULT_CAPS, ...capsOf(extra)[id] });

/** Seed caps from the GET's `modelCaps` (numbers only), sanitized like the route does. */
export function initPiExtra(s: ToolStatus) {
  const raw = (s.modelCaps ?? {}) as Record<string, Partial<Caps>>;
  const caps: Record<string, Caps> = {};
  for (const [id, c] of Object.entries(raw)) {
    caps[id] = {
      contextWindow: sanitize(c?.contextWindow, PI_DEFAULT_CAPS.contextWindow, LIMITS.contextWindow),
      maxTokens: sanitize(c?.maxTokens, PI_DEFAULT_CAPS.maxTokens, LIMITS.maxTokens),
    };
  }
  return { caps };
}

/**
 * Models go out with the caps known for them. A model without any (just added, or
 * "Connect all", which has no extra state) sends none: the route keeps what
 * models.json already has, else writes the defaults.
 */
export const piBody = ({ baseUrl, apiKey, models, extra }: Values) => ({
  baseUrl,
  apiKey,
  models: models.map((id) => ({ id, name: id, ...capsOf(extra)[id] })),
});

/** One row per selected model: context window and max output token selects. */
export function PiModelCaps({ values, extra, setExtra, disabled }: ExtrasProps) {
  if (values.models.length === 0) return null;
  const set = (id: string, key: keyof Caps, value: number) =>
    setExtra({ ...extra, caps: { ...capsOf(extra), [id]: { ...capsFor(extra, id), [key]: value } } });
  return (
    <div className="space-y-2 py-4">
      <div>
        <div className="text-[13px] font-medium">Model limits</div>
        <div className="text-[11px] text-text-muted">Context window and max output tokens Pi assumes for each model.</div>
      </div>
      <div className="divide-y divide-border">
        {values.models.map((id) => {
          const caps = capsFor(extra, id);
          return (
            <div key={id} className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <span className="min-w-0 truncate font-mono text-[12px]">{id}</span>
              <div className="flex shrink-0 gap-2">
                <Select
                  aria-label={`Context window for ${id}`}
                  className="w-36"
                  value={caps.contextWindow}
                  disabled={disabled}
                  onChange={(e) => set(id, "contextWindow", Number(e.target.value))}
                >
                  {optionsWith(CONTEXT_WINDOWS, caps.contextWindow).map((n) => (
                    <option key={n} value={n}>
                      {formatTokens(n)} ctx
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label={`Max output tokens for ${id}`}
                  className="w-36"
                  value={caps.maxTokens}
                  disabled={disabled}
                  onChange={(e) => set(id, "maxTokens", Number(e.target.value))}
                >
                  {optionsWith(MAX_TOKENS, caps.maxTokens).map((n) => (
                    <option key={n} value={n}>
                      {formatTokens(n)} out
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
