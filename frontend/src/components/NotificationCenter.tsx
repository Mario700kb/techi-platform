import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Activity, ArrowRight, Bell, Check, CheckCircle2, Clock3, Cpu, HardDrive, KeyRound, LucideIcon, MemoryStick, MonitorX, RefreshCw, TriangleAlert, WifiOff } from "lucide-react";
import { Alert, AlertKind } from "../types/alert";
import { resolveAlert } from "../api/alerts";
import { timeAgo } from "../utils/time";

interface NotificationCenterProps {
  alerts: Alert[];
  totalOpen: number;
  onDeviceJump?: (deviceId: number) => void;
  onAlertResolved?: (alertId: number) => void;
}

const KIND_ICON: Partial<Record<AlertKind, LucideIcon>> = {
  device_offline: WifiOff,
  heartbeat_stale: Clock3,
  telemetry_missing: Activity,
  repeated_reconnects: RefreshCw,
  high_cpu: Cpu,
  high_ram: MemoryStick,
  low_disk: HardDrive,
  rustdesk_sync_failure: MonitorX,
  token_usage_warning: KeyRound,
  token_usage_critical: KeyRound,
};

type SeverityFilter = "all" | "critical" | "warning";

function kindLabel(kind: string): string {
  const text = kind.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Synthetic computed-on-read alerts (negative id); they cannot be resolved
// manually — they clear once the token's max_uses is raised.
function isTokenUsageAlert(alert: Alert): boolean {
  return alert.kind === "token_usage_warning" || alert.kind === "token_usage_critical";
}

const PANEL_MAX_WIDTH = 380;
const PANEL_MARGIN = 8;
const PANEL_GAP = 6;

type PanelPosition = {
  top: number;
  left: number;
  width: number;
};

export default function NotificationCenter({
  alerts,
  totalOpen,
  onDeviceJump,
  onAlertResolved,
}: NotificationCenterProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<SeverityFilter>("all");
  const [confirmResolveAll, setConfirmResolveAll] = useState(false);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({
    position: "fixed",
    top: -9999,
    left: -9999,
    width: 380,
    zIndex: 9999,
  });

  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelPositionRef = useRef<PanelPosition | null>(null);
  const frameRef = useRef<number | null>(null);

  // Click-outside
  useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapperRef.current?.contains(t) && !panelRef.current?.contains(t)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouse);
    return () => document.removeEventListener("mousedown", onMouse);
  }, [open]);

  // ESC
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const hasCritical = alerts.some((a) => a.severity === "critical");

  const positionPanel = useCallback(() => {
    if (!buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const width = Math.min(PANEL_MAX_WIDTH, Math.max(240, viewportWidth - PANEL_MARGIN * 2));
    const panelHeight = Math.min(
      panelRef.current?.offsetHeight ?? 430,
      viewportHeight - PANEL_MARGIN * 2
    );
    const left = Math.min(
      Math.max(PANEL_MARGIN, r.right - width),
      viewportWidth - width - PANEL_MARGIN
    );
    const top = Math.min(
      Math.max(PANEL_MARGIN, r.bottom + PANEL_GAP),
      viewportHeight - panelHeight - PANEL_MARGIN
    );
    const nextPosition = {
      width,
      top,
      left,
    };
    const previous = panelPositionRef.current;
    if (
      previous &&
      Math.abs(previous.top - nextPosition.top) < 0.5 &&
      Math.abs(previous.left - nextPosition.left) < 0.5 &&
      Math.abs(previous.width - nextPosition.width) < 0.5
    ) {
      return;
    }
    panelPositionRef.current = nextPosition;
    setPanelStyle((prev) => ({ ...prev, ...nextPosition }));
  }, []);

  useEffect(() => {
    if (!open) return;
    positionPanel();
    const trackAnchor = () => {
      positionPanel();
      frameRef.current = window.requestAnimationFrame(trackAnchor);
    };
    frameRef.current = window.requestAnimationFrame(trackAnchor);
    const onUpdate = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        positionPanel();
      });
    };
    window.addEventListener("resize", onUpdate);
    window.addEventListener("scroll", onUpdate, true);
    window.visualViewport?.addEventListener("resize", onUpdate);
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      window.removeEventListener("resize", onUpdate);
      window.removeEventListener("scroll", onUpdate, true);
      window.visualViewport?.removeEventListener("resize", onUpdate);
    };
  }, [open, positionPanel]);

  const handleToggle = () => {
    if (!open) {
      positionPanel();
    }
    setConfirmResolveAll(false);
    setOpen((v) => !v);
  };

  const resolvable = alerts.filter((a) => !isTokenUsageAlert(a));
  const criticalCount = alerts.filter((a) => a.severity === "critical").length;
  const warningCount = alerts.filter((a) => a.severity === "warning").length;
  const visibleAlerts = filter === "all" ? alerts : alerts.filter((a) => a.severity === filter);

  const handleResolveAll = async () => {
    for (const alert of alerts.filter((a) => !isTokenUsageAlert(a))) {
      setResolving((prev) => new Set(prev).add(alert.id));
      try {
        await resolveAlert(alert.id);
        onAlertResolved?.(alert.id);
      } catch { /* silent */ }
      finally {
        setResolving((prev) => { const n = new Set(prev); n.delete(alert.id); return n; });
      }
    }
  };

  const handleResolve = async (e: React.MouseEvent, alertId: number) => {
    e.stopPropagation();
    setResolving((prev) => new Set(prev).add(alertId));
    try {
      await resolveAlert(alertId);
      onAlertResolved?.(alertId);
    } catch { /* silent */ }
    finally {
      setResolving((prev) => { const n = new Set(prev); n.delete(alertId); return n; });
    }
  };

  return (
    <div ref={wrapperRef}>
      {/* Trigger */}
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        className="th-icon-btn th-icon-btn-ghost relative"
        data-active={open}
        aria-label={totalOpen > 0 ? `Alerts, ${totalOpen} open` : "Alerts"}
        title={totalOpen > 0 ? `${totalOpen} open ${totalOpen === 1 ? "alert" : "alerts"}` : "No open alerts"}
      >
        <Bell className="h-4 w-4" />
        {totalOpen > 0 && (
          <span className="th-count-badge" data-tone={hasCritical ? "critical" : "warning"}>
            {totalOpen > 99 ? "99+" : totalOpen}
          </span>
        )}
      </button>

      {createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Alert notifications"
          style={{
            ...panelStyle,
            opacity: open ? 1 : 0,
            transform: open ? "translateY(0) scale(1)" : "translateY(-4px) scale(0.98)",
            pointerEvents: open ? "auto" : "none",
            transition: "opacity 130ms ease-out, transform 130ms ease-out",
          }}
          className="th-menu"
        >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-3.5">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-semibold" style={{ color: "var(--th-text-primary)" }}>Alerts</h2>
            {totalOpen > 0 && <span className="th-nav-badge">{totalOpen}</span>}
          </div>
          {resolvable.length > 0 && (
            confirmResolveAll ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>Resolve {resolvable.length}?</span>
                <button type="button" className="th-link-btn" onClick={() => setConfirmResolveAll(false)}>Cancel</button>
                <button
                  type="button"
                  className="th-link-btn th-link-btn-primary"
                  onClick={() => { setConfirmResolveAll(false); void handleResolveAll(); }}
                >
                  Confirm
                </button>
              </div>
            ) : (
              <button type="button" className="th-link-btn" onClick={() => setConfirmResolveAll(true)}>
                Resolve all
              </button>
            )
          )}
        </div>

        {alerts.length > 0 && (
          <div className="th-segmented mx-4 mb-2" role="radiogroup" aria-label="Filter alerts by severity">
            {([
              ["all", "All", alerts.length],
              ["critical", "Critical", criticalCount],
              ["warning", "Warning", warningCount],
            ] as const).map(([id, label, count]) => (
              <button key={id} type="button" role="radio" aria-checked={filter === id} onClick={() => setFilter(id)}>
                {label}
                <span className="tabular-nums" style={{ color: "var(--th-text-faint)" }}>{count}</span>
              </button>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="max-h-[360px] overflow-y-auto" style={{ borderTop: "1px solid var(--th-border-subtle)" }}>
          {visibleAlerts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: "color-mix(in srgb, var(--th-status-online) 12%, transparent)", color: "var(--th-status-online)" }}>
                <CheckCircle2 className="h-4 w-4" />
              </span>
              <p className="text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                {alerts.length === 0 ? "All clear" : `No ${filter} alerts`}
              </p>
              <p className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                {alerts.length === 0 ? "No open alerts across the fleet." : "Other severities still have open alerts."}
              </p>
            </div>
          ) : (
            <ul className="py-1">
              {visibleAlerts.map((alert) => {
                const Icon = KIND_ICON[alert.kind] ?? TriangleAlert;
                const canResolve = !isTokenUsageAlert(alert);
                return (
                  <li key={alert.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      className="th-alert-row group"
                      onClick={() => {
                        if (isTokenUsageAlert(alert)) navigate("/onboarding?tab=installer");
                        else if (alert.device_id != null) onDeviceJump?.(alert.device_id);
                        setOpen(false);
                      }}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLElement).click(); }}
                      title={`${alert.severity} · ${kindLabel(alert.kind)}`}
                    >
                      <span className="th-alert-icon" data-severity={alert.severity} aria-label={alert.severity}>
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>{alert.message}</p>
                        <p className="truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>{kindLabel(alert.kind)}</p>
                      </div>
                      <div className="relative flex h-7 w-16 flex-none items-center justify-end">
                        <span className={`text-[12px] tabular-nums ${canResolve ? "group-hover:invisible" : ""}`} style={{ color: "var(--th-text-faint)" }}>
                          {timeAgo(alert.created_at)}
                        </span>
                        {canResolve && (
                          <button
                            type="button"
                            title="Resolve alert"
                            aria-label="Resolve alert"
                            onClick={(e) => void handleResolve(e, alert.id)}
                            disabled={resolving.has(alert.id)}
                            className="th-icon-btn th-icon-btn-ghost invisible absolute right-0 top-0 !min-h-7 !min-w-7 group-hover:visible disabled:opacity-40"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <button
          type="button"
          className="th-menu-item justify-center gap-1.5 py-2.5 text-[12px]"
          style={{ borderTop: "1px solid var(--th-border-subtle)" }}
          onClick={() => { setOpen(false); navigate("/alerts"); }}
        >
          View all alerts <ArrowRight className="h-3.5 w-3.5" />
        </button>
        </div>,
        document.body
      )}
    </div>
  );
}
