import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  KeyRound,
  Monitor,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import AlertKindIcon from "../components/AlertKindIcon";
import AlertDrawer from "../components/alerts/AlertDrawer";
import { PriorityChip, ResolveModal } from "../components/alerts/AlertControls";
import { useAppData } from "../contexts/AppDataContext";
import { ManualResolution, resolveAlert } from "../api/alerts";
import { Alert, ALERT_SEVERITY_TONE } from "../types/alert";
import { alertDeadline } from "../utils/alertDeadline";
import { describeAlert } from "../utils/alertText";
import { parseUTC } from "../utils/time";
import { Snackbar } from "../components/mobile/Snackbar";
import { Button, EmptyState, PageHeader } from "../components/ui";

/**
 * Alerts — Mobile UI 2.0 (docs/reference/MOBILE-DESIGN-SPEC.md — Alerts).
 * Grouped by device (not a flat "Device #93" list — audit finding). Resolve
 * asks why, as on desktop: a reason the Quality view can count, not a
 * silent "fixed".
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
  // Disk covers both a full disk and one forecast to fill up.
  if (f === "low_disk") return alerts.filter((a) => a.kind === "low_disk" || a.kind === "disk_forecast");
  return alerts.filter((a) => a.kind === f);
}

interface DeviceLabel {
  name: string;
  client: string | null;
}

function AlertItem({
  alert,
  onResolve,
  onOpen,
}: {
  alert: Alert;
  onResolve: (id: number) => void;
  onOpen: (id: number) => void;
}) {
  const color = ALERT_SEVERITY_TONE[alert.severity] ?? ALERT_SEVERITY_TONE.info;
  const { title, summary } = describeAlert(alert);
  const deadline = alertDeadline(alert);
  return (
    <div className="th-malert">
      <span className="th-onb-icon !h-8 !w-8 flex-none" style={{ "--onb-tone": color } as CSSProperties}>
        <AlertKindIcon kind={alert.kind} className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {alert.priority != null && <PriorityChip priority={alert.priority} />}
          <span className="min-w-0 truncate text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
            {title}
            {(alert.occurrences ?? 1) > 1 && <span className="th-ac-times">×{alert.occurrences}</span>}
          </span>
          <time className="ml-auto flex-none text-[12px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
            {timeAgo(alert.created_at)}
          </time>
        </div>
        <p className="mt-0.5 text-[13px] leading-snug" style={{ color: "var(--th-text-secondary)" }}>
          {alert.summary ? summary : alert.message}
        </p>
        {deadline && (
          <p className="mt-0.5 text-[12px] tabular-nums" style={{ color: deadline.tone }} title={deadline.title}>
            {deadline.label}
            {alert.assigned_to_name ? ` · ${alert.assigned_to_name}` : " · no owner"}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          {alert.id > 0 && (
            <button type="button" onClick={() => onOpen(alert.id)} className="th-malert-dismiss">
              <Sparkles className="h-3.5 w-3.5" />
              Details
            </button>
          )}
          <button type="button" onClick={() => onResolve(alert.id)} className="th-malert-dismiss">
            <Check className="h-3.5 w-3.5" />
            Resolve
          </button>
        </div>
      </div>
    </div>
  );
}

function AlertGroup({
  deviceId,
  label,
  alerts,
  onResolve,
  onResolveAll,
  onOpenDevice,
  onOpenAlert,
}: {
  deviceId: number | null;
  label: DeviceLabel;
  alerts: Alert[];
  onResolve: (id: number) => void;
  onResolveAll: (ids: number[]) => void;
  onOpenDevice: (deviceId: number) => void;
  onOpenAlert: (id: number) => void;
}) {
  const worst = alerts.some((a) => a.severity === "critical")
    ? "critical"
    : alerts.some((a) => a.severity === "warning")
      ? "warning"
      : "info";
  const tone = ALERT_SEVERITY_TONE[worst] ?? ALERT_SEVERITY_TONE.info;
  return (
    <section
      className="th-onb-card overflow-hidden th-onb-enter"
      style={{ "--row-tone": tone } as CSSProperties}
      data-severity={worst}
    >
      <div className="th-malert-head">
        <button
          type="button"
          onClick={() => deviceId != null && onOpenDevice(deviceId)}
          disabled={deviceId == null}
          className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default disabled:opacity-100"
        >
          <span className="th-onb-icon !h-9 !w-9 flex-none" style={{ "--onb-tone": tone } as CSSProperties}>
            {deviceId != null ? <Monitor className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
              {label.name}
            </span>
            <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              {label.client ? `${label.client} · ` : ""}
              {alerts.length} open alert{alerts.length === 1 ? "" : "s"}
            </span>
          </span>
          {deviceId != null && <ChevronRight className="h-4 w-4 flex-none" style={{ color: "var(--th-text-faint)" }} />}
        </button>
      </div>
      {alerts.map((a) => (
        <AlertItem key={a.id} alert={a} onResolve={onResolve} onOpen={onOpenAlert} />
      ))}
      {alerts.length > 1 && (
        <button type="button" onClick={() => onResolveAll(alerts.map((a) => a.id))} className="th-malert-all">
          <CheckCheck className="h-4 w-4" />
          Resolve all ({alerts.length})
        </button>
      )}
    </section>
  );
}

export default function AlertsMobile() {
  const navigate = useNavigate();
  const { alerts, reloadAlerts } = useAppData();
  const [openAlertId, setOpenAlertId] = useState<number | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterId>("all");
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(new Set());
  const [snackMessage, setSnackMessage] = useState<string | null>(null);
  const [resolving, setResolving] = useState<number[] | null>(null);

  const filtered = useMemo(
    () => applyFilter(alerts, activeFilter).filter((a) => !hiddenIds.has(a.id)),
    [alerts, activeFilter, hiddenIds],
  );

  const resolveIds = async (ids: number[], resolution: ManualResolution, note: string) => {
    await Promise.all(ids.map((id) => resolveAlert(id, resolution, note).catch(() => undefined)));
    setHiddenIds((prev) => new Set([...prev, ...ids]));
    setResolving(null);
    setSnackMessage(ids.length > 1 ? `${ids.length} alerts resolved` : "Alert resolved");
    reloadAlerts();
  };

  const handleReload = () => reloadAlerts();

  const groups = useMemo(() => {
    const byDevice = new Map<number | "token", Alert[]>();
    for (const a of filtered) {
      const key = a.device_id ?? "token";
      const list = byDevice.get(key) ?? [];
      list.push(a);
      byDevice.set(key, list);
    }
    return (
      Array.from(byDevice.entries())
        .map(([key, list]) => ({
          deviceId: key === "token" ? null : key,
          alerts: list.sort((a, b) => b.created_at.localeCompare(a.created_at)),
        }))
        // Critical devices first, then the device whose latest alert is newest.
        .sort((a, b) => {
          const aWorst = a.alerts.some((x) => x.severity === "critical") ? 0 : 1;
          const bWorst = b.alerts.some((x) => x.severity === "critical") ? 0 : 1;
          return aWorst - bWorst || b.alerts[0].created_at.localeCompare(a.alerts[0].created_at);
        })
    );
  }, [filtered]);

  const filterCounts = useMemo(() => {
    const visible = alerts.filter((a) => !hiddenIds.has(a.id));
    return Object.fromEntries(FILTER_PILLS.map(({ id }) => [id, applyFilter(visible, id).length])) as Record<
      FilterId,
      number
    >;
  }, [alerts, hiddenIds]);
  const shownFilters = FILTER_PILLS.filter(({ id }) => id === "all" || filterCounts[id] > 0 || id === activeFilter);
  const affectedDevices = new Set(
    alerts.filter((a) => !hiddenIds.has(a.id) && a.device_id != null).map((a) => a.device_id),
  ).size;
  const stats = [
    {
      label: "Critical",
      value: filterCounts.critical,
      tone: filterCounts.critical ? ALERT_SEVERITY_TONE.critical : "var(--th-text-faint)",
      icon: ShieldAlert,
    },
    {
      label: "Warning",
      value: filterCounts.warning,
      tone: filterCounts.warning ? ALERT_SEVERITY_TONE.warning : "var(--th-text-faint)",
      icon: AlertTriangle,
    },
    { label: "Devices", value: affectedDevices, tone: "var(--th-accent)", icon: Monitor },
  ];

  return (
    <div className="th-onb flex flex-col gap-3">
      <PageHeader
        className="mb-2 hidden md:block"
        title="Alerts"
        description="Open alerts across every managed device, newest first."
      />

      <div className="grid grid-cols-3 gap-2">
        {stats.map(({ label, value, tone, icon: Icon }, index) => (
          <button
            key={label}
            type="button"
            onClick={() => label !== "Devices" && setActiveFilter(label === "Critical" ? "critical" : "warning")}
            className="th-onb-card th-malert-stat th-onb-enter"
            style={{ "--i": index } as CSSProperties}
            aria-label={`${value} ${label.toLowerCase()}`}
          >
            <span
              className="flex items-center gap-1.5 text-[12px] font-medium"
              style={{ color: "var(--th-text-muted)" }}
            >
              <Icon className="h-3.5 w-3.5" style={{ color: tone }} />
              {label}
            </span>
            <span
              className="text-[22px] font-semibold leading-7 tabular-nums"
              style={{ color: "var(--th-text-primary)" }}
            >
              {value}
            </span>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="th-mdev-chips min-w-0 flex-1 !mx-0 !px-0" role="tablist" aria-label="Alert filter">
          {shownFilters.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeFilter === id}
              onClick={() => setActiveFilter(id)}
              className="th-mdev-chip"
            >
              {label}
              <span className="tabular-nums">{filterCounts[id]}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void handleReload()}
          aria-label="Refresh alerts"
          className="th-mdev-tool !h-[30px] !w-[30px] !rounded-full"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="th-onb-card">
          <EmptyState
            className="py-10"
            icon={<CheckCircle2 className="h-5 w-5" style={{ color: "var(--th-status-online)" }} />}
            title="No active alerts"
            description={activeFilter !== "all" ? "Nothing matches this filter." : "All systems healthy."}
            action={
              activeFilter !== "all" ? (
                <Button size="sm" variant="secondary" onClick={() => setActiveFilter("all")}>
                  Show all
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        groups.map(({ deviceId, alerts: groupAlerts }) => (
          <AlertGroup
            key={deviceId ?? "token"}
            deviceId={deviceId}
            label={
              deviceId != null
                ? {
                    name: groupAlerts[0].device_name ?? `Device #${deviceId}`,
                    client: groupAlerts[0].client_name ?? null,
                  }
                : { name: "Enrollment tokens", client: null }
            }
            alerts={groupAlerts}
            onResolve={(id) => setResolving([id])}
            onResolveAll={setResolving}
            onOpenDevice={(id) => navigate(`/devices/${id}`)}
            onOpenAlert={setOpenAlertId}
          />
        ))
      )}

      {groups.length > 3 && (
        <Button
          variant="secondary"
          onClick={() => navigate("/devices?filter=needs_attention")}
          className="min-h-[44px] w-full"
        >
          View all affected devices
          <ChevronRight className="h-4 w-4" />
        </Button>
      )}

      <AlertDrawer alertId={openAlertId} onClose={() => setOpenAlertId(null)} onChanged={reloadAlerts} />

      {resolving && (
        <ResolveModal
          count={resolving.length}
          recurring={alerts.some((a) => resolving.includes(a.id) && a.recurring)}
          onClose={() => setResolving(null)}
          onResolve={(resolution, note) => resolveIds(resolving, resolution, note)}
        />
      )}

      <Snackbar open={snackMessage !== null} message={snackMessage ?? ""} onClose={() => setSnackMessage(null)} />
    </div>
  );
}
