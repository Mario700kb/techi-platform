import { useEffect, useRef, useState } from "react";
import { Bell, CheckCircle, XCircle } from "lucide-react";
import { Alert, AlertSeverity } from "../types/alert";
import { resolveAlert } from "../api/alerts";

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
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function NotificationCenter({
  alerts,
  totalOpen,
  onDeviceJump,
  onAlertResolved,
}: NotificationCenterProps) {
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

  const handleToggle = () => {
    if (!open && buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect();
      setPanelStyle((prev) => ({
        ...prev,
        top: r.bottom + 6,
        left: Math.max(8, r.right - 360),
      }));
    }
    setOpen((v) => !v);
  };

  const handleResolveAll = async () => {
    for (const alert of alerts) {
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
        className={`relative flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors duration-150 ${
          open
            ? "border-techi-orange/50 bg-techi-orange/10 text-white"
            : "border-white/10 bg-white/[0.04] text-slate-300 hover:border-white/20 hover:text-white"
        }`}
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

      {/* Panel — always in DOM, animated via CSS */}
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
        className="overflow-hidden rounded-lg border border-white/[0.09] bg-[#0d0f1c] shadow-[0_8px_40px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.04)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Active Alerts
          </span>
          {alerts.length > 0 && (
            <button
              type="button"
              onClick={() => void handleResolveAll()}
            className="text-[11px] font-medium text-slate-400 transition hover:text-slate-200"
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
                <p className="text-xs font-medium text-slate-300">Fleet operating normally</p>
                <p className="mt-0.5 text-[11px] text-slate-500">No active incidents</p>
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.04]">
              {alerts.map((alert) => (
                <li
                  key={alert.id}
                  className="group flex cursor-pointer items-start gap-3 px-4 py-2.5 transition-colors hover:bg-white/[0.04]"
                  onClick={() => { onDeviceJump?.(alert.device_id); setOpen(false); }}
                >
                  <span className={`mt-[5px] h-1.5 w-1.5 flex-none rounded-full ${severityDot(alert.severity)}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-semibold leading-snug text-slate-50">
                      {alert.message}
                    </p>
                    <p className="mt-0.5 text-[10px] font-medium">
                      <span className={`font-semibold ${severityText(alert.severity)}`}>{alert.severity}</span>
                      <span className="text-slate-500"> · </span>
                      <span className="text-slate-400">{kindLabel(alert.kind)}</span>
                    </p>
                  </div>
                  <div className="flex flex-none flex-col items-end gap-1.5">
                    <span className="text-[10px] font-medium tabular-nums text-slate-400">{timeAgo(alert.created_at)} ago</span>
                    <button
                      type="button"
                      title="Resolve"
                      onClick={(e) => void handleResolve(e, alert.id)}
                      disabled={resolving.has(alert.id)}
                      className="rounded p-0.5 text-slate-500 opacity-0 transition hover:text-emerald-300 group-hover:opacity-100 disabled:opacity-30"
                    >
                      <XCircle className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-white/[0.05] px-4 py-2">
          <p className="text-center text-[10px] font-medium text-slate-500">
            {alerts.length > 0 ? "Click alert to jump to device · hover row to dismiss" : "All systems nominal"}
          </p>
        </div>
      </div>
    </div>
  );
}
