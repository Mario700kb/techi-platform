import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, WifiOff, Cpu, MemoryStick, HardDrive, Zap, Key } from "lucide-react";
import { useAppData } from "../contexts/AppDataContext";
import { resolveAlert } from "../api/alerts";
import { Alert, AlertKind, AlertSeverity } from "../types/alert";
import { parseUTC } from "../utils/time";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diffMs = Date.now() - parseUTC(iso).getTime();
  const mins = diffMs / 60_000;
  const hours = diffMs / 3_600_000;
  const days = diffMs / 86_400_000;
  if (mins < 2) return "Just now";
  if (hours < 1) return `${Math.floor(mins)}m ago`;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(days)}d ago`;
}

const KIND_LABEL: Record<AlertKind, string> = {
  device_offline: "Device Offline",
  repeated_reconnects: "Repeated Reconnects",
  high_cpu: "High CPU",
  high_ram: "High RAM",
  low_disk: "Low Disk",
  rustdesk_sync_failure: "RS Sync Failure",
  heartbeat_stale: "Heartbeat Stale",
  telemetry_missing: "Telemetry Missing",
  token_usage_warning: "Token Warning",
  token_usage_critical: "Token Critical",
};

const SEVERITY_COLOR: Record<AlertSeverity, { text: string; bg: string; border: string; dot: string }> = {
  critical: { text: "#f87171", bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.28)", dot: "bg-red-400" },
  warning:  { text: "#fbbf24", bg: "rgba(251,191,36,0.1)",  border: "rgba(251,191,36,0.28)",  dot: "bg-amber-400" },
  info:     { text: "#60a5fa", bg: "rgba(96,165,250,0.1)",  border: "rgba(96,165,250,0.25)",  dot: "bg-blue-400" },
};

function KindIcon({ kind, className }: { kind: AlertKind; className?: string }) {
  const cls = className ?? "h-4 w-4";
  if (kind === "device_offline" || kind === "heartbeat_stale") return <WifiOff className={cls} />;
  if (kind === "high_cpu") return <Cpu className={cls} />;
  if (kind === "high_ram") return <MemoryStick className={cls} />;
  if (kind === "low_disk") return <HardDrive className={cls} />;
  if (kind === "repeated_reconnects") return <Zap className={cls} />;
  if (kind === "token_usage_warning" || kind === "token_usage_critical") return <Key className={cls} />;
  return <AlertTriangle className={cls} />;
}

// ─── Filter config ────────────────────────────────────────────────────────────

type FilterId =
  | "all"
  | "critical"
  | "warning"
  | "device_offline"
  | "high_cpu"
  | "high_ram"
  | "token";

const FILTER_PILLS: { id: FilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "critical", label: "Critical" },
  { id: "warning", label: "Warning" },
  { id: "device_offline", label: "Offline" },
  { id: "high_cpu", label: "CPU" },
  { id: "high_ram", label: "RAM" },
  { id: "token", label: "Token" },
];

function applyFilter(alerts: Alert[], f: FilterId): Alert[] {
  if (f === "all") return alerts;
  if (f === "critical") return alerts.filter((a) => a.severity === "critical");
  if (f === "warning") return alerts.filter((a) => a.severity === "warning");
  if (f === "token") return alerts.filter((a) => a.kind === "token_usage_warning" || a.kind === "token_usage_critical");
  return alerts.filter((a) => a.kind === f);
}

// ─── Alert card ───────────────────────────────────────────────────────────────

function AlertCard({
  alert,
  onDismiss,
  dismissing,
}: {
  alert: Alert;
  onDismiss: (id: number) => void;
  dismissing: boolean;
}) {
  const sev = SEVERITY_COLOR[alert.severity] ?? SEVERITY_COLOR.info;
  const isToken = alert.device_id == null;
  const deviceLabel = isToken ? "Token alert" : `Device #${alert.device_id}`;

  return (
    <div
      className="flex items-start gap-3 px-4 py-3.5 transition-colors"
      style={{ borderBottom: "1px solid var(--th-border-subtle)" }}
    >
      {/* Severity dot + kind icon */}
      <div
        className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg"
        style={{ background: sev.bg, border: `1px solid ${sev.border}`, color: sev.text }}
      >
        <KindIcon kind={alert.kind} className="h-4 w-4" />
      </div>

      <div className="min-w-0 flex-1">
        {/* Kind label + time */}
        <div className="flex items-center justify-between gap-2">
          <span
            className="text-[13px] font-bold leading-tight"
            style={{ color: "var(--th-text-primary)" }}
          >
            {KIND_LABEL[alert.kind] ?? alert.kind}
          </span>
          <span
            className="flex-none text-[10px] font-semibold tabular-nums"
            style={{ color: "var(--th-text-muted)" }}
          >
            {timeAgo(alert.created_at)}
          </span>
        </div>

        {/* Device label + severity badge */}
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="text-[11px] font-semibold" style={{ color: "var(--th-text-secondary)" }}>
            {deviceLabel}
          </span>
          <span
            className="rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide"
            style={{ color: sev.text, background: sev.bg, border: `1px solid ${sev.border}` }}
          >
            {alert.severity}
          </span>
        </div>

        {/* Message */}
        <p className="mt-1 text-[12px] leading-snug" style={{ color: "var(--th-text-secondary)" }}>
          {alert.message}
        </p>

        {/* Dismiss button */}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={dismissing}
            onClick={() => onDismiss(alert.id)}
            className="rounded-md px-3 py-1.5 text-[11px] font-semibold transition-colors active:opacity-75 disabled:opacity-40"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--th-border-subtle)",
              color: "var(--th-text-muted)",
            }}
          >
            {dismissing ? "Dismissing…" : "Dismiss"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AlertsMobile() {
  const navigate = useNavigate();
  const { alerts, reloadAlerts } = useAppData();
  const [activeFilter, setActiveFilter] = useState<FilterId>("all");
  const [dismissingIds, setDismissingIds] = useState<Set<number>>(new Set());

  const filtered = applyFilter(alerts, activeFilter);

  const handleDismiss = async (alertId: number) => {
    setDismissingIds((prev) => new Set([...prev, alertId]));
    try {
      await resolveAlert(alertId);
      reloadAlerts();
    } catch {
      // silently ignore — badge will self-correct on next poll
    } finally {
      setDismissingIds((prev) => {
        const next = new Set(prev);
        next.delete(alertId);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col" style={{ minHeight: "calc(100dvh - 112px)" }}>
      {/* Mobile UI 2.0: the screen title lives in MobileTopBar; the open count
          lives in the BottomNav badge (single source — MOBILE-DESIGN-SPEC.md). */}

      {/* ── Filter pills ── */}
      <div
        className="flex gap-2 overflow-x-auto px-4 py-3"
        style={{
          borderBottom: "1px solid var(--th-border-subtle)",
          scrollbarWidth: "none",
          WebkitOverflowScrolling: "touch",
        } as React.CSSProperties}
      >
        {FILTER_PILLS.map(({ id, label }) => {
          const active = activeFilter === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveFilter(id)}
              className="flex-none rounded-full px-3 py-1.5 text-[12px] font-semibold transition-all active:opacity-75"
              style={{
                background: active ? "rgba(249,115,22,0.15)" : "rgba(255,255,255,0.05)",
                border: `1px solid ${active ? "rgba(249,115,22,0.35)" : "rgba(255,255,255,0.1)"}`,
                color: active ? "#fb923c" : "var(--th-text-secondary)",
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* ── Alert list ── */}
      <div
        className="flex-1 overflow-y-auto rounded-xl"
        style={{ background: "var(--th-bg-card)", margin: "12px" }}
      >
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12">
            <CheckCircle2 className="h-10 w-10 text-emerald-400" />
            <p className="text-[14px] font-semibold text-emerald-400">No active alerts</p>
            <p className="text-center text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              {activeFilter !== "all" ? "Try a different filter" : "All systems healthy"}
            </p>
            {activeFilter !== "all" && (
              <button
                type="button"
                onClick={() => setActiveFilter("all")}
                className="mt-1 rounded-lg px-4 py-2 text-[12px] font-semibold"
                style={{ background: "rgba(255,255,255,0.06)", color: "var(--th-text-secondary)" }}
              >
                Show all
              </button>
            )}
          </div>
        ) : (
          filtered.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              onDismiss={(id) => void handleDismiss(id)}
              dismissing={dismissingIds.has(alert.id)}
            />
          ))
        )}
      </div>

      {/* ── Footer link ── */}
      <div className="px-4 pb-2 pt-1 text-center">
        <button
          type="button"
          onClick={() => navigate("/devices?filter=needs_attention")}
          className="text-[11px] font-semibold transition-opacity active:opacity-70"
          style={{ color: "var(--th-text-muted)" }}
        >
          View affected devices →
        </button>
      </div>
    </div>
  );
}
