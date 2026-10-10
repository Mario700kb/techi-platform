import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ChevronRight, WifiOff, Cpu, MemoryStick, HardDrive, Zap, Key } from "lucide-react";
import { useAppData } from "../contexts/AppDataContext";
import { resolveAlert } from "../api/alerts";
import { getDevice } from "../api/devices";
import { Alert, AlertKind, AlertSeverity } from "../types/alert";
import { deviceDisplayName } from "../utils/deviceLabel";
import { parseUTC } from "../utils/time";
import { Pill } from "../components/mobile/primitives";
import { Snackbar } from "../components/mobile/Snackbar";
import { PageHeader } from "../components/ui";

/**
 * Alerts — Mobile UI 2.0 (docs/reference/MOBILE-DESIGN-SPEC.md — Alerts).
 * Grouped by device (not a flat "Device #93" list — audit finding), each
 * alert dismiss is undo-able for 5s (resolveAlert is only actually called
 * once the undo window elapses — there is no "reopen" endpoint, so undo
 * works by deferring the call rather than reversing it).
 */

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

const SEVERITY_VAR: Record<AlertSeverity, string> = {
  critical: "var(--th-status-critical)",
  warning: "var(--th-status-warning)",
  info: "var(--th-status-info)",
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

type FilterId = "all" | "critical" | "warning" | "device_offline" | "high_cpu" | "high_ram" | "low_disk" | "token";

const FILTER_PILLS: { id: FilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "critical", label: "Critical" },
  { id: "warning", label: "Warning" },
  { id: "device_offline", label: "Offline" },
  { id: "high_cpu", label: "CPU" },
  { id: "high_ram", label: "RAM" },
  { id: "low_disk", label: "Disk" },
  { id: "token", label: "Token" },
];

function applyFilter(alerts: Alert[], f: FilterId): Alert[] {
  if (f === "all") return alerts;
  if (f === "critical") return alerts.filter((a) => a.severity === "critical");
  if (f === "warning") return alerts.filter((a) => a.severity === "warning");
  if (f === "token") return alerts.filter((a) => a.kind === "token_usage_warning" || a.kind === "token_usage_critical");
  return alerts.filter((a) => a.kind === f);
}

interface DeviceLabel {
  name: string;
  client: string | null;
}

function AlertItem({ alert, onDismiss }: { alert: Alert; onDismiss: (id: number) => void }) {
  const color = SEVERITY_VAR[alert.severity] ?? SEVERITY_VAR.info;
  return (
    <div className="flex items-start gap-[10px] px-4 py-[11px]" style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
      <span className="mt-[2px] w-[3px] self-stretch flex-none rounded-full" style={{ background: color }} />
      <div
        className="mt-[1px] flex h-8 w-8 flex-none items-center justify-center rounded-lg"
        style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 26%, transparent)`, color }}
      >
        <KindIcon kind={alert.kind} className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-bold" style={{ color: "var(--th-text-primary)" }}>
            {KIND_LABEL[alert.kind] ?? alert.kind}
          </span>
          <time className="ml-auto flex-none text-[11px] font-semibold" style={{ color: "var(--th-text-muted)" }}>
            {timeAgo(alert.created_at)}
          </time>
        </div>
        <p className="mt-[3px] text-[12px] leading-snug" style={{ color: "var(--th-text-secondary)" }}>
          {alert.message}
        </p>
        <button
          type="button"
          onClick={() => onDismiss(alert.id)}
          className="mt-[8px] rounded-md px-3 py-[6px] text-[12px] font-bold"
          style={{ background: "var(--th-chip-bg)", border: "1px solid var(--th-border-subtle)", color: "var(--th-text-muted)" }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function AlertGroup({
  deviceId,
  label,
  alerts,
  onDismiss,
  onDismissAll,
  onOpenDevice,
}: {
  deviceId: number | null;
  label: DeviceLabel;
  alerts: Alert[];
  onDismiss: (id: number) => void;
  onDismissAll: (ids: number[]) => void;
  onOpenDevice: (deviceId: number) => void;
}) {
  return (
    <div className="overflow-hidden rounded-[14px]" style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}>
      <div
        className="flex min-h-[48px] w-full items-center gap-[10px] px-4 py-[11px]"
        style={{ borderBottom: "1px solid var(--th-border-subtle)" }}
      >
        <button
          type="button"
          onClick={() => deviceId != null && onOpenDevice(deviceId)}
          disabled={deviceId == null}
          className="flex min-w-0 flex-1 items-center gap-[6px] text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-extrabold" style={{ color: "var(--th-text-primary)" }}>
              {label.name}
            </span>
            {label.client && (
              <span className="block truncate text-[12px] font-semibold" style={{ color: "var(--th-text-muted)" }}>
                {label.client}
              </span>
            )}
          </span>
          {deviceId != null && <ChevronRight className="h-4 w-4 flex-none" style={{ color: "var(--th-text-muted)" }} />}
        </button>
        {alerts.length > 1 && (
          <button
            type="button"
            onClick={() => onDismissAll(alerts.map((a) => a.id))}
            className="flex-none rounded-md px-[10px] py-[6px] text-[11px] font-bold"
            style={{ background: "var(--th-chip-bg)", color: "var(--th-text-muted)" }}
          >
            Dismiss all ({alerts.length})
          </button>
        )}
      </div>
      {alerts.map((a) => (
        <AlertItem key={a.id} alert={a} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

export default function AlertsMobile() {
  const navigate = useNavigate();
  const { alerts, reloadAlerts } = useAppData();
  const [activeFilter, setActiveFilter] = useState<FilterId>("all");
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(new Set());
  const [deviceLabels, setDeviceLabels] = useState<Record<number, DeviceLabel>>({});
  const [snackMessage, setSnackMessage] = useState<string | null>(null);

  const pendingRef = useRef<{ ids: number[]; timer: number } | null>(null);

  const filtered = useMemo(
    () => applyFilter(alerts, activeFilter).filter((a) => !hiddenIds.has(a.id)),
    [alerts, activeFilter, hiddenIds],
  );

  // Resolve device names for any device_id we haven't looked up yet.
  useEffect(() => {
    const missing = Array.from(new Set(alerts.map((a) => a.device_id).filter((id): id is number => id != null)))
      .filter((id) => !deviceLabels[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (id) => {
        try {
          const d = await getDevice(id);
          return [id, { name: deviceDisplayName(d), client: d.client_name ?? null }] as const;
        } catch {
          return [id, { name: `Device #${id}`, client: null }] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setDeviceLabels((prev) => {
        const next = { ...prev };
        for (const [id, label] of entries) next[id] = label;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [alerts, deviceLabels]);

  const flushPending = () => {
    const pending = pendingRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingRef.current = null;
    for (const id of pending.ids) void resolveAlert(id).catch(() => undefined);
    reloadAlerts();
  };

  const dismissIds = (ids: number[]) => {
    // A new dismiss commits any prior pending one immediately.
    flushPending();
    setHiddenIds((prev) => new Set([...prev, ...ids]));
    const timer = window.setTimeout(() => {
      pendingRef.current = null;
      for (const id of ids) void resolveAlert(id).catch(() => undefined);
      reloadAlerts();
    }, 5000);
    pendingRef.current = { ids, timer };
    setSnackMessage(ids.length > 1 ? `${ids.length} alerts dismissed` : "Alert dismissed");
  };

  const handleUndo = () => {
    const pending = pendingRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingRef.current = null;
    setHiddenIds((prev) => {
      const next = new Set(prev);
      for (const id of pending.ids) next.delete(id);
      return next;
    });
    setSnackMessage(null);
  };

  const handleReload = async () => {
    flushPending();
    reloadAlerts();
  };

  // Commit any pending dismissal if the user navigates away.
  useEffect(() => () => flushPending(), []);

  const groups = useMemo(() => {
    const byDevice = new Map<number | "token", Alert[]>();
    for (const a of filtered) {
      const key = a.device_id ?? "token";
      const list = byDevice.get(key) ?? [];
      list.push(a);
      byDevice.set(key, list);
    }
    return Array.from(byDevice.entries())
      .map(([key, list]) => ({
        deviceId: key === "token" ? null : key,
        alerts: list.sort((a, b) => b.created_at.localeCompare(a.created_at)),
      }))
      .sort((a, b) => {
        const aWorst = a.alerts.some((x) => x.severity === "critical") ? 0 : 1;
        const bWorst = b.alerts.some((x) => x.severity === "critical") ? 0 : 1;
        return aWorst - bWorst;
      });
  }, [filtered]);

  return (
    <div className="flex flex-col" style={{ minHeight: "calc(100dvh - 112px)" }}>
      <PageHeader
        className="mb-5 hidden md:block"
        title="Alerts"
        description="Open alerts across every managed device, newest first."
      />
      <div
        className="flex gap-2 overflow-x-auto px-1 pb-3"
        style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" } as React.CSSProperties}
      >
        {FILTER_PILLS.map(({ id, label }) => (
          <Pill key={id} active={activeFilter === id} onClick={() => setActiveFilter(id)}>
            {label}
          </Pill>
        ))}
        <button
          type="button"
          onClick={() => void handleReload()}
          className="ml-auto flex-none rounded-full px-3 py-[7px] text-[12px] font-bold"
          style={{ background: "var(--th-chip-bg)", color: "var(--th-text-secondary)", border: "1px solid var(--th-border-subtle)" }}
        >
          Refresh
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-[10px]">
        {groups.length === 0 ? (
          <div
            className="flex flex-col items-center gap-3 rounded-[14px] px-6 py-12"
            style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
          >
            <CheckCircle2 className="h-10 w-10" style={{ color: "var(--th-status-online)" }} />
            <p className="text-[14px] font-bold" style={{ color: "var(--th-status-online)" }}>No active alerts</p>
            <p className="text-center text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              {activeFilter !== "all" ? "Try a different filter" : "All systems healthy"}
            </p>
            {activeFilter !== "all" && (
              <button
                type="button"
                onClick={() => setActiveFilter("all")}
                className="mt-1 rounded-lg px-4 py-2 text-[12px] font-bold"
                style={{ background: "var(--th-chip-bg)", color: "var(--th-text-secondary)" }}
              >
                Show all
              </button>
            )}
          </div>
        ) : (
          groups.map(({ deviceId, alerts: groupAlerts }) => (
            <AlertGroup
              key={deviceId ?? "token"}
              deviceId={deviceId}
              label={deviceId != null ? (deviceLabels[deviceId] ?? { name: `Device #${deviceId}`, client: null }) : { name: "Token usage", client: null }}
              alerts={groupAlerts}
              onDismiss={(id) => dismissIds([id])}
              onDismissAll={dismissIds}
              onOpenDevice={(id) => navigate(`/devices/${id}`)}
            />
          ))
        )}
      </div>

      {groups.length > 3 && (
        <button
          type="button"
          onClick={() => navigate("/devices?filter=needs_attention")}
          className="mt-[10px] flex min-h-[44px] items-center justify-center gap-1.5 rounded-[14px] text-[13px] font-bold"
          style={{ background: "var(--th-accent-glow)", border: "1px solid var(--th-accent-border)", color: "var(--th-accent)" }}
        >
          View all affected devices
          <ChevronRight className="h-4 w-4" />
        </button>
      )}

      <Snackbar
        open={snackMessage !== null}
        message={snackMessage ?? ""}
        actionLabel="UNDO"
        onAction={handleUndo}
        onClose={() => setSnackMessage(null)}
      />
    </div>
  );
}
