import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { RefreshCw } from "lucide-react";
import { useAppData } from "../../contexts/AppDataContext";

/**
 * Freshness indicator (MOBILE-DESIGN-SPEC.md — Design Principles #1):
 *  - WS connected  → "● Live"
 *  - WS connecting → "Reconnecting…"
 *  - otherwise     → "Updated Xs ago"; tapping forces a refresh.
 */
export function FreshnessPill() {
  const { realtimeStatus, lastFetchTime, refreshFleetOverview } = useAppData();
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 10_000);
    return () => window.clearInterval(id);
  }, []);

  const live = realtimeStatus === "connected";
  const connecting = realtimeStatus === "connecting";

  let label: string;
  let color: string;
  if (live) {
    label = "Live";
    color = "var(--th-status-online)";
  } else if (connecting) {
    label = "Reconnecting…";
    color = "var(--th-status-warning)";
  } else {
    color = "var(--th-text-muted)";
    if (!lastFetchTime) {
      label = "Updated —";
    } else {
      const s = Math.max(0, Math.round((Date.now() - lastFetchTime) / 1000));
      label = s < 60 ? `Updated ${s}s ago` : `Updated ${Math.floor(s / 60)}m ago`;
    }
  }

  const handleTap = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await refreshFleetOverview(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleTap()}
      aria-label={live ? "Live data" : `${label} — tap to refresh`}
      className="th-status-chip flex-none"
      style={{ "--chip-tone": color, color } as CSSProperties}
    >
      {busy ? <RefreshCw className="h-3 w-3 animate-spin" /> : <i aria-hidden="true" className={live ? "m-live-dot" : undefined} />}
      {label}
    </button>
  );
}
