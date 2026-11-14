// Normalized "what regent config is currently written" summaries for each CLI tool's
// settings GET, so one shared UI panel can read any tool. Pure functions over the config
// each route already reads. NEVER return key material: only `hasKey` booleans.
//
// Shape: { baseUrl: string|null, hasKey: boolean, models: { [slot]: string|string[]|null } } | null
import { parseTOML } from "confbox";
import {
  PROVIDER_KEYS,
  pickProvider,
  hasProviderPrefix,
  stripProviderPrefix,
} from "../../../shared/constants/brand.js";

const str = (v) => (typeof v === "string" && v.trim() ? v : null);
const has = (v) => typeof v === "string" && v.trim().length > 0;
const unprefix = (v) => (has(v) && hasProviderPrefix(v) ? stripProviderPrefix(v) : null);

// ~/.claude/settings.json — env written by the Claude card (POST merges `env`).
export const claudeCurrent = (settings) => {
  const env = settings?.env;
  if (!env?.ANTHROPIC_BASE_URL) return null;
  const token = env.ANTHROPIC_AUTH_TOKEN;
  return {
    baseUrl: str(env.ANTHROPIC_BASE_URL),
    hasKey: has(token) && token !== "sk_9router",
    models: {
      opus: str(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
      sonnet: str(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
      haiku: str(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
      fable: str(env.ANTHROPIC_DEFAULT_FABLE_MODEL),
    },
  };
};

// ~/.codex/config.toml (raw text). Key travels as http_headers.Authorization.
export const codexCurrent = (content) => {
  if (!content) return null;
  let parsed;
  try {
    parsed = parseTOML(content) || {};
  } catch {
    return null;
  }
  const key = PROVIDER_KEYS.find((k) => parsed.model_providers?.[k]);
  if (!key) return null;
  const provider = parsed.model_providers[key];
  const auth = provider.http_headers?.Authorization;
  const usingOurs = PROVIDER_KEYS.includes(parsed.model_provider);
  return {
    baseUrl: str(provider.base_url),
    hasKey: has(auth) && auth.replace(/^Bearer\s*/i, "").trim().length > 0,
    models: {
      model: usingOurs ? str(parsed.model) : null,
      subagent: str(parsed.agents?.default_subagent_model),
    },
  };
};

// ~/.config/opencode/opencode.json
export const opencodeCurrent = (config) => {
  const provider = pickProvider(config?.provider);
  if (!provider) return null;
  return {
    baseUrl: str(provider.options?.baseURL),
    hasKey: has(provider.options?.apiKey),
    models: {
      models: Object.keys(provider.models || {}),
      active: unprefix(config?.model),
      subagent: unprefix(config?.agent?.explorer?.model),
    },
  };
};

// ~/.factory/settings.json — customModels entries with id custom:regent-N (or legacy).
const DROID_PREFIXES = PROVIDER_KEYS.map((k) => `custom:${k}-`).concat("custom:9Router");
export const droidCurrent = (settings) => {
  const ours = (settings?.customModels || []).filter(
    (m) => typeof m?.id === "string" && DROID_PREFIXES.some((p) => m.id.startsWith(p)),
  );
  if (ours.length === 0) return null;
  const sorted = [...ours].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return {
    baseUrl: str(sorted[0].baseUrl),
    hasKey: sorted.some((m) => has(m.apiKey)),
    models: {
      models: sorted.map((m) => m.model).filter(has),
      // POST reorders so the active model is index 0
      active: str(sorted[0].model),
    },
  };
};

// ~/.openclaw/openclaw.json
export const openclawCurrent = (settings) => {
  const provider = pickProvider(settings?.models?.providers);
  if (!provider) return null;
  const primary = settings?.agents?.defaults?.model?.primary;
  return {
    baseUrl: str(provider.baseUrl),
    hasKey: has(provider.apiKey),
    models: { model: unprefix(primary) },
  };
};

// ~/.cline/data/globalState.json (+ secrets.json presence only)
export const clineCurrent = (globalState, secrets) => {
  if (!globalState) return null;
  const isOpenAi =
    globalState.actModeApiProvider === "openai" || globalState.planModeApiProvider === "openai";
  if (!isOpenAi || !has(globalState.openAiBaseUrl)) return null;
  return {
    baseUrl: str(globalState.openAiBaseUrl),
    hasKey: has(secrets?.openAiApiKey),
    models: { model: str(globalState.openAiModelId) },
  };
};

// ~/.local/share/kilo/auth.json
export const kiloCurrent = (auth) => {
  const entry = auth?.["openai-compatible"] || pickProvider(auth);
  if (!entry) return null;
  const baseUrl = entry.baseUrl || entry.baseURL;
  if (!has(baseUrl)) return null;
  return {
    baseUrl: str(baseUrl),
    hasKey: has(entry.apiKey),
    models: { model: str(entry.model) },
  };
};

// ~/.deepseek/config.toml (raw text). POST writes provider="openai" + [providers.openai].
export const deepseekTuiCurrent = (content) => {
  if (!content || !content.trim()) return null;
  let parsed;
  try {
    parsed = parseTOML(content) || {};
  } catch {
    return null;
  }
  const openai = parsed.providers?.openai;
  if (parsed.provider !== "openai" || !has(openai?.base_url)) return null;
  return {
    baseUrl: str(openai.base_url),
    hasKey: has(openai.api_key),
    models: { model: str(openai.model) },
  };
};

// ~/.jcode/config.toml (parsed). Key lives in a separate env file; pass its presence.
export const jcodeCurrent = (config, envHasKey = false) => {
  const provider = pickProvider(config?.providers);
  if (!provider) return null;
  return {
    baseUrl: str(provider.base_url),
    hasKey: Boolean(envHasKey),
    models: { models: has(provider.default_model) ? [provider.default_model] : [] },
  };
};

// parseGrokBuildConfig() output.
export const grokBuildCurrent = (settings) => {
  const main = settings?.model;
  if (!has(main?.base_url)) return null;
  const models = { model: str(main.model) };
  for (const [type, sub] of Object.entries(settings.subagentModels || {})) {
    if (sub?.model) models[`subagent:${type}`] = sub.model;
  }
  return { baseUrl: str(main.base_url), hasKey: has(main.api_key), models };
};

// Pi models.json
export const piCurrent = (config) => {
  const provider = pickProvider(config?.providers);
  if (!has(provider?.baseUrl)) return null;
  return {
    baseUrl: str(provider.baseUrl),
    hasKey: has(provider.apiKey),
    models: { models: (provider.models || []).map((m) => m?.id).filter(has) },
  };
};

// Per-model context window / max output from Pi's models.json, so the card can
// show and keep what's set there. Numbers only; nothing else from the entry leaves.
export const piModelCaps = (config) => {
  const caps = {};
  for (const m of pickProvider(config?.providers)?.models || []) {
    if (!has(m?.id)) continue;
    const entry = {};
    if (Number.isFinite(m.contextWindow)) entry.contextWindow = m.contextWindow;
    if (Number.isFinite(m.maxTokens)) entry.maxTokens = m.maxTokens;
    caps[m.id] = entry;
  }
  return caps;
};

// Oh My Pi models.yml (raw text). POST writes no model: omp discovers them via the proxy.
export const ompCurrent = (content) => {
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => PROVIDER_KEYS.some((k) => new RegExp(`^\\s+${k}:\\s*$`).test(l)));
  if (start < 0) return null;
  const indent = lines[start].match(/^\s*/)[0].length;
  const block = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.match(/^\s*/)[0].length <= indent) break;
    const m = line.match(/^\s+(baseUrl|apiKey):\s*(.*)$/);
    if (m) block[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { baseUrl: str(block.baseUrl), hasKey: has(block.apiKey), models: {} };
};

// Crush crush.json
export const crushCurrent = (config) => {
  const provider = pickProvider(config?.providers);
  if (!has(provider?.base_url)) return null;
  return {
    baseUrl: str(provider.base_url),
    hasKey: has(provider.api_key),
    models: { model: str(provider.models?.[0]?.id) },
  };
};

// [openai] table written by forge/codewhale POST (parsed TOML), gated on hasRegent.
const openaiTableCurrent = (config, hasRegent) => {
  const openai = config?.openai;
  if (!hasRegent || !openai) return null;
  return {
    baseUrl: str(openai.base_url),
    hasKey: has(openai.api_key),
    models: { model: str(openai.model) },
  };
};
export const forgeCurrent = openaiTableCurrent;
export const codewhaleCurrent = openaiTableCurrent;

// ~/.smelt/config.json
export const smeltCurrent = (config, hasRegent) => {
  if (!hasRegent || !config) return null;
  return {
    baseUrl: str(config.baseUrl),
    hasKey: has(config.apiKey),
    models: { model: str(config.model) },
  };
};

// Claude Desktop (Cowork) applied configLibrary entry.
export const coworkCurrent = (config) => {
  if (config?.inferenceProvider !== "gateway" || !has(config?.inferenceGatewayBaseUrl)) return null;
  const models = Array.isArray(config.inferenceModels)
    ? config.inferenceModels.map((m) => (typeof m === "string" ? m : m?.name)).filter(has)
    : [];
  return {
    baseUrl: str(config.inferenceGatewayBaseUrl),
    hasKey: has(config.inferenceGatewayApiKey),
    models: { models },
  };
};

// Hermes: parseModelBlock() output + the profile .env text (api_key is a ${OPENAI_API_KEY} ref).
export const hermesCurrent = (modelBlock, envText = "") => {
  if (modelBlock?.provider !== "custom" || !has(modelBlock?.base_url)) return null;
  return {
    baseUrl: str(modelBlock.base_url),
    hasKey: /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*["']?[^\s"'#]+/m.test(envText || ""),
    models: { model: str(modelBlock.default) },
  };
};
