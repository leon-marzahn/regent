"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { Icon, IconButton, StatusDot, Switch, Tag, cn } from "@/ui";
import CooldownTimer from "./CooldownTimer";

export default function ConnectionRow({ connection, proxyPools, isOAuth, isFirst, isLast, onMoveUp, onMoveDown, onToggleActive, onUpdateProxy, onEdit, onDelete, oneByOneStatus = null, autoPing = null }) {
  const [showProxyDropdown, setShowProxyDropdown] = useState(false);
  const [updatingProxy, setUpdatingProxy] = useState(false);
  const proxyDropdownRef = useRef(null);
  const proxyBtnRef = useRef(null);
  const [proxyDropdownStyle, setProxyDropdownStyle] = useState(null);

  const proxyPoolMap = new Map((proxyPools || []).map((pool) => [pool.id, pool]));
  const boundProxyPoolId = connection.providerSpecificData?.proxyPoolId || null;
  const boundProxyPool = boundProxyPoolId ? proxyPoolMap.get(boundProxyPoolId) : null;
  const hasLegacyProxy = connection.providerSpecificData?.connectionProxyEnabled === true && !!connection.providerSpecificData?.connectionProxyUrl;
  const hasAnyProxy = !!boundProxyPoolId || hasLegacyProxy;
  const proxyDisplayText = boundProxyPool
    ? `Pool: ${boundProxyPool.name}`
    : boundProxyPoolId
      ? `Pool: ${boundProxyPoolId} (inactive/missing)`
      : hasLegacyProxy
        ? `Legacy: ${connection.providerSpecificData?.connectionProxyUrl}`
        : "";
  const autoPingTooltip = (() => {
    if (!autoPing) return "";
    const activeModes = [];
    if (autoPing.reactiveOn) activeModes.push("On reset");
    if (autoPing.scheduleOn) activeModes.push(`Scheduled (${autoPing.scheduleSummary || "active"})`);
    if (activeModes.length > 0) {
      return `Auto-ping active: ${activeModes.join(" + ")}. Click to configure.`;
    }
    return autoPing.provider === "codex"
      ? "Auto-starts the next 5h Codex window after reset or on schedule. Click to configure."
      : "Auto-starts a new window on quota reset or fixed schedule. Click to configure.";
  })();

  let maskedProxyUrl = "";
  if (boundProxyPool?.proxyUrl || connection.providerSpecificData?.connectionProxyUrl) {
    const rawProxyUrl = boundProxyPool?.proxyUrl || connection.providerSpecificData?.connectionProxyUrl;
    try {
      const parsed = new URL(rawProxyUrl);
      maskedProxyUrl = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      maskedProxyUrl = rawProxyUrl;
    }
  }

  const noProxyText = boundProxyPool?.noProxy || connection.providerSpecificData?.connectionNoProxy || "";

  let proxyBadgeVariant = "default";
  if (boundProxyPool?.isActive === true) {
    proxyBadgeVariant = "success";
  } else if (boundProxyPoolId || hasLegacyProxy) {
    proxyBadgeVariant = "error";
  }

  // Render via portal + fixed positioning so ancestor overflow (scrollable
  // connections list) can't clip the dropdown
  const toggleProxyDropdown = () => {
    if (showProxyDropdown) {
      setShowProxyDropdown(false);
      return;
    }
    const rect = proxyBtnRef.current?.getBoundingClientRect();
    if (!rect) {
      setShowProxyDropdown(true);
      return;
    }
    const estimatedHeight = ((proxyPools?.length || 0) + 1) * 34 + 8;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < estimatedHeight && rect.top > spaceBelow;
    setProxyDropdownStyle({
      position: "fixed",
      right: window.innerWidth - rect.right,
      ...(flipUp
        ? { bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(rect.top - 8, 120) }
        : { top: rect.bottom + 4, maxHeight: Math.max(spaceBelow - 8, 120) }),
    });
    setShowProxyDropdown(true);
  };

  // Close dropdown when clicking outside, scrolling, or resizing
  useEffect(() => {
    if (!showProxyDropdown) return;
    const handleClick = (e) => {
      if (
        proxyDropdownRef.current?.contains(e.target) ||
        proxyBtnRef.current?.contains(e.target)
      ) return;
      setShowProxyDropdown(false);
    };
    const close = () => setShowProxyDropdown(false);
    document.addEventListener("mousedown", handleClick);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [showProxyDropdown]);

  const handleSelectProxy = async (poolId) => {
    setUpdatingProxy(true);
    try {
      await onUpdateProxy(poolId === "__none__" ? null : poolId);
    } finally {
      setUpdatingProxy(false);
      setShowProxyDropdown(false);
    }
  };

  const rowAuthType = connection.authType || (isOAuth ? "oauth" : "apikey");
  const isOAuthConnection = rowAuthType === "oauth";
  const isCookieConnection = rowAuthType === "cookie";
  const isLeaseConnection = rowAuthType === "mcode-lease";
  const authIcon = isLeaseConnection ? "desktop_windows" : isCookieConnection ? "cookie" : isOAuthConnection ? "lock" : "key";
  const authLabel = isLeaseConnection ? "Desktop Lease" : isOAuthConnection ? "OAuth" : isCookieConnection ? "Cookie" : "API Key";
  const displayName = connection.name?.trim()
    || connection.email?.trim()
    || connection.displayName?.trim()
    || (isLeaseConnection ? "Desktop Lease" : isOAuthConnection ? "OAuth Account" : isCookieConnection ? "Cookie Account" : "API Key");
  const secondaryDisplayName = connection.name?.trim() && connection.email?.trim() && connection.name.trim() !== connection.email.trim()
    ? connection.email.trim()
    : connection.name?.trim() && connection.displayName?.trim() && connection.name.trim() !== connection.displayName.trim()
      ? connection.displayName.trim()
      : null;

  // Use useState + useEffect for impure Date.now() to avoid calling during render
  const [isCooldown, setIsCooldown] = useState(false);

  // Get earliest model lock timestamp (useEffect handles the Date.now() comparison)
  const modelLockUntil = Object.entries(connection)
    .filter(([k]) => k.startsWith("modelLock_"))
    .map(([, v]) => v)
    .filter(v => !!v)
    .sort()[0] || null;

  useEffect(() => {
    const checkCooldown = () => {
      const until = Object.entries(connection)
        .filter(([k]) => k.startsWith("modelLock_"))
        .map(([, v]) => v)
        .filter(v => v && new Date(v).getTime() > Date.now())
        .sort()[0] || null;
      setIsCooldown(!!until);
    };

    checkCooldown();
    const interval = modelLockUntil ? setInterval(checkCooldown, 1000) : null;
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [modelLockUntil]);

  // Determine effective status (override unavailable if cooldown expired)
  const effectiveStatus = (connection.testStatus === "unavailable" && !isCooldown)
    ? "active"  // Cooldown expired u2192 treat as active
    : connection.testStatus;

  const getOneByOneVariant = () => {
    if (!oneByOneStatus) return "default";
    if (oneByOneStatus.state === "success") return "success";
    if (oneByOneStatus.state === "failed") return "error";
    if (oneByOneStatus.state === "testing") return "primary";
    return "default";
  };

  const getOneByOneLabel = () => {
    if (!oneByOneStatus) return null;
    if (oneByOneStatus.state === "queued") return "queued";
    if (oneByOneStatus.state === "testing") return "testing";
    if (oneByOneStatus.state === "success") return "success";
    if (oneByOneStatus.state === "failed") return oneByOneStatus.error ? `failed: ${oneByOneStatus.error}` : "failed";
    return null;
  };

  const rowStatus = connection.isActive === false
    ? "paused"
    : ["active", "success"].includes(effectiveStatus)
      ? "ok"
      : ["error", "expired", "unavailable"].includes(effectiveStatus)
        ? "error"
        : "pending";
  const oneByOneLabel = getOneByOneLabel();
  const oneByOneTone = { success: "success", error: "danger", primary: "accent" }[getOneByOneVariant()] || "neutral";
  const hasProxyPools = (proxyPools || []).length > 0;

  return (
    <div className={cn("group flex min-w-0 items-center gap-3 px-3 py-2.5 max-md:flex-wrap max-md:gap-y-1", connection.isActive === false && "opacity-55")}>
      {/* Priority */}
      <div className="flex shrink-0 flex-col text-text-subtle max-md:-my-2 max-md:-ml-3 max-md:-mr-2">
        <button type="button" onClick={onMoveUp} disabled={isFirst} aria-label="Move up" className="rounded leading-none hover:text-text disabled:opacity-25 max-md:inline-flex max-md:size-10 max-md:items-center max-md:justify-center">
          <Icon name="keyboard_arrow_up" size={16} />
        </button>
        <button type="button" onClick={onMoveDown} disabled={isLast} aria-label="Move down" className="rounded leading-none hover:text-text disabled:opacity-25 max-md:inline-flex max-md:size-10 max-md:items-center max-md:justify-center">
          <Icon name="keyboard_arrow_down" size={16} />
        </button>
      </div>

      <StatusDot status={rowStatus} live={oneByOneStatus?.state === "testing"} />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px]">{displayName}</span>
          {secondaryDisplayName && <span className="truncate text-[11px] text-text-subtle">{secondaryDisplayName}</span>}
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
          <span className="inline-flex shrink-0 items-center gap-1"><Icon name={authIcon} size={12} />{authLabel}</span>
          <span className="shrink-0 tabular-nums">#{connection.priority}</span>
          {connection.globalPriority && <span className="shrink-0">auto {connection.globalPriority}</span>}
          {hasAnyProxy && (
            <Tag tone={proxyBadgeVariant === "success" ? "success" : proxyBadgeVariant === "error" ? "danger" : "neutral"} className="max-w-[260px] truncate" title={[proxyDisplayText, maskedProxyUrl, noProxyText && `no_proxy: ${noProxyText}`].filter(Boolean).join(" · ")}>
              <Icon name="lan" size={11} /> {boundProxyPool ? boundProxyPool.name : "Proxy"}
            </Tag>
          )}
          {connection.providerSpecificData?.tlsImpersonation && (
            <Tag tone="neutral" title={`Browser TLS fingerprint: ${connection.providerSpecificData.tlsImpersonation.browser} / ${connection.providerSpecificData.tlsImpersonation.os}`}>
              <Icon name="fingerprint" size={11} /> TLS
            </Tag>
          )}
          {isCooldown && connection.isActive !== false && <CooldownTimer until={modelLockUntil} />}
          {oneByOneLabel && <Tag tone={oneByOneTone}>{oneByOneLabel}</Tag>}
          {connection.lastError && connection.isActive !== false && (
            <span className="min-w-0 max-w-full truncate text-danger-text sm:max-w-[320px]" title={connection.lastError}>
              {connection.lastError}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 max-md:order-last max-md:-mb-1 max-md:basis-full max-md:justify-end transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
        {hasProxyPools && (
          <>
            <IconButton
              ref={proxyBtnRef}
              icon={updatingProxy ? "progress_activity" : "lan"}
              label="Proxy"
              onClick={toggleProxyDropdown}
              disabled={updatingProxy}
              className={cn(hasAnyProxy && "text-accent-text", updatingProxy && "[&_.material-symbols-outlined]:animate-spin")}
            />
            {showProxyDropdown && createPortal(
              <div ref={proxyDropdownRef} style={proxyDropdownStyle} className="z-[90] min-w-44 max-w-[78vw] overflow-y-auto rounded-xl border border-border bg-surface py-1 text-[13px] shadow-elev">
                {[{ id: "__none__", name: "No proxy" }, ...(proxyPools || [])].map((pool) => {
                  const selected = pool.id === "__none__" ? !boundProxyPoolId : boundProxyPoolId === pool.id;
                  return (
                    <button
                      key={pool.id}
                      type="button"
                      onClick={() => handleSelectProxy(pool.id)}
                      className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2", selected && "text-accent-text")}
                    >
                      <span className="flex-1 truncate">{pool.name}</span>
                      {selected && <Icon name="check" size={16} />}
                    </button>
                  );
                })}
              </div>,
              document.body,
            )}
          </>
        )}
        {autoPing && (
          <IconButton icon="bolt" label={autoPingTooltip} onClick={autoPing.onConfigure} className={cn(autoPing.isActive && "text-accent-text")} />
        )}
        <IconButton icon="edit" label="Edit account" onClick={onEdit} />
        <IconButton icon="delete" label="Delete account" onClick={onDelete} className="hover:bg-danger-soft hover:text-danger-text" />
      </div>
      <Switch
        checked={connection.isActive ?? true}
        onChange={onToggleActive}
        label={(connection.isActive ?? true) ? "Disable account" : "Enable account"}
      />
    </div>
  );
}

ConnectionRow.propTypes = {
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    displayName: PropTypes.string,
    modelLockUntil: PropTypes.string,
    testStatus: PropTypes.string,
    isActive: PropTypes.bool,
    lastError: PropTypes.string,
    priority: PropTypes.number,
    globalPriority: PropTypes.number,
  }).isRequired,
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    proxyUrl: PropTypes.string,
    noProxy: PropTypes.string,
    isActive: PropTypes.bool,
  })),
  isOAuth: PropTypes.bool.isRequired,
  isFirst: PropTypes.bool.isRequired,
  isLast: PropTypes.bool.isRequired,
  onMoveUp: PropTypes.func.isRequired,
  onMoveDown: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
  onUpdateProxy: PropTypes.func,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  oneByOneStatus: PropTypes.shape({
    state: PropTypes.string,
    error: PropTypes.string,
  }),
  autoPing: PropTypes.shape({
    isActive: PropTypes.bool,
    provider: PropTypes.string,
    reactiveOn: PropTypes.bool,
    scheduleOn: PropTypes.bool,
    scheduleSummary: PropTypes.string,
    onConfigure: PropTypes.func,
  }),
};
