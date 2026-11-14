"use client";

import { useCallback, useEffect, useState } from "react";
import { useNotificationStore } from "@/store/notificationStore";
import { parseProxyLine, type PoolForm, type ProxyPool } from "./pools";

type Notify = {
  success: (m: string) => void;
  error: (m: string) => void;
  warning: (m: string) => void;
};

export interface ConfirmState {
  title: string;
  message: string;
  confirmText?: string;
  onConfirm: () => void | Promise<void>;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

const put = (id: string, body: object) =>
  fetch(`/api/proxy-pools/${id}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });

/** Every call the Proxy Pools page makes, with the same requests and messages as before. */
export function useProxyPools() {
  const notify = useNotificationStore() as unknown as Notify;
  const [pools, setPools] = useState<ProxyPool[] | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [health, setHealth] = useState<{ current: number; total: number } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/proxy-pools?includeUsage=true", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setPools(data.proxyPools || []);
      else setPools((prev) => prev ?? []);
    } catch (error) {
      console.log("Error fetching proxy pools:", error);
      setPools((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(first);
  }, [refresh]);

  const list = pools ?? [];

  /** Create (no id) or update a pool. Returns the saved pool on success. */
  const save = async (form: PoolForm, id?: string): Promise<ProxyPool | null> => {
    const payload = {
      name: form.name.trim(),
      proxyUrl: form.proxyUrl.trim(),
      noProxy: form.noProxy.trim(),
      isActive: form.isActive === true,
      strictProxy: form.strictProxy === true,
    };
    if (!payload.name || !payload.proxyUrl) return null;
    try {
      const res = await fetch(id ? `/api/proxy-pools/${id}` : "/api/proxy-pools", {
        method: id ? "PUT" : "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        await refresh();
        notify.success(id ? "Proxy pool updated" : "Proxy pool created");
        return (data.proxyPool as ProxyPool) ?? ({ id, ...payload } as ProxyPool);
      }
      notify.error(data.error || "Failed to save proxy pool");
    } catch (error) {
      console.log("Error saving proxy pool:", error);
    }
    return null;
  };

  const remove = (pool: ProxyPool, onDone?: () => void) =>
    setConfirm({
      title: "Delete proxy pool",
      message: `Delete proxy pool "${pool.name}"?`,
      confirmText: "Delete",
      onConfirm: async () => {
        setConfirm(null);
        try {
          const res = await fetch(`/api/proxy-pools/${pool.id}`, { method: "DELETE" });
          if (res.ok) {
            setPools((prev) => (prev ?? []).filter((item) => item.id !== pool.id));
            notify.success("Proxy pool deleted");
            onDone?.();
            return;
          }
          const data = await res.json();
          if (res.status === 409) {
            notify.warning(
              `Cannot delete: ${data.boundConnectionCount || 0} connection(s) are still using this pool.`,
            );
          } else {
            notify.error(data.error || "Failed to delete proxy pool");
          }
        } catch (error) {
          console.log("Error deleting proxy pool:", error);
          notify.error("Failed to delete proxy pool");
        }
      },
    });

  const test = async (id: string) => {
    setTestingId(id);
    try {
      const res = await fetch(`/api/proxy-pools/${id}/test`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        notify.error(data.error || "Failed to test proxy");
        return;
      }
      await refresh();
      notify.success(data.ok ? "Proxy test passed" : "Proxy test failed");
    } catch (error) {
      console.log("Error testing proxy pool:", error);
      notify.error("Failed to test proxy");
    } finally {
      setTestingId(null);
    }
  };

  const toggleActive = async (pool: ProxyPool) => {
    const next = !pool.isActive;
    const setActive = (v: boolean) =>
      setPools((prev) => (prev ?? []).map((p) => (p.id === pool.id ? { ...p, isActive: v } : p)));
    setActive(next);
    try {
      const res = await put(pool.id, { isActive: next });
      if (!res.ok) {
        setActive(pool.isActive);
        notify.error("Failed to update active state");
      }
    } catch (error) {
      console.log("Error toggling active:", error);
      setActive(pool.isActive);
    }
  };

  /** Activate/deactivate the given ids (all pools when empty). */
  const bulkSetActive = async (ids: string[], isActive: boolean) => {
    const targets = ids.length > 0 ? ids : list.map((p) => p.id);
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      let ok = 0;
      let failed = 0;
      for (const id of targets) {
        try {
          const res = await put(id, { isActive });
          if (res.ok) ok += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
      await refresh();
      notify.success(
        `${isActive ? "Activated" : "Deactivated"} ${ok}${failed ? `, failed ${failed}` : ""}`,
      );
    } finally {
      setBulkBusy(false);
    }
  };

  /**
   * Ask, then delete `ids`. `revalidate` re-picks the targets on confirm: a test still in
   * flight can change a pool's status (and hide it from a filtered view) while the dialog is open.
   */
  const bulkDelete = (
    ids: string[],
    onDone: () => void,
    revalidate: (ids: string[]) => string[] = (x) => x,
  ) => {
    if (ids.length === 0) return;
    setConfirm({
      title: "Delete proxy pools",
      message: `Delete ${ids.length} proxy pool(s)?`,
      confirmText: "Delete",
      onConfirm: async () => {
        const targets = revalidate(ids);
        setConfirm(null);
        setBulkBusy(true);
        try {
          let ok = 0;
          let blocked = 0;
          let failed = 0;
          for (const id of targets) {
            try {
              const res = await fetch(`/api/proxy-pools/${id}`, { method: "DELETE" });
              if (res.ok) ok += 1;
              else if (res.status === 409) blocked += 1;
              else failed += 1;
            } catch {
              failed += 1;
            }
          }
          await refresh();
          onDone();
          notify.success(
            `Deleted ${ok}${blocked ? `, ${blocked} bound` : ""}${failed ? `, ${failed} failed` : ""}`,
          );
        } finally {
          setBulkBusy(false);
        }
      },
    });
  };

  /** Test the given ids (all pools when empty), 10 at a time, then offer to disable the dead ones. */
  const healthCheck = async (ids: string[]) => {
    const targets = ids.length > 0 ? list.filter((p) => ids.includes(p.id)) : list;
    if (targets.length === 0) return;
    setHealth({ current: 0, total: targets.length });
    let alive = 0;
    let done = 0;
    const deadIds: string[] = [];
    const queue = [...targets];
    const worker = async () => {
      while (queue.length > 0) {
        const pool = queue.shift();
        if (!pool) break;
        try {
          const res = await fetch(`/api/proxy-pools/${pool.id}/test`, { method: "POST" });
          const data = await res.json();
          if (res.ok && data.ok) alive += 1;
          else deadIds.push(pool.id);
        } catch {
          deadIds.push(pool.id);
        } finally {
          done += 1;
          setHealth({ current: done, total: targets.length });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(10, targets.length) }, worker));
    await refresh();
    setHealth(null);

    if (deadIds.length === 0) {
      notify.success(`Health check done. Alive: ${alive}, Dead: ${deadIds.length}`);
      return;
    }
    setConfirm({
      title: "Disable dead proxies",
      message: `Alive: ${alive}, Dead: ${deadIds.length}.\n\nDisable ${deadIds.length} dead proxies?`,
      confirmText: "Disable",
      onConfirm: async () => {
        setConfirm(null);
        setBulkBusy(true);
        try {
          for (const id of deadIds) {
            try {
              await put(id, { isActive: false });
            } catch {}
          }
          await refresh();
          notify.success(`Disabled ${deadIds.length} dead proxies`);
        } finally {
          setBulkBusy(false);
        }
      },
    });
  };

  /** Batch import; returns true when the dialog can close. */
  const batchImport = async (text: string): Promise<boolean> => {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      notify.warning("Please paste at least one proxy line.");
      return false;
    }
    const entries: { proxyUrl: string; name: string }[] = [];
    const invalid: string[] = [];
    lines.forEach((line, index) => {
      try {
        const parsed = parseProxyLine(line);
        if (parsed) entries.push(parsed);
      } catch (error) {
        invalid.push(`Line ${index + 1}: ${(error as Error).message}`);
      }
    });
    if (invalid.length > 0) {
      notify.error(`Invalid proxy format:\n${invalid.join("\n")}`);
      return false;
    }
    try {
      const existing = new Set(
        list.map((pool) => `${(pool.proxyUrl || "").trim()}|||${(pool.noProxy || "").trim()}`),
      );
      let created = 0;
      let skipped = 0;
      let failed = 0;
      for (const entry of entries) {
        const key = `${entry.proxyUrl}|||`;
        if (existing.has(key)) {
          skipped += 1;
          continue;
        }
        const res = await fetch("/api/proxy-pools", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ ...entry, noProxy: "", isActive: true }),
        });
        if (res.ok) {
          created += 1;
          existing.add(key);
        } else {
          failed += 1;
        }
      }
      await refresh();
      notify.success(
        `Batch import completed: Created ${created}, Skipped ${skipped}, Failed ${failed}`,
      );
      return true;
    } catch (error) {
      console.log("Error batch importing proxies:", error);
      notify.error("Batch import failed");
      return false;
    }
  };

  /** Deploy a relay; the token goes to our server once and is not stored. */
  const deployRelay = async (kind: string, form: Record<string, string>): Promise<boolean> => {
    try {
      const res = await fetch(`/api/proxy-pools/${kind}-deploy`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok) {
        await refresh();
        notify.success(`Deployed: ${data.deployUrl}`);
        return true;
      }
      notify.error(data.error || "Deploy failed");
    } catch (error) {
      console.log(`Error deploying ${kind} relay:`, error);
      notify.error("Deploy failed");
    }
    return false;
  };

  return {
    pools,
    list,
    testingId,
    bulkBusy,
    health,
    confirm,
    setConfirm,
    refresh,
    save,
    remove,
    test,
    toggleActive,
    bulkSetActive,
    bulkDelete,
    healthCheck,
    batchImport,
    deployRelay,
  };
}

export type ProxyPoolsApi = ReturnType<typeof useProxyPools>;
