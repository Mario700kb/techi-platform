import type { CSSProperties, ReactNode } from "react";
import { useNow } from "../hooks/useNow";
import { presenceView, type PresenceFields } from "../utils/devicePresence";

interface DeviceStatusChipProps {
  device: PresenceFields;
  /**
   * chip: one pill, "● Online · live" (headers, cards).
   * stacked: the same words on two lines, for table rows ("● Online" over "2m ago").
   */
  layout?: "chip" | "stacked";
  /** A likely cause shown after the detail, in stacked rows ("Site?"). */
  hint?: { label: string; title?: string } | null;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * The device status everywhere it is shown: online (live, or the heartbeat's
 * age), stale, offline with the reason and since when. It re-renders on the
 * shared clock, so a device turns stale at 6 minutes and offline at 25 on
 * screen without a refetch; events change it at once.
 */
export function DeviceStatusChip({ device, layout = "chip", hint, className, style, children }: DeviceStatusChipProps) {
  useNow();
  const view = presenceView(device);
  const dot = (
    <i
      aria-hidden="true"
      className="th-devstatus-dot"
      data-state={view.state}
      data-live={view.live || undefined}
      data-reconnecting={view.reconnecting || undefined}
    />
  );

  if (layout === "stacked") {
    // In a table row the time comes first ("2d ago · No heartbeat"): when the
    // column is narrow it is the reason, still in the tooltip, that gets "…".
    const detail =
      view.state === "offline" && view.since ? [view.since, view.reason].filter(Boolean).join(" · ") : view.detail;
    return (
      <span
        className={`th-devstatus th-devstatus-stacked ${className ?? ""}`}
        style={{ "--chip-tone": view.tone, ...style } as CSSProperties}
        title={hint ? `${view.title} · Likely cause: ${hint.label}` : view.title}
        data-state={view.state}
        data-presence-live={view.live || undefined}
        data-testid="device-status"
      >
        <span className="th-devstatus-main">
          {dot}
          <span className="th-devstatus-label">{view.label}</span>
          {children}
        </span>
        <span className="th-devstatus-detail">
          {detail}
          {hint && (
            <span title={hint.title ?? "Likely cause (inferred)"}>
              {detail ? " · " : ""}
              {hint.label}
            </span>
          )}
        </span>
      </span>
    );
  }

  return (
    <span
      className={`th-status-chip th-devstatus ${className ?? ""}`}
      style={{ "--chip-tone": view.tone, ...style } as CSSProperties}
      title={view.title}
      data-state={view.state}
      data-presence-live={view.live || undefined}
      data-testid="device-status"
    >
      {dot}
      <span className="th-devstatus-label">{view.label}</span>
      {view.detail && (
        <>
          <span className="th-devstatus-sep" aria-hidden="true">
            ·
          </span>
          <span className="th-devstatus-detail">{view.detail}</span>
        </>
      )}
      {children}
    </span>
  );
}
