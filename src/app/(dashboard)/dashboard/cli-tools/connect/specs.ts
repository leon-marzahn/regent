import type { ComponentType } from "react";
import { CLI_TOOLS } from "@/shared/constants/cliTools.js";
import { ClaudeExtras, CodexProfiles, CoworkPlugins, HermesExtras } from "./extras";
import { PiModelCaps, initPiExtra, piBody } from "./piCaps";

/**
 * How the shared connect panel drives each tool. Every settings route takes
 * `{ baseUrl, apiKey, model }` (or `models` for list tools) unless `body` says
 * otherwise, and its GET returns `current: { baseUrl, hasKey, models }` — never
 * the config file itself, which holds the key.
 * `apiKey: ""` lets the server pick the first active key (resolveCliApiKey).
 */
export type Current = {
  baseUrl: string | null;
  hasKey: boolean;
  models: Record<string, string | string[] | null>;
} | null;

export interface ToolStatus {
  installed?: boolean;
  hasRegent?: boolean;
  current?: Current;
  [field: string]: unknown;
}

/** A named model slot besides the main model (subagent, per-tier, per-agent…). */
export interface Slot {
  id: string;
  label: string;
  hint?: string;
}

/** A switch (no `choices`) or a small select. */
export interface Option {
  id: string;
  label: string;
  hint?: string;
  choices?: { value: string; label: string }[];
}

export type Extra = Record<string, unknown>;

export interface Values {
  baseUrl: string;
  apiKey: string;
  models: string[];
  slots: Record<string, string>;
  options: Record<string, string | boolean>;
  extra: Extra;
  /** Selected scope (Hermes profile), "" when the tool has none. */
  scope: string;
}

export interface ExtrasProps {
  toolName: string;
  status: ToolStatus;
  values: Values;
  /** The endpoint is a typed-in address rather than one of regent's own. */
  customEndpoint: boolean;
  extra: Extra;
  setExtra: (next: Extra) => void;
  disabled: boolean;
  onChanged: () => void;
}

export interface ToolSpec {
  /** List tools take several models; the first is the default. */
  multi?: boolean;
  /** Plain-language name of the config file, shown above the preview. */
  file: string;
  /** No main model, only `slots` (Claude maps one model per tier). */
  slotsOnly?: boolean;
  slots?: (s: ToolStatus) => Slot[];
  slotsTitle?: string;
  /** Slot values on load; default reads `current.models[slot.id]`. */
  readSlots?: (s: ToolStatus) => Record<string, string>;
  options?: Option[];
  readOptions?: (s: ToolStatus) => Record<string, string | boolean>;
  /** Tool-specific section under the models, with its own state in `extra`. */
  Extras?: ComponentType<ExtrasProps>;
  initExtra?: (s: ToolStatus) => Extra;
  /** Settings are per scope (`?profile=`), picked above the form. */
  scopes?: { label: string; hint?: string; load: () => Promise<{ id: string; label: string }[]> };
  body?: (v: Values) => Record<string, unknown>;
  /** Slots take a typed model id as well as a picked one (Claude Code: ids regent doesn't list). */
  slotsFreeText?: boolean;
  /** Offer "New combo" beside the model picker (Cowork). */
  comboShortcut?: boolean;
  /** Excluded from "Connect all" (needs more than one model to make sense). */
  noBulk?: boolean;
  /** Offer "Add all active models" beside the picker (list tools). */
  addAllModels?: boolean;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const pick = (obj: Record<string, string>) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));

// Claude Code assumes a 200K window unless the model name carries `[1m]`.
const ONE_M = "[1m]";
const stripOneM = (m: string) => (m.endsWith(ONE_M) ? m.slice(0, -ONE_M.length) : m);

type ClaudeTier = { alias: string; name: string; envKey: string; defaultValue?: string };
const CLAUDE_TIERS = (CLI_TOOLS as unknown as { claude: { defaultModels: ClaudeTier[] } }).claude.defaultModels;
const HERMES_ROLES = (CLI_TOOLS as unknown as { hermes: { roles: Slot[] } }).hermes.roles;
const GROK_SUBAGENTS: Slot[] = [
  { id: "general-purpose", label: "General-purpose subagent", hint: "Implementation, testing and full-capability tasks" },
  { id: "explore", label: "Explore subagent", hint: "Read-only codebase research" },
  { id: "plan", label: "Plan subagent", hint: "Architecture and implementation planning" },
];

type Agent = { id: string; name: string | null; configurable?: boolean; currentModel?: string | null };
const openclawAgents = (s: ToolStatus) => ((s.agents as Agent[] | undefined) ?? []).filter((a) => a.configurable);

export const SPECS: Record<string, ToolSpec> = {
  claude: {
    file: "~/.claude/settings.json (+ ~/.claude.json for web search)",
    slotsOnly: true,
    slotsFreeText: true,
    slotsTitle: "Model per tier",
    slots: () => CLAUDE_TIERS.map((t) => ({ id: t.alias, label: t.name })),
    readSlots: (s) =>
      Object.fromEntries(
        CLAUDE_TIERS.map((t) => {
          const v = s.current?.models?.[t.alias];
          return [t.alias, typeof v === "string" ? stripOneM(v) : s.current ? "" : (t.defaultValue ?? "")];
        }),
      ),
    options: [
      {
        id: "autoCompactWindow",
        label: "Auto-compact window",
        hint: "Token count that triggers auto-compact. Default lets Claude Code pick from the model.",
        // Written 2K under the round number to stay under the upstream hard cap.
        choices: [
          { value: "", label: "Default" },
          { value: "198000", label: "200K" },
          { value: "298000", label: "300K" },
          { value: "498000", label: "500K" },
          { value: "698000", label: "700K" },
        ],
      },
      { id: "oneM", label: "1M context", hint: "Adds [1m] to every mapped model so Claude Code allows a 1M window. Only for models that accept it." },
      { id: "exaMcpEnabled", label: "Web search (Exa MCP)", hint: "Gives non-Claude models web search. Restart Claude Code after applying." },
    ],
    readOptions: (s) => ({
      autoCompactWindow: str(s.autoCompactWindow),
      oneM: Object.values(s.current?.models ?? {}).some((m) => typeof m === "string" && m.endsWith(ONE_M)),
      exaMcpEnabled: !!s.exaMcpEnabled,
    }),
    Extras: ClaudeExtras,
    body: ({ baseUrl, apiKey, slots, options }) => {
      const env: Record<string, string> = { ANTHROPIC_BASE_URL: baseUrl };
      if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
      for (const t of CLAUDE_TIERS) {
        const m = slots[t.alias]?.trim();
        if (m) env[t.envKey] = options.oneM ? `${stripOneM(m)}${ONE_M}` : stripOneM(m);
      }
      const autoCompactWindow = str(options.autoCompactWindow);
      return { env, exaMcpEnabled: !!options.exaMcpEnabled, autoCompactWindow };
    },
    noBulk: true,
  },
  codex: {
    file: "~/.codex/config.toml",
    slots: () => [{ id: "subagent", label: "Subagent model", hint: "Empty uses the main model." }],
    Extras: CodexProfiles,
    body: ({ baseUrl, apiKey, models, slots }) => ({
      baseUrl,
      apiKey,
      model: models[0],
      subagentModel: slots.subagent?.trim() || models[0],
    }),
  },
  opencode: {
    multi: true,
    file: "~/.config/opencode/opencode.json",
    slots: () => [{ id: "subagent", label: "Explorer subagent model", hint: "Empty uses the default model." }],
    body: ({ baseUrl, apiKey, models, slots }) => ({
      baseUrl,
      apiKey,
      models,
      activeModel: models[0],
      subagentModel: slots.subagent?.trim() || models[0],
    }),
  },
  droid: {
    multi: true,
    file: "~/.factory/settings.json",
    body: ({ baseUrl, apiKey, models }) => ({ baseUrl, apiKey, models, activeModel: models[0] }),
  },
  openclaw: {
    file: "~/.openclaw/openclaw.json (+ each agent's models.json)",
    slotsTitle: "Per-agent models",
    slots: (s) => openclawAgents(s).map((a) => ({ id: a.id, label: `Agent ${a.name || a.id}`, hint: "Empty uses the default model." })),
    readSlots: (s) => Object.fromEntries(openclawAgents(s).map((a) => [a.id, str(a.currentModel)])),
    body: ({ baseUrl, apiKey, models, slots }) => ({ baseUrl, apiKey, model: models[0], agentModels: pick(slots) }),
  },
  "grok-build": {
    file: "~/.grok/config.toml",
    slotsTitle: "Subagent models",
    slots: () => GROK_SUBAGENTS,
    readSlots: (s) => Object.fromEntries(GROK_SUBAGENTS.map((t) => [t.id, str(s.current?.models?.[`subagent:${t.id}`])])),
    // The route derives each context window from the model's capabilities.
    body: ({ baseUrl, apiKey, models, slots }) => ({ baseUrl, apiKey, model: models[0], subagentModels: pick(slots) }),
  },
  cowork: {
    comboShortcut: true,
    multi: true,
    file: "Claude Desktop's 3p config library (configLibrary/<id>.json)",
    Extras: CoworkPlugins,
    initExtra: (s) => {
      const cw = (s.cowork ?? {}) as { plugins?: unknown[]; localPlugins?: string[]; customPlugins?: unknown[] };
      return {
        plugins: cw.plugins?.length ? cw.plugins : ((s.defaultPlugins as unknown[]) ?? []),
        localPlugins: cw.localPlugins ?? [],
        customPlugins: cw.customPlugins ?? [],
      };
    },
    body: ({ baseUrl, apiKey, models, extra }) => ({
      baseUrl,
      apiKey,
      models,
      plugins: extra.plugins ?? [],
      localPlugins: extra.localPlugins ?? [],
      customPlugins: extra.customPlugins ?? [],
    }),
    noBulk: true,
  },
  hermes: {
    file: "the profile's config.yaml (+ OPENAI_API_KEY in its .env)",
    scopes: {
      label: "Profile",
      hint: "Each Hermes profile keeps its own models.",
      load: async () => {
        const r = await fetch("/api/cli-tools/hermes-profiles", { cache: "no-store" }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        const list = ((r?.profiles ?? []) as { name: string; displayName?: string | null; hasRegent?: boolean }[]).map((p) => ({
          id: p.name,
          label: `${p.displayName || p.name}${p.hasRegent ? " · connected" : ""}`,
        }));
        return list.length ? list : [{ id: "default", label: "default" }];
      },
    },
    slotsTitle: "Other model slots",
    slots: () => HERMES_ROLES,
    readSlots: (s) => Object.fromEntries(Object.entries((s.roles as Record<string, string>) ?? {}).map(([k, v]) => [k, str(v)])),
    Extras: HermesExtras,
    initExtra: (s) => {
      const model = str((s.stt as { model?: string } | undefined)?.model);
      return { audioEnabled: !!s.hasRegentStt, sttModel: model };
    },
    body: ({ baseUrl, apiKey, models, slots, extra, scope }) => ({
      profile: scope || "default",
      baseUrl,
      apiKey,
      selections: [
        { role: "default", model: models[0] },
        ...Object.entries(pick(slots)).map(([role, model]) => ({ role, model })),
      ],
      // Always sent: applying is also how the speech-to-text wiring gets turned off.
      audio: { enabled: !!extra.audioEnabled, model: str(extra.sttModel).trim() },
    }),
    noBulk: true,
  },
  cline: { file: "Cline's global state (~/.cline/data)" },
  kilo: { file: "~/.local/share/kilo/auth.json (+ VS Code settings)" },
  "deepseek-tui": { file: "~/.deepseek/config.toml" },
  crush: { file: "crush.json in your config folder" },
  forge: { file: "~/.forge/config.toml" },
  smelt: { file: "~/.smelt/config.json" },
  codewhale: { file: "~/.codewhale/config.toml" },
  omp: { file: "~/.omp/agent/models.yml" },
  pi: {
    multi: true,
    file: "~/.pi/agent/models.json",
    addAllModels: true,
    Extras: PiModelCaps,
    initExtra: initPiExtra,
    body: piBody,
  },
  jcode: { multi: true, file: "~/.jcode/config.toml (+ key in ~/.config/jcode)" },
};

export const settingsUrl = (toolId: string, scope = "") =>
  `/api/cli-tools/${toolId}-settings${scope ? `?profile=${encodeURIComponent(scope)}` : ""}`;

const EMPTY: Omit<Values, "baseUrl" | "apiKey" | "models"> = { slots: {}, options: {}, extra: {}, scope: "" };

export function bodyFor(toolId: string, v: Partial<Values> & { baseUrl: string; apiKey: string; models: string[] }) {
  const spec = SPECS[toolId];
  const full: Values = { ...EMPTY, ...v };
  if (spec?.body) return spec.body(full);
  return spec?.multi
    ? { baseUrl: full.baseUrl, apiKey: full.apiKey, models: full.models }
    : { baseUrl: full.baseUrl, apiKey: full.apiKey, model: full.models[0] };
}

/** Every route wants the OpenAI-style base with /v1. */
export const withV1 = (url: string) => (url.replace(/\/+$/, "").endsWith("/v1") ? url.replace(/\/+$/, "") : `${url.replace(/\/+$/, "")}/v1`);
