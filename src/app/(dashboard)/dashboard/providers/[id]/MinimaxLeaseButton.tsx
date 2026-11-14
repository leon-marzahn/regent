"use client";

import { useState } from "react";
import { Button } from "@/ui";
import { translate } from "@/i18n/runtime";

export const MCODE_LEASE_PROVIDERS = new Set(["minimax-code", "minimax-code-global"]);

const FALLBACK_ERROR = "Could not reach the MiniMax Code desktop app";

/**
 * "Use desktop app" for MiniMax Code: adds a connection that borrows the signed-in
 * desktop app's login over its local auth broker. No second sign-in and no stored
 * refresh token; the desktop app keeps owning refresh, so it and regent can share
 * one subscription without their single-use refresh tokens fighting.
 * Works only when the dashboard is opened on the machine running the desktop app,
 * and only on macOS/Linux: the server refuses Windows (its named pipe can't be
 * ownership-checked) and the button shows that message.
 */
export function MinimaxLeaseButton({
  providerId,
  onConnected,
}: {
  providerId: string;
  onConnected?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/oauth/${providerId}/lease-connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : FALLBACK_ERROR);
        return;
      }
      onConnected?.();
    } catch {
      setError(FALLBACK_ERROR);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        icon="desktop_windows"
        loading={busy}
        disabled={busy}
        onClick={connect}
        title={translate(
          "Borrow the signed-in MiniMax Code desktop app's login. Refresh stays with the desktop app.",
        )}
      >
        {translate("Use desktop app")}
      </Button>
      {error && (
        <p role="alert" className="w-full break-words text-xs text-danger-text">
          {error}
        </p>
      )}
    </>
  );
}
