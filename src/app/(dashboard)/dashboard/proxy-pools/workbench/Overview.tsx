"use client";

import { useEffect, useRef, useState } from "react";
import {
  filterProxyPools,
  getVisibleProxyPoolSelection,
  updateProxyPoolSelection,
} from "@/shared/utils/proxyPoolSelection";
import {
  Button,
  Checkbox,
  EmptyState,
  Eyebrow,
  Panel,
  Segmented,
  StatGrid,
  StatusDot,
  Tag,
  needsAttention,
} from "@/ui";
import { cn } from "@/ui/cn";
import { RELAY_LABEL, poolStatus, type ProxyPool } from "./pools";
import type { ProxyPoolsApi } from "./useProxyPools";

type StatusFilter = "all" | "enabled" | "disabled";

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];

/** Summary, stats, and the bulk table (select → activate / deactivate / test / delete). */
export function Overview({
  api,
  onOpen,
  onAdd,
}: {
  api: ProxyPoolsApi;
  onOpen: (id: string) => void;
  onAdd: () => void;
}) {
  const list = api.list;
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [picked, setPicked] = useState<string[]>([]);
  const anchorRef = useRef<string | null>(null);
  const visible: ProxyPool[] = filterProxyPools(list, filter);
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  });
  // Bulk actions only ever target rows the filter shows.
  const selected: string[] = getVisibleProxyPoolSelection(visible, picked);
  const visibleIds = visible.map((p) => p.id);
  const targets = selected.length ? selected : visibleIds;
  const all = visible.length > 0 && selected.length === visible.length;
  const busy = api.bulkBusy || !!api.health;
  const active = list.filter((p) => p.isActive).length;
  const failing = list.filter((p) => needsAttention(poolStatus(p))).length;
  const bound = list.reduce((n, p) => n + (p.boundConnectionCount || 0), 0);

  const clear = () => {
    setPicked([]);
    anchorRef.current = null;
  };
  /** Shift+click extends from the last clicked row, selecting or clearing the whole range. */
  const toggle = (id: string, checked: boolean, shiftKey: boolean) => {
    const anchorId = anchorRef.current;
    setPicked((prev) =>
      updateProxyPoolSelection(visible, prev, { id, checked, shiftKey, anchorId }),
    );
    anchorRef.current = id;
  };
  const toggleAll = () => {
    setPicked(all ? [] : visibleIds);
    anchorRef.current = null;
  };

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-6 md:px-8 md:py-8">
      <header>
        <h1 className="font-display text-3xl tracking-tight">Proxy Pools</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-text-muted">
          <b className="font-medium text-text">
            {active} active {active === 1 ? "proxy" : "proxies"}
          </b>{" "}
          of {list.length}, used by <b className="font-medium text-text">{bound} connections</b>
          {failing ? ` · ${failing} unreachable` : ""}. Assign a pool to a connection on its
          provider page.
        </p>
      </header>

      {list.length === 0 ? (
        <EmptyState
          icon="lan"
          action={
            <Button variant="primary" icon="add" onClick={onAdd}>
              Add proxy pool
            </Button>
          }
        >
          Create a proxy pool entry, then assign it to connections.
        </EmptyState>
      ) : (
        <>
          <StatGrid
            items={[
              { label: "Pools", value: list.length },
              { label: "Active", value: active },
              { label: "Unreachable", value: failing, tone: failing ? "danger" : undefined },
              { label: "Bound connections", value: bound },
            ]}
          />

          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Eyebrow>
                {selected.length
                  ? `${selected.length} selected`
                  : filter === "all"
                    ? "All pools"
                    : "Visible pools"}
              </Eyebrow>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon="health_and_safety"
                  loading={!!api.health}
                  disabled={busy || targets.length === 0}
                  onClick={() => void api.healthCheck(targets)}
                >
                  {api.health
                    ? `Checking ${api.health.current}/${api.health.total}`
                    : selected.length
                      ? "Health check selected"
                      : filter === "all"
                        ? "Health check all"
                        : "Health check visible"}
                </Button>
                {selected.length > 0 && (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="toggle_on"
                      disabled={busy}
                      onClick={() => void api.bulkSetActive(selected, true)}
                    >
                      Activate
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="toggle_off"
                      disabled={busy}
                      onClick={() => void api.bulkSetActive(selected, false)}
                    >
                      Deactivate
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      icon="delete"
                      disabled={busy}
                      onClick={() =>
                        api.bulkDelete(selected, clear, (ids) =>
                          getVisibleProxyPoolSelection(visibleRef.current, ids),
                        )
                      }
                    >
                      Delete
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={clear}>
                      Clear
                    </Button>
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                value={filter}
                onChange={(v) => {
                  if (busy) return;
                  setFilter(v);
                  clear();
                }}
                options={FILTERS}
                className="w-full sm:w-64"
              />
              <span className="text-[12px] text-text-muted">
                Showing <span className="tabular-nums">{visible.length}</span>
                <span className="hidden md:inline"> · Shift+click to select a range</span>
              </span>
            </div>
            <Panel className="divide-y divide-border">
              {visible.length === 0 ? (
                <p className="px-2.5 py-6 text-center text-[12px] text-text-muted">
                  No proxy pools match this status.
                </p>
              ) : (
                <>
                  <Checkbox
                    className="flex gap-3 px-4 py-2 text-[11px] uppercase tracking-wider text-text-subtle"
                    checked={all}
                    disabled={busy}
                    onChange={toggleAll}
                    label={
                      filter === "all"
                        ? all
                          ? "Unselect all"
                          : "Select all"
                        : all
                          ? "Unselect visible"
                          : "Select all visible"
                    }
                  />
                  {visible.map((p) => (
                    <PoolLine
                      key={p.id}
                      pool={p}
                      checked={selected.includes(p.id)}
                      disabled={busy}
                      onCheck={(checked, shiftKey) => toggle(p.id, checked, shiftKey)}
                      onOpen={() => onOpen(p.id)}
                    />
                  ))}
                </>
              )}
            </Panel>
          </section>
        </>
      )}
    </div>
  );
}

function PoolLine({
  pool: p,
  checked,
  disabled,
  onCheck,
  onOpen,
}: {
  pool: ProxyPool;
  checked: boolean;
  disabled?: boolean;
  onCheck: (checked: boolean, shiftKey: boolean) => void;
  onOpen: () => void;
}) {
  const status = poolStatus(p);
  return (
    <div className={cn("flex items-center gap-3 px-4 py-2.5", checked && "bg-accent-soft")}>
      <Checkbox
        aria-label={`Select ${p.name}`}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheck(e.target.checked, (e.nativeEvent as MouseEvent).shiftKey === true)}
      />
      <StatusDot status={status} />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left max-md:min-h-10">
        <span className="block truncate text-[13px] hover:underline">{p.name}</span>
        <span className="block truncate font-mono text-[11px] text-text-muted">{p.proxyUrl}</span>
      </button>
      {p.type && p.type !== "http" && (
        <Tag className="hidden sm:inline-flex">{RELAY_LABEL[p.type]}</Tag>
      )}
      <Tag>{p.boundConnectionCount || 0} bound</Tag>
    </div>
  );
}
