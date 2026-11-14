import { buildModelGroups, collectModelValues, LIVE_CATALOG_PROVIDERS } from "@/shared/utils/selectableModels";

type Conn = { id: string; provider: string; isActive?: boolean };

const readJson = async <T>(url: string): Promise<T | null> => {
  try {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
};

/**
 * Every model value a user can route to right now, by the model picker's own rules
 * (shared builder): no-auth providers without a connection row (OpenCode Free),
 * custom models, user aliases and live per-account catalogs are included; paused
 * providers and disabled models are not. Resolved at click time, never cached.
 */
export async function loadActiveModelValues(): Promise<string[]> {
  const [providersData, aliasData, customData, disabledData] = await Promise.all([
    readJson<{ connections?: Conn[] }>("/api/providers"),
    readJson<{ aliases?: Record<string, string> }>("/api/models/alias"),
    readJson<{ models?: unknown[] }>("/api/models/custom"),
    readJson<{ disabled?: Record<string, string[]> }>("/api/models/disabled"),
  ]);

  const allConnections = providersData?.connections ?? [];
  const connections = allConnections.filter((c) => c && c.isActive !== false);

  // Live per-account catalogs (cursor/cline/clinepass/zed) are not in the registry.
  const liveModels: Record<string, unknown[]> = {};
  await Promise.all(
    (LIVE_CATALOG_PROVIDERS as string[]).map(async (providerId) => {
      const ids = connections.filter((c) => c.provider === providerId).map((c) => c.id);
      if (ids.length === 0) return;
      const lists = await Promise.all(
        ids.map((id) => readJson<{ models?: unknown[] }>(`/api/providers/${encodeURIComponent(id)}/models`)),
      );
      liveModels[providerId] = lists.flatMap((d) => (Array.isArray(d?.models) ? d.models : []));
    }),
  );

  return collectModelValues(
    buildModelGroups({
      connections,
      allConnections,
      modelAliases: aliasData?.aliases || {},
      customModels: customData?.models || [],
      disabledModels: disabledData?.disabled || {},
      liveModels,
    }),
  ) as string[];
}
