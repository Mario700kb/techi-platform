import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ChevronLeft,
  Cpu,
  ExternalLink,
  Loader2,
  Package,
  Pencil,
  RefreshCcw,
  Save,
  Satellite,
  Star,
  X,
  Clock,
  TrendingUp,
} from "lucide-react";
import {
  clearDeviceMaintenance,
  Device,
  enterDeviceMaintenance,
  getDevice,
  updateDevice,
} from "../api/devices";
import { getDeviceInventory, DeviceInventory } from "../api/inventory";
import { getDeviceTelemetryHistory } from "../api/telemetry";
import { TelemetrySnapshot } from "../types/telemetry";
import { createDeviceNote, getDeviceNotes, DeviceNote } from "../api/notes";
import { queueDeviceAction } from "../api/actions";
import { getConnectUrl } from "../api/remoteSupport";
import {
  isValidRustDeskId,
  buildRustDeskFallbackUrlFromTechiUrl,
  launchConnect,
} from "../services/rustdeskLaunch";
import { useAuth } from "../auth/AuthContext";
import { useAppData } from "../contexts/AppDataContext";
import { useFavorites } from "../hooks/useFavorites";
import { useDeviceTelemetry } from "../hooks/useDeviceTelemetry";
import { useDeviceAlerts } from "../hooks/useDeviceAlerts";
import { useDeviceActivity } from "../hooks/useDeviceActivity";
import { deviceDisplayName, deviceHostnameSubtitle } from "../utils/deviceLabel";
import { timeAgo } from "../utils/time";
import { StatusDot, MBadge, FreshnessState } from "../components/mobile/primitives";
import { VitalsStrip } from "../components/mobile/VitalsStrip";
import { AccordionSection } from "../components/mobile/AccordionSection";
import { Sparkline } from "../components/mobile/Sparkline";
import { StickyActionBar, ActionBarPrimary, ActionBarSecondary, ActionBarMore } from "../components/mobile/StickyActionBar";
import { MobileSheet } from "../components/mobile/MobileSheet";
import { Snackbar } from "../components/mobile/Snackbar";

/**
 * Device Details — Mobile UI 2.0 (docs/reference/MOBILE-DESIGN-SPEC.md —
 * Device Details). A real page at /devices/:id ("faqe, JO drawer" — LOCKED),
 * built from accordion sections + a sticky action bar. Desktop keeps its
 * own DeviceDrawer entirely untouched; this page reuses the SAME
 * data-fetching hooks/APIs the drawer uses (useDeviceTelemetry,
 * useDeviceAlerts, useDeviceActivity, getDeviceInventory, notes API,
 * queueDeviceAction) so there is no business-logic duplication — only a
 * new presentation layer.
 */

function freshnessOf(device: Device): FreshnessState {
  const state = device.freshness_state ?? device.status;
  if (state === "online") return "online";
  if (state === "stale") return "stale";
  return "offline";
}

function healthVariant(score: number | null): "online" | "warning" | "critical" {
  if (score == null) return "online";
  if (score < 60) return "critical";
  if (score < 80) return "warning";
  return "online";
}

// Mirrors DeviceDrawer.tsx's formatUptime exactly (same field, same
// breakdown) — mobile previously divided uptime_seconds by 3600 only,
// showing e.g. "123h" where desktop shows "5d 3h" for the identical
// value. Same data, desktop's format is just readable at a glance.
function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function DeviceDetailsMobile() {
  const { id } = useParams<{ id: string }>();
  const deviceId = Number(id);
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const { latestEvent, realtimeStatus } = useAppData();
  const { isFavorite, toggle: toggleFavorite } = useFavorites();
  const canOperate = can("operator");

  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameSaving, setNameSaving] = useState(false);

  const [moreOpen, setMoreOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ label: string; run: () => Promise<void> } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);

  // Software inventory (full package list) is NOT auto-fetched — it's a
  // heavier payload than anything else on this page, and mobile pages get
  // opened far more casually/frequently than the desktop drawer. Only an
  // explicit tap loads it (docs/reference/MOBILE-DESIGN-SPEC.md — Device
  // Details, Implementation Note).
  const [software, setSoftware] = useState<DeviceInventory | null>(null);
  const [softwareLoading, setSoftwareLoading] = useState(false);
  const [softwareRequested, setSoftwareRequested] = useState(false);
  const [notes, setNotes] = useState<DeviceNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [telemetryHistory, setTelemetryHistory] = useState<TelemetrySnapshot[]>([]);

  const telemetry = useDeviceTelemetry({ deviceId: device ? deviceId : null, latestEvent });
  const deviceAlerts = useDeviceAlerts({ deviceId });
  const activity = useDeviceActivity({ deviceId, latestEvent, enabled: timelineOpen });

  useEffect(() => {
    if (!Number.isFinite(deviceId)) return;
    let cancelled = false;
    void getDeviceTelemetryHistory(deviceId, 20).then((rows) => {
      if (!cancelled) setTelemetryHistory(rows);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [deviceId]);

  const loadDevice = async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await getDevice(deviceId);
      setDevice(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load device");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!Number.isFinite(deviceId)) return;
    void loadDevice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  // Live-patch from realtime events for this device (mirrors DevicesTable's merge)
  useEffect(() => {
    const d = latestEvent?.data;
    if (!d?.id || d.id !== deviceId) return;
    setDevice((prev) => (prev ? ({ ...prev, ...d } as Device) : prev));
  }, [latestEvent, deviceId]);

  const loadSoftware = async () => {
    if (software || softwareLoading) return;
    setSoftwareRequested(true);
    setSoftwareLoading(true);
    try {
      setSoftware(await getDeviceInventory(deviceId));
    } catch {
      // section shows its own empty/error text below
    } finally {
      setSoftwareLoading(false);
    }
  };

  const loadNotes = async () => {
    setNotesLoading(true);
    try {
      setNotes(await getDeviceNotes(deviceId));
    } catch {
      // keep empty
    } finally {
      setNotesLoading(false);
    }
  };

  const handleAddNote = async () => {
    const trimmed = noteDraft.trim();
    if (!trimmed) return;
    try {
      await createDeviceNote(deviceId, trimmed);
      setNoteDraft("");
      await loadNotes();
    } catch (err) {
      setSnack(err instanceof Error ? err.message : "Failed to add note");
    }
  };

  const saveDisplayName = async () => {
    if (!device) return;
    setNameSaving(true);
    try {
      const trimmed = nameDraft.trim();
      const updated = await updateDevice(device.id, { display_name: trimmed || null });
      setDevice(updated);
      setNameEditing(false);
    } catch (err) {
      setSnack(err instanceof Error ? err.message : "Failed to rename device");
    } finally {
      setNameSaving(false);
    }
  };

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setActionBusy(true);
    try {
      await fn();
      setSnack(`${label} queued`);
    } catch (err) {
      setSnack(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setActionBusy(false);
      setMoreOpen(false);
      setConfirmAction(null);
    }
  };

  const handleConnect = async () => {
    if (!device) return;
    try {
      const res = await getConnectUrl(device.id);
      launchConnect(res.connect_url, buildRustDeskFallbackUrlFromTechiUrl(res.connect_url), () =>
        setSnack("Opening with RustDesk instead"),
      );
    } catch (err) {
      setSnack(err instanceof Error ? err.message : "Connect failed");
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-3 pb-20">
        <div className="h-24 animate-pulse rounded-[14px]" style={{ background: "var(--th-bg-card)" }} />
        <div className="h-16 animate-pulse rounded-[14px]" style={{ background: "var(--th-bg-card)" }} />
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-[14px]" style={{ background: "var(--th-bg-card)" }} />
        ))}
      </div>
    );
  }

  if (error || !device) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-[15px] font-bold" style={{ color: "var(--th-text-primary)" }}>Unable to load device</p>
        {error && <p className="text-[13px]" style={{ color: "var(--th-status-critical)" }}>{error}</p>}
        <button
          type="button"
          onClick={() => void loadDevice()}
          className="rounded-lg px-4 py-2 text-[12.5px] font-bold"
          style={{ background: "var(--th-accent-glow)", border: "1px solid var(--th-accent-border)", color: "var(--th-accent)" }}
        >
          Try again
        </button>
      </div>
    );
  }

  const displayName = deviceDisplayName(device);
  const hostnameSubtitle = deviceHostnameSubtitle(device);
  const canConnect = isValidRustDeskId(device.rustdesk_id) && !device.rustdesk_conflict_detected;
  const criticalCount = deviceAlerts.openAlerts.filter((a) => a.severity === "critical").length;
  const warningCount = deviceAlerts.openAlerts.length - criticalCount;
  const live = realtimeStatus === "connected";

  return (
    <div className="flex flex-col gap-3 pb-24">
      {/* Header */}
      <div className="flex flex-col gap-[6px]">
        <div className="flex items-center gap-[9px]">
          <button
            type="button"
            onClick={() => navigate("/devices")}
            aria-label="Back to Devices"
            className="flex h-9 w-9 flex-none items-center justify-center rounded-lg"
            style={{ color: "var(--th-text-secondary)" }}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <StatusDot state={freshnessOf(device)} size={12} />
          {nameEditing ? (
            <div className="flex min-w-0 flex-1 items-center gap-[6px]">
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveDisplayName();
                  if (e.key === "Escape") setNameEditing(false);
                }}
                autoFocus
                maxLength={128}
                placeholder={device.hostname || "Device name"}
                className="min-w-0 flex-1 rounded-lg border px-[10px] py-[6px] text-[16px] font-extrabold outline-none"
                style={{ background: "var(--th-bg-card)", borderColor: "var(--th-accent-border)", color: "var(--th-text-primary)" }}
              />
              <button
                type="button"
                onClick={() => void saveDisplayName()}
                disabled={nameSaving}
                className="flex h-9 w-9 flex-none items-center justify-center rounded-lg"
                style={{ color: "var(--th-status-online)" }}
              >
                {nameSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => setNameEditing(false)}
                className="flex h-9 w-9 flex-none items-center justify-center rounded-lg"
                style={{ color: "var(--th-text-muted)" }}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <>
              <h1 className="min-w-0 truncate text-[19px] font-extrabold tracking-[-0.02em]" style={{ color: "var(--th-text-primary)" }}>
                {displayName}
              </h1>
              {canOperate && (
                <button
                  type="button"
                  onClick={() => { setNameDraft(device.display_name ?? ""); setNameEditing(true); }}
                  aria-label="Rename device"
                  className="flex h-8 w-8 flex-none items-center justify-center rounded-lg"
                  style={{ color: "var(--th-text-muted)" }}
                >
                  <Pencil className="h-[15px] w-[15px]" />
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => toggleFavorite(device.id)}
            aria-label={isFavorite(device.id) ? "Remove from favorites" : "Add to favorites"}
            className="ml-auto flex h-9 w-9 flex-none items-center justify-center rounded-lg"
            style={{ color: isFavorite(device.id) ? "var(--th-status-stale)" : "var(--th-text-muted)" }}
          >
            <Star className={`h-[18px] w-[18px] ${isFavorite(device.id) ? "fill-current" : ""}`} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-[6px] gap-y-1 text-[12px] font-semibold" style={{ color: "var(--th-text-secondary)" }}>
          {getDeviceTypeBadge(device)}
          <span style={{ color: "var(--th-accent)" }}>{device.client_name ?? "No client"}</span>
          {device.group_name && <span style={{ color: "var(--th-text-muted)" }}>· {device.group_name}</span>}
          {device.current_user && <span style={{ color: "var(--th-text-muted)" }}>· {device.current_user}</span>}
          {hostnameSubtitle && <span className="font-mono" style={{ color: "var(--th-text-muted)" }}>· {hostnameSubtitle}</span>}
          <span className="ml-auto flex items-center gap-1 font-bold" style={{ color: live ? "var(--th-status-online)" : "var(--th-text-muted)" }}>
            {device.last_seen ? `seen ${timeAgo(device.last_seen)}` : "never seen"}
          </span>
        </div>
      </div>

      <VitalsStrip cpu={telemetry.snapshot?.cpu_percent ?? null} ram={telemetry.snapshot?.ram_percent ?? null} disk={telemetry.snapshot?.disk_percent ?? null} />

      <AccordionSection
        icon={<AlertTriangle className="h-4 w-4" />}
        title="Alerts"
        badge={deviceAlerts.openAlerts.length > 0 ? <MBadge variant="critical">{deviceAlerts.openAlerts.length}</MBadge> : undefined}
        defaultOpen={deviceAlerts.openAlerts.length > 0}
      >
        {deviceAlerts.loading ? (
          <p style={{ color: "var(--th-text-muted)" }}>Loading…</p>
        ) : deviceAlerts.openAlerts.length === 0 ? (
          <p style={{ color: "var(--th-status-online)" }}>✓ No active alerts</p>
        ) : (
          deviceAlerts.openAlerts.map((a) => (
            <div key={a.id} className="flex items-start gap-[8px] rounded-[10px] p-[9px_10px]" style={{ background: "var(--th-chip-bg)" }}>
              <span
                className="mt-[3px] h-[7px] w-[7px] flex-none rounded-full"
                style={{ background: a.severity === "critical" ? "var(--th-status-critical)" : "var(--th-status-warning)" }}
              />
              <div className="min-w-0 flex-1">
                <p className="font-bold" style={{ color: "var(--th-text-primary)" }}>{a.message}</p>
                <p className="mt-[2px] text-[11px]" style={{ color: "var(--th-text-muted)" }}>{timeAgo(a.created_at)}</p>
              </div>
            </div>
          ))
        )}
        {(criticalCount > 0 || warningCount > 0) && (
          <p style={{ color: "var(--th-text-muted)" }}>
            {criticalCount > 0 && `${criticalCount} critical`}
            {criticalCount > 0 && warningCount > 0 && " · "}
            {warningCount > 0 && `${warningCount} warning`}
          </p>
        )}
      </AccordionSection>

      <AccordionSection icon={<TrendingUp className="h-4 w-4" />} title="Performance">
        {telemetry.loading ? (
          <p style={{ color: "var(--th-text-muted)" }}>Loading…</p>
        ) : (
          <>
            <MBadge variant={healthVariant(telemetry.healthScore)}>Health {telemetry.healthScore ?? "—"}</MBadge>
            {telemetry.healthReasons.length > 0 && (
              <ul className="flex flex-col gap-[4px]">
                {telemetry.healthReasons.map((r, i) => (
                  <li key={i} style={{ color: "var(--th-text-secondary)" }}>⚠ {r}</li>
                ))}
              </ul>
            )}
            {telemetryHistory.length >= 2 && (
              <div className="flex flex-col gap-[4px]">
                <Sparkline
                  cpu={telemetryHistory.map((t) => t.cpu_percent ?? 0)}
                  ram={telemetryHistory.map((t) => t.ram_percent ?? 0)}
                />
                <div className="flex items-center gap-3 text-[10.5px]" style={{ color: "var(--th-text-muted)" }}>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-[2px] w-3 rounded-full" style={{ background: "var(--th-status-online)" }} />
                    CPU
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-[2px] w-3 rounded-full" style={{ background: "var(--th-status-agent)", opacity: 0.5 }} />
                    RAM
                  </span>
                  <span className="ml-auto">
                    last {telemetryHistory.length} heartbeats
                  </span>
                </div>
              </div>
            )}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
              <dt style={{ color: "var(--th-text-muted)" }}>Uptime</dt>
              <dd className="num" style={{ color: "var(--th-text-primary)" }}>
                {formatUptime(telemetry.snapshot?.uptime_seconds ?? null)}
              </dd>
              <dt style={{ color: "var(--th-text-muted)" }}>Latency</dt>
              <dd className="num" style={{ color: "var(--th-text-primary)" }}>
                {telemetry.snapshot?.heartbeat_latency_ms !== null && telemetry.snapshot?.heartbeat_latency_ms !== undefined
                  ? `${telemetry.snapshot.heartbeat_latency_ms}ms`
                  : "—"}
              </dd>
            </dl>
          </>
        )}
      </AccordionSection>

      <AccordionSection icon={<Cpu className="h-4 w-4" />} title="Hardware">
        <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-[6px]">
          <dt style={{ color: "var(--th-text-muted)" }}>OS</dt>
          <dd style={{ color: "var(--th-text-primary)" }}>{device.os_name ?? "—"}</dd>
          <dt style={{ color: "var(--th-text-muted)" }}>Domain</dt>
          <dd style={{ color: "var(--th-text-primary)" }}>{device.domain ?? "—"}</dd>
          <dt style={{ color: "var(--th-text-muted)" }}>Public IP</dt>
          <dd className="font-mono" style={{ color: "var(--th-text-primary)" }}>{device.public_ip ?? "—"}</dd>
          <dt style={{ color: "var(--th-text-muted)" }}>Local IP</dt>
          <dd className="font-mono" style={{ color: "var(--th-text-primary)" }}>{device.local_ip ?? "—"}</dd>
        </dl>
      </AccordionSection>

      <AccordionSection
        icon={<Package className="h-4 w-4" />}
        title="Software"
        badge={software?.pending_updates ? <MBadge variant="warning">{software.pending_updates} upd</MBadge> : undefined}
      >
        {!softwareRequested ? (
          <div className="flex flex-col gap-[8px]">
            <p style={{ color: "var(--th-text-muted)" }}>
              Not loaded automatically to avoid an unnecessary server request. Patch/reboot status
              is already shown under Performance above.
            </p>
            <button
              type="button"
              onClick={() => void loadSoftware()}
              className="flex min-h-[40px] items-center justify-center rounded-lg text-[12.5px] font-bold"
              style={{ background: "var(--th-accent-glow)", border: "1px solid var(--th-accent-border)", color: "var(--th-accent)" }}
            >
              Load software list
            </button>
          </div>
        ) : softwareLoading || !software ? (
          <p style={{ color: "var(--th-text-muted)" }}>Loading…</p>
        ) : (
          <>
            <p style={{ color: "var(--th-text-primary)" }}>
              {software.patch_state === "up_to_date" ? "✓ Up to date" : software.patch_state === "reboot_required" ? "⚠ Reboot required" : software.patch_state === "updates_available" ? `${software.pending_updates ?? 0} update(s) pending` : "Patch status unknown"}
            </p>
            <div className="flex flex-col gap-[4px]" style={{ maxHeight: 220, overflowY: "auto" }}>
              {software.software.slice(0, 30).map((s, i) => (
                <div key={i} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate" style={{ color: "var(--th-text-secondary)" }}>{s.name}</span>
                  <span className="flex-none font-mono text-[11px]" style={{ color: "var(--th-text-muted)" }}>{s.version ?? "—"}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </AccordionSection>

      <AccordionSection
        icon={<Satellite className="h-4 w-4" />}
        title="Remote Support"
        badge={
          device.rustdesk_status === "running" ? (
            <span className="text-[11px] font-bold" style={{ color: "var(--th-status-online)" }}>Running</span>
          ) : undefined
        }
      >
        <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-[6px]">
          <dt style={{ color: "var(--th-text-muted)" }}>Status</dt>
          <dd style={{ color: "var(--th-text-primary)" }}>{device.rustdesk_status ?? "—"}</dd>
          <dt style={{ color: "var(--th-text-muted)" }}>Version</dt>
          <dd className="font-mono" style={{ color: "var(--th-text-primary)" }}>{device.rustdesk_version ?? "—"}</dd>
          <dt style={{ color: "var(--th-text-muted)" }}>Sync</dt>
          <dd style={{ color: device.rustdesk_sync_state === "applied" ? "var(--th-status-online)" : "var(--th-text-primary)" }}>
            {device.rustdesk_sync_state ?? "—"}
          </dd>
        </dl>
      </AccordionSection>

      <AccordionSection
        icon={<Clock className="h-4 w-4" />}
        title="Timeline & Notes"
      >
        {(() => {
          if (!timelineOpen) {
            setTimelineOpen(true);
            void loadNotes();
          }
          return null;
        })()}
        <div className="flex flex-col gap-[8px]">
          <div className="flex gap-[8px]">
            <input
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleAddNote(); }}
              placeholder="Add a note…"
              className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-[12.5px] outline-none"
              style={{ background: "var(--th-chip-bg)", borderColor: "var(--th-border-subtle)", color: "var(--th-text-primary)" }}
            />
            <button
              type="button"
              onClick={() => void handleAddNote()}
              className="rounded-lg px-3 py-2 text-[12px] font-bold"
              style={{ background: "var(--th-accent-glow)", color: "var(--th-accent)", border: "1px solid var(--th-accent-border)" }}
            >
              Add
            </button>
          </div>
          {notesLoading ? (
            <p style={{ color: "var(--th-text-muted)" }}>Loading…</p>
          ) : (
            notes.slice(0, 10).map((n) => (
              <div key={n.id} className="rounded-[10px] p-[9px_10px]" style={{ background: "var(--th-chip-bg)" }}>
                <p style={{ color: "var(--th-text-primary)" }}>{n.note}</p>
                <p className="mt-[2px] text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                  {n.created_by ?? "operator"} · {timeAgo(n.created_at)}
                </p>
              </div>
            ))
          )}
          <p className="mt-1 text-[11px] font-extrabold uppercase tracking-[0.07em]" style={{ color: "var(--th-text-muted)" }}>
            Activity
          </p>
          {activity.loading ? (
            <p style={{ color: "var(--th-text-muted)" }}>Loading…</p>
          ) : activity.events.length === 0 ? (
            <p style={{ color: "var(--th-text-muted)" }}>No recent activity.</p>
          ) : (
            activity.events.slice(0, 15).map((e) => (
              <div key={e.id} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1" style={{ color: "var(--th-text-secondary)" }}>{e.summary}</span>
                <span className="flex-none text-[11px]" style={{ color: "var(--th-text-muted)" }}>{timeAgo(e.occurred_at)}</span>
              </div>
            ))
          )}
        </div>
      </AccordionSection>

      <StickyActionBar>
        <ActionBarPrimary onClick={() => void handleConnect()} disabled={!canConnect}>
          <ExternalLink className="h-4 w-4" />
          Connect
        </ActionBarPrimary>
        {canOperate && (
          <ActionBarSecondary
            onClick={() =>
              setConfirmAction({
                label: `Restart ${displayName}?`,
                run: () => runAction("Restart", () => queueDeviceAction(device.id, { action_type: "restart_device", created_by: user?.display_name ?? user?.username })),
              })
            }
          >
            <RefreshCcw className="h-4 w-4" />
            Restart
          </ActionBarSecondary>
        )}
        {canOperate && (
          <ActionBarMore onClick={() => setMoreOpen(true)}>
            <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1 }}>⋯</span>
          </ActionBarMore>
        )}
      </StickyActionBar>

      <MobileSheet open={moreOpen} onClose={() => setMoreOpen(false)} title={`${displayName} — Actions`}>
        <div className="flex flex-col gap-1">
          {[
            { label: "Restart Agent", type: "restart_agent" as const },
            { label: "Sync Remote Support", type: "sync_rustdesk" as const },
            { label: "Restart Remote Support", type: "restart_rustdesk" as const },
            { label: "Repair Remote Support Config", type: "repair_config_rustdesk" as const },
            { label: "Refresh Inventory", type: "refresh_inventory" as const },
          ].map((a) => (
            <button
              key={a.type}
              type="button"
              disabled={actionBusy}
              onClick={() => void runAction(a.label, () => queueDeviceAction(device.id, { action_type: a.type, created_by: user?.display_name ?? user?.username }))}
              className="flex min-h-[48px] w-full items-center rounded-lg px-3 text-[13.5px] font-bold text-left disabled:opacity-50"
              style={{ color: "var(--th-text-primary)" }}
            >
              {a.label}
            </button>
          ))}
          {device.is_in_maintenance ? (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void runAction("Exit maintenance", async () => { setDevice(await clearDeviceMaintenance(device.id)); })}
              className="flex min-h-[48px] w-full items-center rounded-lg px-3 text-[13.5px] font-bold text-left disabled:opacity-50"
              style={{ color: "var(--th-status-maint)" }}
            >
              Exit Maintenance
            </button>
          ) : (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void runAction("Enter maintenance", async () => { setDevice(await enterDeviceMaintenance(device.id, { duration_minutes: 60, started_by: user?.display_name ?? user?.username })); })}
              className="flex min-h-[48px] w-full items-center rounded-lg px-3 text-[13.5px] font-bold text-left disabled:opacity-50"
              style={{ color: "var(--th-status-maint)" }}
            >
              Enter Maintenance (60 min)
            </button>
          )}
        </div>
      </MobileSheet>

      <MobileSheet
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        title="Confirm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmAction(null)}
              className="flex-none rounded-xl px-[18px] text-[12.5px] font-bold"
              style={{ border: "1px solid var(--th-border-subtle)", color: "var(--th-text-secondary)", minHeight: 44 }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => confirmAction && void confirmAction.run()}
              className="flex-1 rounded-xl text-[13.5px] font-extrabold text-white disabled:opacity-50"
              style={{ background: "var(--th-status-critical)", minHeight: 44 }}
            >
              {actionBusy ? "Working…" : "Confirm"}
            </button>
          </>
        }
      >
        <p style={{ color: "var(--th-text-primary)" }}>{confirmAction?.label}</p>
      </MobileSheet>

      <Snackbar open={snack !== null} message={snack ?? ""} onClose={() => setSnack(null)} />
    </div>
  );
}

function getDeviceTypeBadge(device: Device) {
  const cat = device.resolved_device_category;
  const dt = device.device_type;
  if (cat === "servers" || dt === "server") return <MBadge variant="server">SERVER</MBadge>;
  if (cat === "clientpc" || dt === "client") return <MBadge variant="ws">WS</MBadge>;
  return null;
}
