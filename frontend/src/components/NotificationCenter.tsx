import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Bell, CheckCircle, XCircle } from "lucide-react";
import { Alert, AlertSeverity } from "../types/alert";
import { resolveAlert } from "../api/alerts";
import { parseUTC } from "../utils/time";

interface NotificationCenterProps {
  alerts: Alert[];
  totalOpen: number;
  onDeviceJump?: (deviceId: number) => void;
  onAlertResolved?: (alertId: number) => void;
}

function severityDot(severity: AlertSeverity): string {
  if (severity === "critical") return "bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.5)]";
  if (severity === "warning") return "bg-amber-400";
  return "bg-slate-600";
}

function severityText(severity: AlertSeverity): string {
  if (severity === "critical") return "text-red-400";
  if (severity === "warning") return "text-amber-400";
  return "text-slate-400";
}

function timeAgo(iso: string): string {
  const diff = (Date.now() - parseUTC(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Synthetic computed-on-read alerts (negative id); they cannot be resolved
// manually — they clear once the token's max_uses is raised.
function isTokenUsageAlert(alert: Alert): boolean {
  return alert.kind === "token_usage_warning" || alert.kind === "token_usage_critical";
}

const PANEL_MAX_WIDTH = 360;
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
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({
    position: "fixed",
    top: -9999,
    left: -9999,
    width: 360,
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
    setOpen((v) => !v);
  };

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
        className={`th-btn th-btn-secondary relative flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors duration-150 ${
          open ? "border-techi-orange/50 bg-techi-orange/10" : ""
        }`}
        style={open ? { color: "var(--th-text-primary)" } : {
          borderColor: "var(--th-border-default)",
          background: "var(--th-bg-surface)",
          color: "var(--th-text-secondary)",
        }}
      >
        <Bell className={`h-3.5 w-3.5 ${hasCritical ? "text-red-400" : ""}`} />
        {totalOpen > 0 && (
          <span
            className={`flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white ${
              hasCritical ? "bg-red-500" : "bg-amber-500"
            }`}
          >
            {totalOpen > 99 ? "99+" : totalOpen}
          </span>
        )}
        <span className="hidden sm:inline">Alerts</span>
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
            border: "1px solid var(--th-border-card)",
            background: "var(--th-bg-surface)",
          }}
          className="overflow-hidden rounded-lg shadow-[0_8px_40px_rgba(0,0,0,0.4)]"
        >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--th-text-muted)" }}>
            Active Alerts
          </span>
          {alerts.length > 0 && (
            <button
              type="button"
              onClick={() => void handleResolveAll()}
              className="text-[11px] font-medium transition"
              style={{ color: "var(--th-text-muted)" }}
            >
              Resolve all
            </button>
          )}
        </div>

        {/* Body */}
        <div className="max-h-[340px] overflow-y-auto">
          {alerts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10">
              <CheckCircle className="h-5 w-5 text-emerald-500/60" />
              <div className="text-center">
                <p className="text-xs font-medium" style={{ color: "var(--th-text-secondary)" }}>Fleet operating normally</p>
                <p className="mt-0.5 text-[11px]" style={{ color: "var(--th-text-muted)" }}>No active incidents</p>
              </div>
            </div>
          ) : (
            <ul>
              {alerts.map((alert) => (
                <li
                  key={alert.id}
                  className="group flex cursor-pointer items-start gap-3 px-4 py-2.5 transition-colors"
                  style={{ borderBottom: "1px solid var(--th-border-subtle)" }}
                  onClick={() => {
                    if (isTokenUsageAlert(alert)) {
                      navigate("/enrollment-bootstrap");
                    } else if (alert.device_id != null) {
                      onDeviceJump?.(alert.device_id);
                    }
                    setOpen(false);
                  }}
                >
                  <span className={`mt-[5px] h-1.5 w-1.5 flex-none rounded-full ${severityDot(alert.severity)}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-semibold leading-snug" style={{ color: "var(--th-text-primary)" }}>
                      {alert.message}
                    </p>
                    <p className="mt-0.5 text-[10px] font-medium">
                      <span className={`font-semibold ${severityText(alert.severity)}`}>{alert.severity}</span>
                      <span style={{ color: "var(--th-text-muted)" }}> · </span>
                      <span style={{ color: "var(--th-text-tertiary)" }}>{kindLabel(alert.kind)}</span>
                    </p>
                  </div>
                  <div className="flex flex-none flex-col items-end gap-1.5">
                    <span className="text-[10px] font-medium tabular-nums" style={{ color: "var(--th-text-tertiary)" }}>{timeAgo(alert.created_at)} ago</span>
                    {!isTokenUsageAlert(alert) && (
                    <button
                      type="button"
                      title="Resolve"
                      onClick={(e) => void handleResolve(e, alert.id)}
                      disabled={resolving.has(alert.id)}
                      className="rounded p-0.5 opacity-0 transition hover:text-emerald-400 group-hover:opacity-100 disabled:opacity-30"
                      style={{ color: "var(--th-text-muted)" }}
                    >
                      <XCircle className="h-3 w-3" />
                    </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2" style={{ borderTop: "1px solid var(--th-border-subtle)" }}>
          <p className="text-center text-[10px] font-medium" style={{ color: "var(--th-text-muted)" }}>
            {alerts.length > 0 ? "Click alert to jump to device · hover row to dismiss" : "All systems nominal"}
          </p>
        </div>
        </div>,
        document.body
      )}
    </div>
  );
}
