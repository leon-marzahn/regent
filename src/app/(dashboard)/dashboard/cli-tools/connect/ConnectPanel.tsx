"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Field, Icon, IconButton, Input, Panel, Select, SettingRow, Skeleton, Switch, Tag } from "@/ui";
import { ModelSelectModal } from "@/shared/components";
import { ConfirmDialog } from "@/ui";
import { useNotificationStore as useNotificationStoreJs } from "@/store/notificationStore";
import { SPECS, bodyFor, settingsUrl, withV1, type Extra, type ToolStatus, type Values } from "./specs";
import { ModelPick } from "./extras";
import { ComboDialog, ManualConfigDialog } from "./dialogs";
import { hasManual } from "./manual";
import { loadActiveModelValues } from "./activeModels";
import { deleteEndpoint, saveEndpoint, useSavedEndpoints } from "./savedEndpoints";
import { maskKey, useConnectContext } from "./useConnectContext";

type Notify = { getState: () => { error: (m: string) => void; success: (m: string) => void } };
const notify = () => (useNotificationStoreJs as unknown as Notify).getState();

export type { ToolStatus };

const asList = (m: string | string[] | null | undefined) => (Array.isArray(m) ? m.filter(Boolean) : m ? [m] : []);

/** Models the tool uses now, default first. */
function readModels(s: ToolStatus): string[] {
  const m = s.current?.models ?? {};
  const list = asList(m.models ?? m.model);
  const active = typeof m.active === "string" ? m.active : null;
  return active && list.includes(active) ? [active, ...list.filter((x) => x !== active)] : list;
}

/** Shown open up to this many slots; longer lists fold behind "Show all". */
const SLOTS_OPEN = 4;

/** Endpoint, key and model for one tool, a preview of what gets written, and Connect / Disconnect / Restore. */
export function ConnectPanel({ toolId, toolName, onChanged }: { toolId: string; toolName: string; onChanged: () => void }) {
  const spec = SPECS[toolId];
  const ctx = useConnectContext();
  const [status, setStatus] = useState<ToolStatus | null>(null);
  const [endpoint, setEndpoint] = useState<string>("local");
  const [custom, setCustom] = useState("");
  const [keyId, setKeyId] = useState<string>("");
  const [models, setModels] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [addingAll, setAddingAll] = useState(false);
  const [busy, setBusy] = useState<null | "apply" | "remove" | "restore">(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [canRestore, setCanRestore] = useState(false);
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<Record<string, string | boolean>>({});
  const [extra, setExtra] = useState<Extra>({});
  const [scope, setScope] = useState(spec.scopes ? "default" : "");
  const [scopes, setScopes] = useState<{ id: string; label: string }[]>([]);
  const [allSlots, setAllSlots] = useState(false);
  const [manual, setManual] = useState(false);
  const [combo, setCombo] = useState(false);
  const saved = useSavedEndpoints();
  const endpoints = [...ctx.endpoints, ...saved.map((s) => ({ id: `saved:${s.name}`, label: s.name, url: s.baseUrl }))];

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([
      fetch(settingsUrl(toolId, scope), { cache: "no-store" }).then((x) => (x.ok ? x.json() : {})).catch(() => ({})),
      fetch(`/api/cli-tools/restore?toolId=${encodeURIComponent(toolId)}`).then((x) => (x.ok ? x.json() : null)).catch(() => null),
    ]);
    const st = s as ToolStatus;
    setStatus(st);
    setCanRestore(!!r?.available);
    // Always reset: values from another scope (Hermes profile) must not leak in.
    setModels(readModels(st));
    setSlots(spec.readSlots ? spec.readSlots(st) : Object.fromEntries((spec.slots?.(st) ?? []).map((x) => [x.id, typeof st.current?.models?.[x.id] === "string" ? (st.current.models[x.id] as string) : ""])));
    setOptions(spec.readOptions?.(st) ?? {});
    setExtra(spec.initExtra?.(st) ?? {});
  }, [toolId, scope, spec]);

  useEffect(() => {
    if (!spec.scopes) return;
    let live = true;
    void spec.scopes.load().then((list) => live && setScopes(list));
    return () => {
      live = false;
    };
  }, [spec]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // Match the written base URL to a known endpoint, else show it as custom.
  const currentBase = status?.current?.baseUrl ?? null;
  useEffect(() => {
    if (!currentBase) return;
    const match = endpoints.find((e) => e.url && withV1(e.url) === withV1(currentBase));
    const t = setTimeout(() => {
      if (match) setEndpoint(match.id);
      else {
        setEndpoint("custom");
        setCustom(currentBase);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [currentBase, endpoints.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const base = endpoint === "custom" ? custom.trim() : (endpoints.find((e) => e.id === endpoint)?.url ?? "");
  const key = ctx.keys?.find((k) => k.id === keyId);
  const connected = !!status?.hasRegent;
  const slotList = status ? (spec.slots?.(status) ?? []) : [];
  const ready = !!base && (spec.slotsOnly ? Object.values(slots).some((v) => v.trim()) : models.length > 0);
  const values: Values = { baseUrl: withV1(base), apiKey: key?.key ?? "", models, slots, options, extra, scope };

  const apply = async () => {
    setBusy("apply");
    try {
      const res = await fetch(settingsUrl(toolId, scope), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyFor(toolId, values)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || data.error || "Couldn't write the settings");
      notify().success(`${toolName} now uses regent`);
      if (endpoint === "custom") {
        const name = saveEndpoint(custom);
        if (name) setEndpoint(`saved:${name}`);
      }
      await load();
      onChanged();
    } catch (e) {
      notify().error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Not gated on connections: no-auth providers (OpenCode Free) have none.
  const addAllActive = async () => {
    setAddingAll(true);
    try {
      const all = await loadActiveModelValues();
      if (all.length === 0) notify().error("No active models found to add.");
      else setModels((prev) => Array.from(new Set([...prev, ...all])));
    } catch (e) {
      notify().error((e as Error).message);
    } finally {
      setAddingAll(false);
    }
  };

  const remove = async () => {
    setConfirmRemove(false);
    setBusy("remove");
    try {
      const res = await fetch(settingsUrl(toolId, scope), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scope ? { profile: scope } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || data.error || "Couldn't remove the settings");
      notify().success(`Removed regent from ${toolName}`);
      await load();
      onChanged();
    } catch (e) {
      notify().error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy("restore");
    try {
      const res = await fetch("/api/cli-tools/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Restore failed");
      notify().success(`Restored ${data.files?.length ?? 0} file(s) to how they were before`);
      await load();
      onChanged();
    } catch (e) {
      notify().error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!status || !ctx.keys)
    return (
      <Panel className="space-y-3 p-4">
        <Skeleton className="h-9 w-full rounded-lg" />
        <Skeleton className="h-9 w-full rounded-lg" />
        <Skeleton className="h-9 w-2/3 rounded-lg" />
      </Panel>
    );

  if (status.installed === false)
    return (
      <Panel className="p-4 text-[13px] text-text-muted">
        {toolName} isn&rsquo;t installed on this machine, so there&rsquo;s nothing to connect yet. Install it, then come back.
      </Panel>
    );

  const preview: [string, string][] = [
    ["Base URL", base ? withV1(base) : "—"],
    ["API key", key ? `${key.name} (${maskKey(key.key)})` : status.current?.hasKey ? "keep the one already there" : "your first active key"],
    ...(spec.slotsOnly ? [] : ([[spec.multi ? "Models" : "Model", models.length ? models.join(", ") : "—"]] as [string, string][])),
    ...slotList.filter((x) => slots[x.id]?.trim()).map((x) => [x.label, slots[x.id]] as [string, string]),
  ];
  const shownSlots = allSlots || slotList.length <= SLOTS_OPEN ? slotList : slotList.filter((x, i) => i < SLOTS_OPEN || slots[x.id]?.trim());
  const Extras = spec.Extras;

  return (
    <div className="space-y-4">
      {spec.scopes && (
        <Panel className="px-4">
          <SettingRow title={spec.scopes.label} hint={spec.scopes.hint}>
            <Select className="sm:w-56" value={scope} disabled={!!busy} onChange={(e) => setScope(e.target.value)} aria-label={spec.scopes.label}>
              {(scopes.length ? scopes : [{ id: scope, label: scope }]).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </Select>
          </SettingRow>
        </Panel>
      )}
      <Panel className="divide-y divide-border px-4">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 py-4 sm:grid-cols-2">
          <Field className="min-w-0" label="Endpoint" hint="Where the tool sends requests.">
            <Select className="min-w-0" value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
              {endpoints.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label} · {e.url.replace(/^https?:\/\//, "")}
                </option>
              ))}
              <option value="custom">Custom address…</option>
            </Select>
          </Field>
          <Field className="min-w-0" label="API key" hint="The regent key the tool uses.">
            <Select className="min-w-0" value={keyId} onChange={(e) => setKeyId(e.target.value)}>
              <option value="">{status.current?.hasKey ? "Keep current key" : "First active key"}</option>
              {ctx.keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </Select>
          </Field>
          {endpoint === "custom" && (
            <Field label="Custom address" className="min-w-0 sm:col-span-2" hint="Saved in this browser when you connect, or now with Save.">
              <div className="flex gap-2">
                <Input mono className="min-w-0 flex-1" value={custom} placeholder="https://regent.example.com" onChange={(e) => setCustom(e.target.value)} />
                <Button className="shrink-0"
                  icon="bookmark_add"
                  disabled={!/^https?:\/\/\S+$/i.test(custom.trim())}
                  onClick={(e) => {
                    e.preventDefault();
                    const name = saveEndpoint(custom);
                    if (name) setEndpoint(`saved:${name}`);
                  }}
                >
                  Save
                </Button>
              </div>
            </Field>
          )}
          {endpoint.startsWith("saved:") && (
            <div className="flex min-w-0 items-center gap-2 text-[12px] text-text-muted sm:col-span-2">
              <Icon name="bookmark" size={14} />
              <span className="min-w-0 flex-1 truncate">
                Saved address <span className="font-mono">{base}</span>
              </span>
              <IconButton
                icon="delete"
                label="Forget this saved address"
                onClick={() => {
                  deleteEndpoint(endpoint.slice("saved:".length));
                  setCustom(base);
                  setEndpoint("custom");
                }}
              />
            </div>
          )}
        </div>
        {!spec.slotsOnly && (
        <div className="space-y-2 py-4">
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-medium">{spec.multi ? "Models" : "Model"}</div>
            <div className="flex gap-1.5">
              {spec.comboShortcut && (
                <Button size="sm" variant="ghost" icon="add" disabled={!!busy} onClick={() => setCombo(true)}>
                  New combo
                </Button>
              )}
              {spec.addAllModels && (
                <Button size="sm" variant="ghost" icon="playlist_add" loading={addingAll} disabled={!!busy || addingAll} onClick={() => void addAllActive()}>
                  {addingAll ? "Adding…" : "Add all active"}
                </Button>
              )}
              <Button size="sm" icon={spec.multi ? "add" : "swap_horiz"} onClick={() => setPicking(true)}>
                {spec.multi ? "Add model" : models.length ? "Change" : "Choose"}
              </Button>
            </div>
          </div>
          {models.length ? (
            <div className="flex flex-wrap gap-1.5">
              {models.map((m, i) => (
                <Tag key={m} mono tone={i === 0 ? "accent" : "neutral"} className="gap-0.5 pr-1">
                  {m}
                  {spec.multi && (
                    <button type="button" aria-label={`Remove ${m}`} onClick={() => setModels(models.filter((x) => x !== m))} className="grid size-4 place-items-center rounded hover:bg-surface-3">
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </Tag>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-text-muted">Pick a model or combo from regent for {toolName} to use.</p>
          )}
          {spec.multi && models.length > 1 && <p className="text-[11px] text-text-subtle">The first one is the default.</p>}
        </div>
        )}
        {slotList.length > 0 && (
          <div className="py-2">
            {spec.slotsTitle && <div className="pt-2 text-[13px] font-medium">{spec.slotsTitle}</div>}
            <div className="divide-y divide-border">
              {shownSlots.map((x) => (
                <div key={x.id} className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium">{x.label}</div>
                    {x.hint && <div className="text-[11px] text-text-muted">{x.hint}</div>}
                  </div>
                  <ModelPick free={spec.slotsFreeText} value={slots[x.id] ?? ""} title={`${x.label} for ${toolName}`} disabled={!!busy} onChange={(m) => setSlots({ ...slots, [x.id]: m })} />
                </div>
              ))}
            </div>
            {shownSlots.length < slotList.length && (
              <Button size="sm" variant="ghost" icon="expand_more" onClick={() => setAllSlots(true)}>
                Show all {slotList.length}
              </Button>
            )}
          </div>
        )}
        {spec.options?.map((o) => (
          <SettingRow key={o.id} title={o.label} hint={o.hint}>
            {o.choices ? (
              <Select className="sm:w-40" value={String(options[o.id] ?? "")} disabled={!!busy} aria-label={o.label} onChange={(e) => setOptions({ ...options, [o.id]: e.target.value })}>
                {o.choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Switch label={o.label} checked={!!options[o.id]} disabled={!!busy} onChange={(v) => setOptions({ ...options, [o.id]: v })} />
            )}
          </SettingRow>
        ))}
      </Panel>

      {Extras && (
        <Extras toolName={toolName} status={status} values={values} customEndpoint={endpoint === "custom"} extra={extra} setExtra={setExtra} disabled={!!busy} onChanged={() => void load().then(onChanged)} />
      )}

      <Panel className="overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-[12px]">
          <span className="min-w-0 truncate text-text-muted">Written to {spec.file}</span>
          <Tag tone={connected ? "success" : "neutral"}>{connected ? "Currently connected" : "Not connected yet"}</Tag>
        </div>
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 p-4 text-[12px]">
          {preview.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text-muted">{k}</dt>
              <dd className="break-all font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon="check" loading={busy === "apply"} disabled={!ready || !!busy} onClick={() => void apply()}>
          {connected ? "Update" : "Connect"}
        </Button>
        {connected && (
          <Button variant="ghost" icon="link_off" disabled={!!busy} loading={busy === "remove"} onClick={() => setConfirmRemove(true)}>
            Disconnect
          </Button>
        )}
        {hasManual(toolId) && (
          <Button variant="ghost" icon="code" disabled={!!busy} onClick={() => setManual(true)}>
            Manual config
          </Button>
        )}
        {canRestore && (
          <Button variant="ghost" icon="history" disabled={!!busy} loading={busy === "restore"} onClick={() => void restore()}>
            Restore previous
          </Button>
        )}
        <span className="text-[11px] text-text-subtle">A backup of the file is kept before every change.</span>
      </div>

      {picking && (
        <ModelSelectModal
          isOpen
          onClose={() => setPicking(false)}
          title={`Model for ${toolName}`}
          closeOnSelect={!spec.multi}
          addedModelValues={spec.multi ? models : []}
          onSelect={(m: { value?: string }) => {
            if (!m?.value) return;
            setModels(spec.multi ? (models.includes(m.value) ? models : [...models, m.value]) : [m.value]);
          }}
          onDeselect={(m: { value?: string }) => spec.multi && setModels(models.filter((x) => x !== m?.value))}
        />
      )}
      <ManualConfigDialog open={manual} onClose={() => setManual(false)} toolId={toolId} toolName={toolName} values={values} apiKey={key ?? ctx.keys[0]} />
      {spec.comboShortcut && (
        <ComboDialog open={combo} onClose={() => setCombo(false)} toolName={toolName} onCreated={(n) => setModels((m) => (m.includes(n) ? m : [...m, n]))} />
      )}
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Disconnect ${toolName}?`}
        message={`Removes regent's settings from ${toolName}'s config, so it goes back to its own provider. A backup is kept, so you can restore it.`}
        confirmText="Disconnect"
        onConfirm={() => void remove()}
      />
    </div>
  );
}
