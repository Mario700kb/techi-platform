import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
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
  CheckCircle2,
  MoreHorizontal,
  Power,
  RotateCcw,
  Wrench,
} from "lucide-react";
import { clearDeviceMaintenance, Device, enterDeviceMaintenance, getDevice, updateDevice } from "../api/devices";
import {
  getDeviceInventory,
  DeviceInventory,
  inventoryCacheKey,
  patchStatusFromEvent,
  withPatchStatus,
} from "../api/inventory";
import { getDeviceTelemetryHistory } from "../api/telemetry";
import { TelemetrySnapshot } from "../types/telemetry";
import { createDeviceNote, getDeviceNotes, DeviceNote } from "../api/notes";
import { queueDeviceAction } from "../api/actions";
import { getConnectUrl } from "../api/remoteSupport";
import { isValidRustDeskId, buildRustDeskFallbackUrlFromTechiUrl, launchConnect } from "../services/rustdeskLaunch";
import { useAuth } from "../auth/AuthContext";
import { useAppData } from "../contexts/AppDataContext";
import { useFavorites } from "../hooks/useFavorites";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { useDeviceTelemetry } from "../hooks/useDeviceTelemetry";
import { useDeviceAlerts } from "../hooks/useDeviceAlerts";
import { useDeviceActivity } from "../hooks/useDeviceActivity";
import { useNow } from "../hooks/useNow";
import { deviceSite } from "../utils/location";
import { deviceDisplayName, deviceHostnameSubtitle } from "../utils/deviceLabel";
import { timeAgo } from "../utils/time";
import { DeviceStatusChip } from "../components/DeviceStatusChip";
import { Button, EmptyState } from "../components/ui";
import CopyButton from "../components/ui/CopyButton";
import { DEVICE_PATCH_EVENTS, TERMS, TONE } from "../utils/deviceStatus";
import DeviceLivePanel from "../components/DeviceLivePanel";
import { useDeviceLive } from "../hooks/useDeviceLive";
import { AccordionSection } from "../components/mobile/AccordionSection";
import { Sparkline } from "../components/mobile/Sparkline";
import {
  StickyActionBar,
  ActionBarPrimary,
  ActionBarSecondary,
  ActionBarMore,
} from "../components/mobile/StickyActionBar";
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

const HEALTH_TONE = { online: TONE.online, warning: TONE.warning, critical: TONE.critical } as const;

const MORE_ACTIONS = [
  { label: "Restart agent", type: "restart_agent" as const, icon: RotateCcw },
  { label: "Sync Remote Support", type: "sync_rustdesk" as const, icon: RefreshCcw },
  { label: "Restart Remote Support", type: "restart_rustdesk" as const, icon: Power },
  { label: "Repair Remote Support config", type: "repair_config_rustdesk" as const, icon: Wrench },
  { label: "Refresh inventory", type: "refresh_inventory" as const, icon: Package },
];

function healthVariant(score: number | null): "online" | "warning" | "critical" {
  if (score == null) return "online";
  if (score < 60) return "critical";
  if (score < 80) return "warning";
  return "online";
}

export default function DeviceDetailsMobile() {
  useNow();
  const { id } = useParams<{ id: string }>();
  const deviceId = Number(id);
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const { latestEvent } = useAppData();
  const { isFavorite, toggle: toggleFavorite } = useFavorites();
  const canOperate = can("operator");

  const validId = Number.isFinite(deviceId);
  const {
    data: cachedDevice,
    loading,
    error,
    reload: loadDevice,
    setData: setDevice,
  } = useCachedQuery<Device>(validId ? `page.device.${deviceId}.detail` : null, () => getDevice(deviceId));
  const device = cachedDevice ?? null;

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
  const [softwareRequestedFor, setSoftwareRequestedFor] = useState<number | null>(null);
  const softwareRequested = validId && softwareRequestedFor === deviceId;
  const {
    data: cachedSoftware,
    loading: softwareLoading,
    setData: setSoftware,
  } = useCachedQuery<DeviceInventory>(softwareRequested ? inventoryCacheKey(deviceId) : null, () =>
    getDeviceInventory(deviceId),
  );
  const software = cachedSoftware ?? null;
  const [notesRequested, setNotesRequested] = useState(false);
  const {
    data: cachedNotes,
    loading: notesLoading,
    reload: loadNotes,
  } = useCachedQuery<DeviceNote[]>(validId && notesRequested ? `page.device.${deviceId}.notes` : null, () =>
    getDeviceNotes(deviceId),
  );
  const notes = cachedNotes ?? [];
  const [noteDraft, setNoteDraft] = useState("");
  const [timelineOpen, setTimelineOpen] = useState(false);
  const { data: cachedHistory } = useCachedQuery<TelemetrySnapshot[]>(
    validId ? `page.device.${deviceId}.telemetry-history` : null,
    () => getDeviceTelemetryHistory(deviceId, 20),
  );
  const telemetryHistory = cachedHistory ?? [];

  const telemetry = useDeviceTelemetry({ deviceId: device ? deviceId : null, latestEvent });
  // Live view while this page is open (Windows and Linux agents from 2.1.27).
  const livePlatform = /^(windows|linux)/i.test(device?.platform || "");
  const live = useDeviceLive(device ? deviceId : null, livePlatform && !device?.is_archived);
  const deviceAlerts = useDeviceAlerts({ deviceId, latestEvent });
  const activity = useDeviceActivity({ deviceId, latestEvent, enabled: timelineOpen });

  // Live-patch from realtime events for this device (mirrors DevicesTable's merge)
  useEffect(() => {
    const d = latestEvent?.data;
    // Device events only: an action event's id is the action's, and its
    // status ("running") is not the device's.
    if (!latestEvent || !d?.id || d.id !== deviceId || !DEVICE_PATCH_EVENTS.has(latestEvent.type)) return;
    setDevice((prev) => (prev ? ({ ...prev, ...d } as Device) : prev));
  }, [latestEvent, deviceId, setDevice]);

  useEffect(() => {
    const patch = patchStatusFromEvent(latestEvent);
    if (patch?.device_id !== deviceId) return;
    setSoftware((prev) => (prev ? withPatchStatus(prev, patch) : prev));
  }, [latestEvent, deviceId, setSoftware]);

  const loadSoftware = () => setSoftwareRequestedFor(deviceId);

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
      <div className="th-onb flex flex-col gap-3 pb-24" aria-busy="true">
        <div className="th-onb-card h-[116px] animate-pulse" />
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="th-onb-card h-[78px] animate-pulse" />
          ))}
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="th-onb-card h-14 animate-pulse" style={{ opacity: 1 - i * 0.15 }} />
        ))}
      </div>
    );
  }

  if (!device) {
    return (
      <div className="th-onb flex flex-col gap-3">
        <button
          type="button"
          onClick={() => navigate("/devices")}
          aria-label="Back to Devices"
          className="th-mtop-back !ml-0"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="th-onb-card">
          <EmptyState
            className="py-10"
            icon={<AlertTriangle className="h-5 w-5" />}
            title="Unable to load device"
            description={error ?? undefined}
            action={
              <Button size="sm" variant="secondary" onClick={() => void loadDevice()}>
                Try again
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const displayName = deviceDisplayName(device);
  const hostnameSubtitle = deviceHostnameSubtitle(device);
  const canConnect = isValidRustDeskId(device.rustdesk_id) && !device.rustdesk_conflict_detected;
  const criticalCount = deviceAlerts.openAlerts.filter((a) => a.severity === "critical").length;
  const warningCount = deviceAlerts.openAlerts.length - criticalCount;
  const typeLabel = deviceTypeLabel(device);
  const healthScore = telemetry.healthScore;
  const healthTone = HEALTH_TONE[healthVariant(healthScore)];
  const rsRunning = device.rustdesk_status === "running";

  return (
    <div className="th-onb flex flex-col gap-3 pb-24">
      <div className="th-onb-card th-mdetail-hero th-onb-enter">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate("/devices")}
            aria-label="Back to Devices"
            className="th-mtop-back"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          {nameEditing ? (
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
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
                aria-label="Device name"
                className="th-input h-9 min-w-0 flex-1 rounded-lg border px-3 text-[16px] font-semibold outline-none"
                style={{ borderColor: "var(--th-accent-border)" }}
              />
              <button
                type="button"
                onClick={() => void saveDisplayName()}
                disabled={nameSaving}
                aria-label="Save name"
                className="th-onb-action !h-9 !w-9"
                style={{ color: TONE.online }}
              >
                {nameSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => setNameEditing(false)}
                aria-label="Cancel rename"
                className="th-onb-action !h-9 !w-9"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <h1
                className="min-w-0 truncate text-[18px] font-semibold tracking-[-0.01em]"
                style={{ color: "var(--th-text-primary)" }}
              >
                {displayName}
              </h1>
              {canOperate && (
                <button
                  type="button"
                  onClick={() => {
                    setNameDraft(device.display_name ?? "");
                    setNameEditing(true);
                  }}
                  aria-label="Rename device"
                  className="th-onb-action !h-8 !w-8 flex-none"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => toggleFavorite(device.id)}
            aria-label={isFavorite(device.id) ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={isFavorite(device.id)}
            className="th-onb-action !h-9 !w-9 flex-none"
            style={{ color: isFavorite(device.id) ? "var(--th-status-stale)" : undefined }}
          >
            <Star className={`h-[18px] w-[18px] ${isFavorite(device.id) ? "fill-current" : ""}`} />
          </button>
        </div>

        <p className="mt-1 truncate pl-1 text-[13px]" style={{ color: "var(--th-text-secondary)" }}>
          {device.client_name ?? "No client"}
          {(deviceSite(device)?.text || device.group_name) && (
            <span style={{ color: "var(--th-text-muted)" }}> · {deviceSite(device)?.text || device.group_name}</span>
          )}
          {hostnameSubtitle && (
            <span className="font-mono text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              {" "}
              · {hostnameSubtitle}
            </span>
          )}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-1.5 pl-1">
          <DeviceStatusChip device={device} className="!h-6" />
          {typeLabel && (
            <span className="th-mdev-badge !h-6" style={{ "--chip-tone": typeLabel.tone } as CSSProperties}>
              {typeLabel.label}
            </span>
          )}
          {healthScore != null && (
            <span className="th-mdev-badge !h-6" style={{ "--chip-tone": healthTone } as CSSProperties}>
              Health {healthScore}
            </span>
          )}
          {device.is_in_maintenance && (
            <span className="th-mdev-badge !h-6" style={{ "--chip-tone": TONE.maintenance } as CSSProperties}>
              Maintenance
            </span>
          )}
        </div>
      </div>

      {/* Current values in one place: the live stream, or the last heartbeat
          labelled with its age. The Performance section below is the trend. */}
      {!device.is_archived && (
        <DeviceLivePanel
          live={live}
          liveCapable={livePlatform}
          fallback={
            telemetry.snapshot
              ? {
                  cpu_percent: telemetry.snapshot.cpu_percent,
                  ram_percent: telemetry.snapshot.ram_percent,
                  disk_percent: telemetry.snapshot.disk_percent,
                  uptime_seconds: telemetry.snapshot.uptime_seconds,
                  current_user: device.current_user,
                  at: telemetry.snapshot.created_at,
                }
              : null
          }
        />
      )}

      <AccordionSection
        icon={<AlertTriangle className="h-4 w-4" />}
        tone={criticalCount ? TONE.critical : warningCount ? TONE.warning : TONE.online}
        title="Alerts"
        subtitle={
          deviceAlerts.loading
            ? "Loading…"
            : deviceAlerts.openAlerts.length === 0
              ? "No active alerts"
              : [
                  criticalCount && `${criticalCount} critical`,
                  warningCount && `${warningCount} warning${warningCount === 1 ? "" : "s"}`,
                ]
                  .filter(Boolean)
                  .join(" · ")
        }
        badge={
          deviceAlerts.openAlerts.length > 0 ? (
            <CountBadge tone={criticalCount ? TONE.critical : TONE.warning}>
              {deviceAlerts.openAlerts.length}
            </CountBadge>
          ) : undefined
        }
        defaultOpen={deviceAlerts.openAlerts.length > 0}
      >
        {deviceAlerts.loading ? (
          <p style={{ color: "var(--th-text-muted)" }}>Loading…</p>
        ) : deviceAlerts.openAlerts.length === 0 ? (
          <p className="flex items-center gap-2" style={{ color: TONE.online }}>
            <CheckCircle2 className="h-4 w-4" />
            No active alerts
          </p>
        ) : (
          deviceAlerts.openAlerts.map((a) => (
            <div key={a.id} className="th-mitem">
              <span
                className="mt-[5px] h-2 w-2 flex-none rounded-full"
                style={{ background: a.severity === "critical" ? TONE.critical : TONE.warning }}
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium" style={{ color: "var(--th-text-primary)" }}>
                  {a.message}
                </p>
                <p className="mt-0.5 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                  {timeAgo(a.created_at)}
                </p>
              </div>
            </div>
          ))
        )}
      </AccordionSection>

      <AccordionSection
        icon={<TrendingUp className="h-4 w-4" />}
        tone={healthScore == null ? TONE.neutral : healthTone}
        title="Performance"
        subtitle={
          telemetry.loading ? "Loading…" : healthScore == null ? "No health score yet" : `Health ${healthScore} of 100`
        }
      >
        {telemetry.loading ? (
          <p style={{ color: "var(--th-text-muted)" }}>Loading…</p>
        ) : (
          <>
            {telemetry.healthReasons.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {telemetry.healthReasons.map((r, i) => (
                  <li key={i} className="flex items-start gap-2" style={{ color: "var(--th-text-secondary)" }}>
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" style={{ color: TONE.warning }} />
                    {r}
                  </li>
                ))}
              </ul>
            )}
            {telemetryHistory.length >= 2 && (
              <div className="th-mitem flex-col !gap-2">
                <Sparkline
                  cpu={telemetryHistory.map((t) => t.cpu_percent ?? 0)}
                  ram={telemetryHistory.map((t) => t.ram_percent ?? 0)}
                />
                <div className="flex w-full items-center gap-3 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                  <span className="flex items-center gap-1">
                    <span
                      className="inline-block h-[2px] w-3 rounded-full"
                      style={{ background: "var(--th-status-online)" }}
                    />
                    CPU
                  </span>
                  <span className="flex items-center gap-1">
                    <span
                      className="inline-block h-[2px] w-3 rounded-full"
                      style={{ background: "var(--th-status-agent)", opacity: 0.5 }}
                    />
                    RAM
                  </span>
                  <span className="ml-auto">Last {telemetryHistory.length} heartbeats</span>
                </div>
              </div>
            )}
            <dl className="th-mfacts">
              <div>
                <dt>Latency</dt>
                <dd className="tabular-nums">
                  {telemetry.snapshot?.heartbeat_latency_ms !== null &&
                  telemetry.snapshot?.heartbeat_latency_ms !== undefined
                    ? `${telemetry.snapshot.heartbeat_latency_ms} ms`
                    : "—"}
                </dd>
              </div>
            </dl>
          </>
        )}
      </AccordionSection>

      <AccordionSection
        icon={<Cpu className="h-4 w-4" />}
        tone={TONE.info}
        title="System"
        subtitle={device.os_name ?? "Operating system unknown"}
      >
        <dl className="th-mfacts">
          <div data-wide="true">
            <dt>Operating system</dt>
            <dd>{device.os_name ?? "—"}</dd>
          </div>
          <div>
            <dt>Domain</dt>
            <dd>{device.domain ?? "—"}</dd>
          </div>
          <div>
            <dt>Signed-in user</dt>
            <dd>{device.current_user ?? "—"}</dd>
          </div>
          <div>
            <dt>Public IP</dt>
            <dd className="th-mfacts-copy font-mono">
              {device.public_ip ?? "—"}
              {device.public_ip && <CopyButton text={device.public_ip} label="Public IP" />}
            </dd>
          </div>
          <div>
            <dt>Local IP</dt>
            <dd className="th-mfacts-copy font-mono">
              {device.local_ip ?? "—"}
              {device.local_ip && <CopyButton text={device.local_ip} label="Local IP" />}
            </dd>
          </div>
          <div>
            <dt>MAC address</dt>
            <dd className="th-mfacts-copy font-mono">
              {device.mac_address ?? "—"}
              {device.mac_address && <CopyButton text={device.mac_address} label="MAC address" />}
            </dd>
          </div>
          <div>
            <dt>Agent</dt>
            <dd className="font-mono">{device.agent_version ? `v${device.agent_version}` : "—"}</dd>
          </div>
          <div>
            <dt>Hostname</dt>
            <dd className="font-mono">{device.hostname ?? "—"}</dd>
          </div>
        </dl>
      </AccordionSection>

      <AccordionSection
        icon={<Package className="h-4 w-4" />}
        tone={software?.pending_updates ? TONE.warning : TONE.maintenance}
        title="Software"
        subtitle={
          !softwareRequested
            ? "Loads on request"
            : softwareLoading || !software
              ? "Loading…"
              : `${software.software.length} packages`
        }
        badge={
          software?.pending_updates ? (
            <CountBadge tone={TONE.warning}>{software.pending_updates} updates</CountBadge>
          ) : undefined
        }
      >
        {!softwareRequested ? (
          <>
            <p style={{ color: "var(--th-text-muted)" }}>
              Not loaded automatically, to spare a large request. Patch and reboot status are already under Performance.
            </p>
            <Button variant="secondary" onClick={() => void loadSoftware()} className="min-h-[40px] w-full">
              <Package className="h-4 w-4" />
              Load software list
            </Button>
          </>
        ) : softwareLoading || !software ? (
          <p style={{ color: "var(--th-text-muted)" }}>Loading…</p>
        ) : (
          <>
            <p
              className="font-medium"
              style={{
                color:
                  software.patch_state === "up_to_date"
                    ? TONE.online
                    : software.patch_state === "reboot_required" || software.patch_state === "updates_available"
                      ? TONE.warning
                      : "var(--th-text-primary)",
              }}
            >
              {software.patch_state === "up_to_date"
                ? "Up to date"
                : software.patch_state === "reboot_required"
                  ? "Reboot required"
                  : software.patch_state === "updates_available"
                    ? `${software.pending_updates ?? 0} update(s) pending`
                    : "Patch status unknown"}
            </p>
            <ul className="th-batch-list !max-h-[240px]">
              {software.software.slice(0, 30).map((sw, i) => (
                <li key={i}>
                  <span className="min-w-0 flex-1 truncate" style={{ color: "var(--th-text-secondary)" }}>
                    {sw.name}
                  </span>
                  <span className="flex-none font-mono text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                    {sw.version ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </AccordionSection>

      <AccordionSection
        icon={<Satellite className="h-4 w-4" />}
        tone={rsRunning ? TONE.online : TONE.neutral}
        title="Remote Support"
        subtitle={device.rustdesk_status ? `Status: ${device.rustdesk_status}` : "No status reported"}
        badge={rsRunning ? <CountBadge tone={TONE.online}>Running</CountBadge> : undefined}
      >
        <dl className="th-mfacts">
          <div>
            <dt>Status</dt>
            <dd>{device.rustdesk_status ?? "—"}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd className="font-mono">{device.rustdesk_version ?? "—"}</dd>
          </div>
          <div>
            <dt>Sync</dt>
            <dd style={{ color: device.rustdesk_sync_state === "synced" ? TONE.online : undefined }}>
              {device.rustdesk_sync_state ?? "—"}
            </dd>
          </div>
          <div>
            <dt>ID</dt>
            <dd className="font-mono">{device.rustdesk_id ?? "—"}</dd>
          </div>
        </dl>
      </AccordionSection>

      <AccordionSection
        icon={<Clock className="h-4 w-4" />}
        tone={TONE.info}
        title="Timeline & notes"
        subtitle="Operator notes and recent activity"
        onFirstOpen={() => {
          setTimelineOpen(true);
          setNotesRequested(true);
        }}
      >
        <div className="flex gap-2">
          <input
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAddNote();
            }}
            placeholder="Add a note…"
            aria-label="New note"
            className="th-input h-10 min-w-0 flex-1 rounded-lg border px-3 text-[13px] outline-none"
          />
          <Button
            variant="secondary"
            onClick={() => void handleAddNote()}
            disabled={!noteDraft.trim()}
            className="h-10"
          >
            Add
          </Button>
        </div>
        {notesLoading ? (
          <p style={{ color: "var(--th-text-muted)" }}>Loading…</p>
        ) : (
          notes.slice(0, 10).map((n) => (
            <div key={n.id} className="th-mitem flex-col !gap-0.5">
              <p style={{ color: "var(--th-text-primary)" }}>{n.note}</p>
              <p className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                {n.created_by ?? "operator"} · {timeAgo(n.created_at)}
              </p>
            </div>
          ))
        )}
        <p className="th-msheet-label !mb-0 mt-1">Activity</p>
        {activity.loading ? (
          <p style={{ color: "var(--th-text-muted)" }}>Loading…</p>
        ) : activity.events.length === 0 ? (
          <p style={{ color: "var(--th-text-muted)" }}>No recent activity.</p>
        ) : (
          <ul className="th-mtimeline">
            {activity.events.slice(0, 15).map((e) => (
              <li key={e.id}>
                <span className="min-w-0 flex-1" style={{ color: "var(--th-text-secondary)" }}>
                  {e.summary}
                </span>
                <span className="flex-none text-[11px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
                  {timeAgo(e.occurred_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
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
                run: () =>
                  runAction("Restart", () =>
                    queueDeviceAction(device.id, {
                      action_type: "restart_device",
                      created_by: user?.display_name ?? user?.username,
                    }),
                  ),
              })
            }
          >
            <RefreshCcw className="h-4 w-4" />
            Restart
          </ActionBarSecondary>
        )}
        {canOperate && (
          <ActionBarMore onClick={() => setMoreOpen(true)}>
            <MoreHorizontal className="h-5 w-5" />
          </ActionBarMore>
        )}
      </StickyActionBar>

      <MobileSheet open={moreOpen} onClose={() => setMoreOpen(false)} title="Device actions">
        <div className="flex flex-col gap-1">
          {MORE_ACTIONS.map((a) => (
            <button
              key={a.type}
              type="button"
              disabled={actionBusy}
              onClick={() =>
                void runAction(a.label, () =>
                  queueDeviceAction(device.id, {
                    action_type: a.type,
                    created_by: user?.display_name ?? user?.username,
                  }),
                )
              }
              className="th-msheet-option !justify-start disabled:opacity-50"
            >
              <a.icon className="h-4 w-4 flex-none" style={{ color: "var(--th-text-muted)" }} />
              {a.label}
            </button>
          ))}
          {device.is_in_maintenance ? (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() =>
                void runAction("Exit maintenance", async () => {
                  setDevice(await clearDeviceMaintenance(device.id));
                })
              }
              className="th-msheet-option !justify-start disabled:opacity-50"
              style={{ color: TONE.maintenance }}
            >
              <Wrench className="h-4 w-4 flex-none" />
              Exit maintenance
            </button>
          ) : (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() =>
                void runAction("Enter maintenance", async () => {
                  setDevice(
                    await enterDeviceMaintenance(device.id, {
                      duration_minutes: 60,
                      started_by: user?.display_name ?? user?.username,
                    }),
                  );
                })
              }
              className="th-msheet-option !justify-start disabled:opacity-50"
              style={{ color: TONE.maintenance }}
            >
              <Wrench className="h-4 w-4 flex-none" />
              Enter maintenance (60 min)
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
            <Button variant="secondary" onClick={() => setConfirmAction(null)} className="min-h-[44px] px-5">
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={actionBusy}
              onClick={() => confirmAction && void confirmAction.run()}
              className="min-h-[44px] flex-1"
            >
              {actionBusy ? "Working…" : "Confirm"}
            </Button>
          </>
        }
      >
        <p className="text-[14px]" style={{ color: "var(--th-text-primary)" }}>
          {confirmAction?.label}
        </p>
      </MobileSheet>

      <Snackbar open={snack !== null} message={snack ?? ""} onClose={() => setSnack(null)} />
    </div>
  );
}

function CountBadge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className="th-mdev-badge flex-none tabular-nums" style={{ "--chip-tone": tone } as CSSProperties}>
      {children}
    </span>
  );
}

function deviceTypeLabel(device: Device): { label: string; tone: string } | null {
  const cat = device.resolved_device_category;
  const dt = device.device_type;
  if (cat === "servers" || dt === "server") return { label: TERMS.server, tone: "var(--th-status-agent)" };
  if (cat === "clientpc" || dt === "client") return { label: TERMS.clientPc, tone: TONE.info };
  return null;
}
