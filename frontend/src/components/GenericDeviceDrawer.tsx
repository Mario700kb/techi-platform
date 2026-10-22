import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Layers, Link2, Loader2, RefreshCcw, Save, StickyNote, Wrench, X } from "lucide-react";

import { Client, DeviceGroup } from "../api/clients";
import { assignDeviceClient, Device, updateDevice } from "../api/devices";
import { queueDeviceAction, ActionType } from "../api/actions";
import { DeviceInventory, getDeviceInventory } from "../api/inventory";
import { createDeviceNote, DeviceNote, getDeviceNotes } from "../api/notes";
import { DrawerAction, DrawerMeta, getDrawerMeta } from "../api/platform";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { useDeviceActivity } from "../hooks/useDeviceActivity";
import { useDeviceTelemetry } from "../hooks/useDeviceTelemetry";
import { usePlatformFeatures } from "../hooks/usePlatformFeatures";
import { useNow } from "../hooks/useNow";
import { deviceFreshness } from "../utils/devicePresence";
import { DeviceStatusChip } from "./DeviceStatusChip";
import { useTabIndicator } from "../hooks/useTabIndicator";
import { freshnessTone, humanize, TERMS, TONE } from "../utils/deviceStatus";
import { deviceSite } from "../utils/location";
import { deviceDisplayName, deviceHostnameSubtitle } from "../utils/deviceLabel";
import { formatDateTime, timeAgo } from "../utils/time";
import ActivityTimeline from "./ActivityTimeline";
import ComponentStatesPanel from "./ComponentStatesPanel";
import ConfirmationModal from "./ConfirmationModal";
import ConnectMenu from "./ConnectMenu";
import GroupPicker from "./GroupPicker";
import HealthBadge from "./HealthBadge";
import LocationPicker from "./LocationPicker";
import PlatformIcon from "./PlatformIcon";
import VersionBadge from "./VersionBadge";
import { Button, EmptyState, SelectField } from "./ui";
import DeviceLivePanel, { HeartbeatValues } from "./DeviceLivePanel";
import DeviceDrawer from "./DeviceDrawer";
import DeviceLast24hCard from "./DeviceLast24hCard";
import DeviceMonitoringPanel from "./DeviceMonitoringPanel";
import { useDeviceLive } from "../hooks/useDeviceLive";

const DeviceTerminal = lazy(() => import("./DeviceTerminal"));

// Registry-driven Device Drawer for devices that report capabilities (Linux and
// every future platform). It renders ENTIRELY from GET /devices/{id}/drawer
// (Platform + Capability + Action + Connect registries) — no per-platform code.
// Windows devices (no reported capabilities) never reach here; the render site
// selects the classic DeviceDrawer for them. Structure, classes and wording
// follow DeviceDrawer so both drawers read as one product.
interface Props {
  device: Device;
  isOpen: boolean;
  onClose: () => void;
  clients?: Client[];
  groups?: DeviceGroup[];
  latestEvent?: DeviceRealtimeEvent | null;
  canOperate?: boolean;
  /** May place the device at one of its client's locations (manage_clients). */
  canManageLocations?: boolean;
  onDeviceUpdated?: (device: Device) => void;
  // Deep-link tab (e.g. the Device Catalog's Connect ▸ Embedded Terminal
  // opens the drawer directly on the Terminal tab).
  initialTab?: string;
}

const CAP_TAB_LABELS: Record<string, string> = {
  services: "Services",
  processes: "Processes",
  packages: "Packages",
  docker: "Docker",
  logs: "Logs",
  network: "Network",
  storage: "Storage",
};
const CAPABILITY_TABS = Object.keys(CAP_TAB_LABELS);

const TABLE_ROW_LIMIT = 200;

type InventoryState = "loading" | "error" | "ready";

/**
 * Render site helper: a device "reports capabilities" once its agent does,
 * and Windows agents from 2.1.29 report one ("powershell"). Windows stays on
 * the classic drawer, which owns the Windows-only sections (Maintenance with
 * the administrator PowerShell, Remote Support), whichever page opens it.
 */
export default function GenericDeviceDrawer(props: Props) {
  const platform = props.device.platform || "";
  if (/^windows/i.test(platform)) {
    return (
      <DeviceDrawer
        device={props.device}
        isOpen={props.isOpen}
        onClose={props.onClose}
        latestEvent={props.latestEvent}
        clients={props.clients}
        groups={props.groups}
        onDeviceUpdated={props.onDeviceUpdated}
        canOperate={props.canOperate}
      />
    );
  }
  return <RegistryDeviceDrawer {...props} />;
}

function RegistryDeviceDrawer({
  device,
  isOpen,
  onClose,
  latestEvent,
  clients,
  groups,
  canOperate,
  canManageLocations = false,
  onDeviceUpdated,
  initialTab,
}: Props) {
  useNow();
  const features = usePlatformFeatures();
  const [openedFor, setOpenedFor] = useState<number | null>(null);
  if (isOpen && openedFor !== device.id) setOpenedFor(device.id);
  const opened = openedFor === device.id;
  const metaQuery = useCachedQuery<DrawerMeta>(opened ? `page.device.${device.id}.drawer-meta` : null, () =>
    getDrawerMeta(device.id),
  );
  const meta = metaQuery.data ?? null;
  const metaFailed = metaQuery.error !== null && !metaQuery.refreshing;
  const loadMeta = () => void metaQuery.reload();
  const [tab, setTab] = useState<string>("overview");
  const tabsRef = useTabIndicator<HTMLDivElement>(`${tab}:${meta ? "ready" : "loading"}`);
  const inventoryQuery = useCachedQuery<DeviceInventory>(opened ? `mem.device.${device.id}.inventory` : null, () =>
    getDeviceInventory(device.id),
  );
  const inventory = inventoryQuery.data ?? null;
  const inventoryState: InventoryState = inventory
    ? "ready"
    : inventoryQuery.error !== null && !inventoryQuery.refreshing
      ? "error"
      : "loading";
  const loadInventory = () => void inventoryQuery.reload();
  const notesQuery = useCachedQuery<DeviceNote[]>(
    opened && tab === "notes" ? `page.device.${device.id}.notes` : null,
    () => getDeviceNotes(device.id),
  );
  const notes = notesQuery.data ?? [];
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [confirm, setConfirm] = useState<DrawerAction | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; ok: boolean } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const {
    events,
    loading: tlLoading,
    reload: reloadTimeline,
  } = useDeviceActivity({
    deviceId: device.id,
    latestEvent,
    enabled: isOpen && tab === "timeline",
  });
  const { snapshot, healthScore, healthState } = useDeviceTelemetry({
    deviceId: isOpen ? device.id : null,
    latestEvent,
  });
  const operate = canOperate !== false;
  const displayName = deviceDisplayName(device);
  const hostnameSubtitle = deviceHostnameSubtitle(device);
  const freshnessColor = freshnessTone(deviceFreshness(device));

  useEffect(() => {
    if (!isOpen) return;
    setTab(initialTab ?? "overview");
  }, [isOpen, device.id, initialTab]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirm) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handler);
    };
  }, [isOpen, onClose, confirm]);

  useEffect(
    () => () => {
      if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const agentPlatform = /^(windows|linux)/i.test(device.platform || "");
  const tabs = useMemo(() => {
    const t: Array<{ id: string; label: string }> = [{ id: "overview", label: "Overview" }];
    // Agents (Linux, Windows) send the 1-minute metrics pipeline.
    if (agentPlatform) t.push({ id: "monitoring", label: "Monitoring" });
    if (meta?.remote_support) t.push({ id: "remote_support", label: TERMS.remoteSupport });
    if (meta?.terminal && features.FEATURE_TERMINAL) t.push({ id: "terminal", label: "Terminal" });
    (meta?.capability_tabs ?? []).forEach((c) => t.push({ id: c, label: CAP_TAB_LABELS[c] ?? humanize(c) }));
    if (meta?.actions?.length) t.push({ id: "management", label: "Maintenance" });
    t.push({ id: "notes", label: "Notes" });
    t.push({ id: "timeline", label: "Timeline" });
    return t;
  }, [meta, features.FEATURE_TERMINAL, agentPlatform]);

  const flash = (message: string, ok: boolean) => {
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    setToast({ message, ok });
    toastTimer.current = window.setTimeout(() => setToast(null), 3000);
  };

  // Live view while Overview is open (Linux and Windows agents from 2.1.27).
  const livePlatform = agentPlatform;
  const live = useDeviceLive(device.id, isOpen && tab === "overview" && livePlatform && !device.is_archived);
  const streaming = live.state === "live" && live.snapshot !== null;
  const heartbeatValues: HeartbeatValues | null = snapshot
    ? {
        cpu_percent: snapshot.cpu_percent,
        ram_percent: snapshot.ram_percent,
        disk_percent: snapshot.disk_percent,
        uptime_seconds: snapshot.uptime_seconds ?? null,
        current_user: device.current_user,
        at: snapshot.created_at,
      }
    : null;

  const runAction = async (a: DrawerAction) => {
    setBusy(a.id);
    try {
      const created = await queueDeviceAction(device.id, { action_type: a.id as ActionType });
      // "sent" straight away means it went over the live channel.
      flash(created.status === "queued" ? `${a.label} queued for the next heartbeat` : `${a.label} sent live`, true);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Action failed", false);
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const onAction = (a: DrawerAction) => {
    if (a.confirm === "confirm") setConfirm(a);
    else void runAction(a);
  };

  const addNote = async () => {
    const text = noteText.trim();
    if (!text) return;
    setNoteBusy(true);
    try {
      await createDeviceNote(device.id, text);
      setNoteText("");
      await notesQuery.reload();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to add note", false);
    } finally {
      setNoteBusy(false);
    }
  };

  const openTerminal = meta?.terminal && features.FEATURE_TERMINAL ? () => setTab("terminal") : undefined;

  return (
    <>
      <div
        className={`th-drawer-scrim fixed inset-0 z-40 backdrop-blur-[2px] ${isOpen ? "opacity-100" : "pointer-events-none opacity-0"}`}
        style={{ background: "var(--th-scrim)" }}
        data-open={isOpen}
        role="presentation"
        onClick={onClose}
      />
      <div
        className={`th-drawer th-drawer-panel fixed right-0 top-0 z-50 flex h-full w-full max-w-[720px] 2xl:max-w-[780px] flex-col shadow-2xl ${isOpen ? "translate-x-0" : "translate-x-full"}`}
        data-open={isOpen}
        style={{ borderLeft: "1px solid var(--th-border-drawer)", background: "var(--th-bg-drawer)" }}
      >
        <header className="flex-none px-5 pt-4" style={{ borderBottom: "1px solid var(--th-border-drawer-section)" }}>
          <div className="flex items-start gap-3">
            <span className="th-palette-icon !h-10 !w-10 flex-none" aria-hidden="true">
              <PlatformIcon platform={meta?.platform ?? device.platform} size={20} />
              <i style={{ background: freshnessColor }} />
            </span>
            <div className="min-w-0 flex-1">
              <h2
                className="min-w-0 break-words text-[17px] font-semibold leading-snug"
                style={{ color: "var(--th-text-primary)" }}
                title={displayName}
              >
                {displayName}
              </h2>
              <p className="mt-0.5 truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                {[
                  humanize(meta?.platform ?? device.platform ?? ""),
                  device.resolved_client_name || device.client_name || TERMS.noClient,
                  device.resolved_group || device.group_name,
                  hostnameSubtitle ? `host ${hostnameSubtitle}` : null,
                  `#${device.id}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close (Esc)"
              className="th-icon-btn th-icon-btn-ghost flex-none"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <DeviceStatusChip device={device} />
            {healthScore != null && (
              <span
                className="th-status-chip"
                style={
                  {
                    "--chip-tone":
                      healthState === "critical"
                        ? TONE.critical
                        : healthState === "warning"
                          ? TONE.warning
                          : TONE.online,
                  } as React.CSSProperties
                }
                title="Health score of 100"
              >
                <i />
                Health {healthScore}
              </span>
            )}
          </div>

          <div
            ref={tabsRef}
            role="tablist"
            aria-label="Device sections"
            className="th-tabs mt-3 !flex-nowrap overflow-x-auto"
            style={{ scrollbarWidth: "none" }}
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className="th-tab flex-none whitespace-nowrap !px-3"
              >
                {t.label}
              </button>
            ))}
          </div>
        </header>

        {toast && (
          <div
            role="status"
            className="th-toast th-drawer-callout mx-5 mt-3 flex-none text-[13px] font-medium"
            data-tone={toast.ok ? "online" : "critical"}
          >
            {toast.message}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!meta && metaFailed ? (
            <EmptyState
              icon={<AlertTriangle className="h-5 w-5" />}
              title="Couldn't load this device"
              description="The server did not answer. Try again."
              action={
                <Button size="sm" variant="secondary" onClick={loadMeta}>
                  <RefreshCcw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              }
            />
          ) : !meta ? (
            <div className="flex items-center gap-2 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading device…
            </div>
          ) : (
            <>
              {tab === "overview" && (
                <div className="th-tab-panel">
                  {!device.is_archived && (
                    <DeviceLivePanel live={live} fallback={heartbeatValues} liveCapable={livePlatform} />
                  )}
                  <Overview
                    device={device}
                    meta={meta}
                    liveUser={streaming ? (live.snapshot?.current_user ?? null) : null}
                    streaming={streaming}
                    healthState={healthState}
                    healthScore={healthScore}
                    clients={clients ?? []}
                    groups={groups ?? []}
                    canOperate={operate}
                    canManageLocations={canManageLocations}
                    onDeviceUpdated={onDeviceUpdated}
                    onOpenTerminal={openTerminal}
                    active={isOpen}
                    onOpenMonitoring={agentPlatform ? () => setTab("monitoring") : undefined}
                  />
                </div>
              )}
              {tab === "remote_support" && (
                <div className="th-tab-panel">
                  <section className="mb-4">
                    <p className="premium-kicker mb-2">Connection</p>
                    <div className="th-drawer-card">
                      <p className="mb-3 text-[13px]" style={{ color: "var(--th-text-secondary)" }}>
                        Connect using this platform's native methods.
                      </p>
                      <ConnectMenu deviceId={device.id} hostname={device.hostname} onOpenTerminal={openTerminal} />
                    </div>
                  </section>
                </div>
              )}
              {tab === "monitoring" && (
                <div className="th-tab-panel">
                  <DeviceMonitoringPanel key={device.id} deviceId={device.id} active={isOpen} />
                </div>
              )}
              {tab === "terminal" && (
                <div className="th-tab-panel min-h-[340px]">
                  <Suspense
                    fallback={
                      <div className="flex items-center gap-2 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading terminal…
                      </div>
                    }
                  >
                    <DeviceTerminal deviceId={device.id} />
                  </Suspense>
                </div>
              )}
              {CAPABILITY_TABS.includes(tab) && (
                <div className="th-tab-panel">
                  <CapabilityPanel tab={tab} inventory={inventory} state={inventoryState} onRetry={loadInventory} />
                </div>
              )}
              {tab === "management" && (
                <div className="th-tab-panel">
                  <ManagementPanel meta={meta} busy={busy} canOperate={operate} onAction={onAction} />
                </div>
              )}
              {tab === "notes" && (
                <div className="th-tab-panel">
                  <NotesPanel
                    notes={notes}
                    loading={notesQuery.loading}
                    busy={noteBusy}
                    noteText={noteText}
                    setNoteText={setNoteText}
                    onAdd={addNote}
                    canOperate={operate}
                  />
                </div>
              )}
              {tab === "timeline" && (
                <div className="th-tab-panel">
                  <section className="th-drawer-card">
                    <ActivityTimeline events={events} loading={tlLoading} onReload={() => void reloadTimeline()} />
                  </section>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {confirm && (
        <ConfirmationModal
          title={`${confirm.label}?`}
          confirmLabel={confirm.label}
          destructive
          loading={busy === confirm.id}
          onConfirm={() => void runAction(confirm)}
          onClose={() => setConfirm(null)}
        >
          {confirm.label} will be queued for {displayName} and runs as soon as the device picks it up.
        </ConfirmationModal>
      )}
    </>
  );
}

function Row({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd className={`truncate ${mono ? "font-mono text-[12px]" : ""}`} title={value}>
        {value}
      </dd>
    </>
  );
}

// The address Connect dials, when the reported IPs cannot express it. Two real
// cases need this: a router reached over the office VPN on its LAN address, and
// a management service moved off its default port (Winbox on 8292/8293 rather
// than 8291). Left empty — which is every device until an operator sets one —
// the backend falls back to the reported addresses.
//
// Deliberately does NOT re-derive that fallback for display: the rule lives in
// `resolve_connect_host` on the backend, and a copy here would be one more
// thing to drift. Empty simply reads "Auto".
function ConnectTargetRow({
  device,
  canOperate,
  onDeviceUpdated,
}: {
  device: Device;
  canOperate: boolean;
  onDeviceUpdated?: (device: Device) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [host, setHost] = useState(device.connect_host ?? "");
  const [port, setPort] = useState(device.connect_port ? String(device.connect_port) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = device.connect_host
    ? device.connect_port
      ? `${device.connect_host}:${device.connect_port}`
      : device.connect_host
    : device.connect_port
      ? `Auto : ${device.connect_port}`
      : "Auto";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await updateDevice(device.id, {
        connect_host: host.trim() || null,
        connect_port: port.trim() ? Number(port) : null,
      });
      onDeviceUpdated?.(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setEditing(false);
    setHost(device.connect_host ?? "");
    setPort(device.connect_port ? String(device.connect_port) : "");
    setError(null);
  };

  return (
    <>
      <dt>Connect target</dt>
      <dd>
        {!editing ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-[12px]">{current}</span>
            {canOperate && (
              <button type="button" onClick={() => setEditing(true)} className="th-link-btn !h-6">
                Edit
              </button>
            )}
          </span>
        ) : (
          <div>
            <div className="flex items-center gap-2">
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="Auto (reported IP)"
                aria-label="Connect host"
                className="th-input min-w-0 flex-1 rounded border px-2 py-1 font-mono text-[12px]"
              />
              <input
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="Port"
                aria-label="Connect port"
                inputMode="numeric"
                className="th-input w-20 flex-none rounded border px-2 py-1 font-mono text-[12px]"
              />
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={cancel}>
                Cancel
              </Button>
              {error && (
                <span className="text-[12px]" style={{ color: TONE.critical }}>
                  {error}
                </span>
              )}
            </div>
          </div>
        )}
      </dd>
    </>
  );
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="premium-kicker">{title}</p>
        {aside}
      </div>
      <div className="th-drawer-card">{children}</div>
    </section>
  );
}

// os_caption packs connector inventory as "Key=value; Key=value" (e.g. the
// MikroTik "Board=..."); Overview reads only the keys it displays.
function captionValue(caption: string | null | undefined, key: string): string | null {
  if (!caption) return null;
  const part = caption
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.toLowerCase().startsWith(`${key.toLowerCase()}=`));
  return part ? part.slice(key.length + 1).trim() : null;
}

function AssignmentSourceBadge({ source }: { source?: string | null }) {
  const normalized = (source || "unassigned").toLowerCase();
  const label =
    normalized === "manual" || normalized === "legacy_manual"
      ? "manual"
      : normalized === "trusted_domain"
        ? "domain"
        : normalized === "enrollment_token"
          ? "token"
          : normalized === "auto_os" || normalized === "system_auto"
            ? "auto"
            : "unassigned";
  return <span className="th-status-chip !h-6">{label}</span>;
}

// Ordered by what an operator needs first: how do I reach it (Connect) → is it
// alive (Status) → what is it (Identity) → how loaded is it (Resources) → who
// owns it (Assignment). Deeper detail lives in its own capability tab.
function Overview({
  device,
  meta,
  liveUser,
  streaming,
  healthState,
  healthScore,
  clients,
  groups,
  canOperate,
  canManageLocations,
  onDeviceUpdated,
  onOpenTerminal,
  active,
  onOpenMonitoring,
}: {
  device: Device;
  meta: DrawerMeta;
  liveUser: string | null;
  streaming: boolean;
  healthState: React.ComponentProps<typeof HealthBadge>["state"];
  healthScore: number | null;
  clients: Client[];
  groups: DeviceGroup[];
  canOperate: boolean;
  canManageLocations: boolean;
  onDeviceUpdated?: (device: Device) => void;
  onOpenTerminal?: () => void;
  active: boolean;
  onOpenMonitoring?: () => void;
}) {
  const board = captionValue(device.os_caption, "Board");
  const availableGroups = groups.filter((g) => g.client_id === device.client_id);
  const versionStatus = meta.version_status ?? (meta.reported_version ? "current" : "unknown");
  const versionTitle = meta.latest_version ? `Latest: ${meta.latest_version}` : undefined;
  const methods = meta.connect_methods.length;

  return (
    <>
      <section className="mb-4">
        <div className="th-drawer-card flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="th-action-icon">
              <Link2 className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                Connect
              </p>
              <p className="truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                {methods} method{methods === 1 ? "" : "s"} available
              </p>
            </div>
          </div>
          <ConnectMenu deviceId={device.id} hostname={device.hostname} onOpenTerminal={onOpenTerminal} />
        </div>
      </section>

      <Section title="Status">
        <dl className="th-dl">
          <dt>Last seen</dt>
          <dd>
            {streaming ? (
              <>
                <span style={{ color: "var(--th-status-online)" }}>Live now</span>
                {device.last_seen && (
                  <span style={{ color: "var(--th-text-muted)" }}>
                    {" "}
                    · last heartbeat {formatDateTime(device.last_seen)}
                  </span>
                )}
              </>
            ) : device.last_seen ? (
              <>
                {formatDateTime(device.last_seen)}
                <span style={{ color: "var(--th-text-muted)" }}> · {timeAgo(device.last_seen)}</span>
              </>
            ) : (
              <span style={{ color: "var(--th-text-muted)" }}>Never</span>
            )}
          </dd>
          <dt>Health</dt>
          <dd>
            <HealthBadge state={healthState} score={healthScore} showLabel />
          </dd>
          <Row label="Local IP" value={device.local_ip} mono />
          <Row label="Public IP" value={device.public_ip} mono />
          <ConnectTargetRow device={device} canOperate={canOperate} onDeviceUpdated={onDeviceUpdated} />
          <Row label="Current user" value={liveUser ?? device.current_user ?? undefined} />
          <dt>Connector</dt>
          <dd>
            <VersionBadge version={meta.reported_version} status={versionStatus} title={versionTitle} />
          </dd>
        </dl>
      </Section>

      <Section title="Identity">
        <dl className="th-dl">
          <Row label="Device ID" value={String(device.id)} mono />
          <Row label="Hostname" value={device.hostname} />
          <Row label="OS" value={device.os_name} />
          <Row label="OS version" value={device.os_version} />
          <Row label="Kernel" value={device.kernel_version} mono />
          <Row label="Architecture" value={device.architecture} mono />
          <Row label="Board" value={board} />
        </dl>
      </Section>

      {/* History only: current values are in the Live panel at the top. */}
      <DeviceLast24hCard deviceId={device.id} active={active} onOpenMonitoring={onOpenMonitoring} />

      <Section title="Client assignment">
        <dl className="th-dl">
          <dt>Client</dt>
          <dd>{device.resolved_client_name || device.client_name || TERMS.noClient}</dd>
          <dt>Group</dt>
          <dd>{device.resolved_group || device.group_name || TERMS.noGroup}</dd>
          <dt>Location</dt>
          <dd>{device.location_name ? (deviceSite(device)?.title ?? device.location_name) : "No location"}</dd>
          <dt>Source</dt>
          <dd>
            <AssignmentSourceBadge source={device.resolved_assignment_source || device.assignment_source} />
          </dd>
        </dl>
        {canOperate && (
          <div
            className="mt-4 grid grid-cols-2 gap-3 border-t pt-4"
            style={{ borderColor: "var(--th-border-drawer-section)" }}
          >
            <label className="block">
              <span className="premium-kicker mb-1 block">Assign client</span>
              <SelectField
                value={device.client_id ?? "none"}
                onChange={async (e) => {
                  const value = e.target.value === "none" ? null : Number(e.target.value);
                  const updated = await assignDeviceClient(device.id, value);
                  onDeviceUpdated?.(updated);
                }}
                className="w-full"
              >
                <option value="none">{TERMS.noClient}</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </SelectField>
            </label>
            <div className="block">
              <span className="premium-kicker mb-1 block">Assign group</span>
              <GroupPicker
                device={device}
                groups={availableGroups}
                disabled={!device.client_id}
                onDeviceUpdated={onDeviceUpdated}
              />
            </div>
            {canManageLocations && (
              <div>
                <span className="premium-kicker mb-1 block">Assign location</span>
                <LocationPicker device={device} active onDeviceUpdated={onDeviceUpdated} />
              </div>
            )}
          </div>
        )}
      </Section>

      <ComponentStatesPanel deviceId={device.id} />
    </>
  );
}

function CapabilityPanel({
  tab,
  inventory,
  state,
  onRetry,
}: {
  tab: string;
  inventory: DeviceInventory | null;
  state: InventoryState;
  onRetry: () => void;
}) {
  const title = CAP_TAB_LABELS[tab] ?? humanize(tab);
  const table = (head: string[], rows: string[][], noun: string) => (
    <SimpleTable title={title} head={head} rows={rows} noun={noun} state={state} onRetry={onRetry} />
  );
  if (tab === "services") {
    return table(
      ["Name", "Status"],
      (inventory?.services ?? []).map((s) => [s.display_name || s.name, humanize(s.status)]),
      "services",
    );
  }
  if (tab === "processes") {
    return table(
      ["Name", "PID"],
      (inventory?.processes ?? []).map((p) => [p.name, String(p.pid)]),
      "processes",
    );
  }
  if (tab === "packages") {
    return table(
      ["Name", "Version"],
      (inventory?.software ?? []).map((s) => [s.name, s.version || "—"]),
      "packages",
    );
  }
  return (
    <Section title={title}>
      <EmptyState
        className="!py-6"
        icon={<Layers className="h-5 w-5" />}
        title="Detailed view not available yet for this platform"
        description={`This device reports ${title.toLowerCase()} data, but it cannot be shown here yet.`}
      />
    </Section>
  );
}

function SimpleTable({
  title,
  head,
  rows,
  noun,
  state,
  onRetry,
}: {
  title: string;
  head: string[];
  rows: string[][];
  noun: string;
  state: InventoryState;
  onRetry: () => void;
}) {
  const shown = rows.slice(0, TABLE_ROW_LIMIT);
  const aside =
    state === "ready" && rows.length > 0 ? (
      <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
        {rows.length} collected
      </span>
    ) : undefined;
  return (
    <Section title={title} aside={aside}>
      {state === "loading" ? (
        <div
          className="flex items-center justify-center gap-2 py-6 text-[13px]"
          style={{ color: "var(--th-text-muted)" }}
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading {noun}…
        </div>
      ) : state === "error" ? (
        <EmptyState
          className="!py-6"
          icon={<AlertTriangle className="h-5 w-5" />}
          title={`Couldn't load ${noun}`}
          description="The server did not answer. Try again."
          action={
            <Button size="sm" variant="secondary" onClick={onRetry}>
              <RefreshCcw className="h-3.5 w-3.5" />
              Retry
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          className="!py-6"
          title={`No ${noun} reported`}
          description="This device has not reported any yet."
        />
      ) : (
        <>
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0" style={{ background: "var(--th-bg-drawer-table-head)" }}>
                <tr>
                  {head.map((h) => (
                    <th
                      key={h}
                      className="pb-1.5 pr-3 text-left text-[12px] font-semibold"
                      style={{ color: "var(--th-text-muted)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--th-border-drawer-section)" }}>
                    {r.map((c, j) => (
                      <td
                        key={j}
                        className="max-w-[260px] truncate py-1.5 pr-3"
                        style={{ color: j === 0 ? "var(--th-text-primary)" : "var(--th-text-secondary)" }}
                        title={c}
                      >
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > shown.length && (
            <p className="mt-2 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              Showing {shown.length} of {rows.length}
            </p>
          )}
        </>
      )}
    </Section>
  );
}

function ManagementPanel({
  meta,
  busy,
  canOperate,
  onAction,
}: {
  meta: DrawerMeta;
  busy: string | null;
  canOperate: boolean;
  onAction: (a: DrawerAction) => void;
}) {
  return (
    <section className="mb-4">
      <p className="premium-kicker mb-2">Remote actions</p>
      {!canOperate && (
        <div className="th-drawer-callout mb-3 text-[13px]" data-tone="neutral">
          You have read-only access.
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        {meta.actions.map((a) => {
          const destructive = a.confirm === "confirm";
          const isBusy = busy === a.id;
          return (
            <button
              key={a.id}
              type="button"
              className="th-action-tile"
              data-destructive={destructive}
              disabled={!canOperate || busy !== null}
              aria-busy={isBusy}
              onClick={() => onAction(a)}
            >
              <span className="th-action-icon">
                {isBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : destructive ? (
                  <AlertTriangle className="h-4 w-4" />
                ) : (
                  <Wrench className="h-4 w-4" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-left text-[13px] font-medium">{a.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function NotesPanel({
  notes,
  loading,
  busy,
  noteText,
  setNoteText,
  onAdd,
  canOperate,
}: {
  notes: DeviceNote[];
  loading: boolean;
  busy: boolean;
  noteText: string;
  setNoteText: (v: string) => void;
  onAdd: () => void;
  canOperate: boolean;
}) {
  return (
    <section className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="premium-kicker">Notes</p>
        <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
          {notes.length} {notes.length === 1 ? "note" : "notes"}
        </span>
      </div>
      {canOperate && (
        <div className="th-drawer-card">
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            rows={3}
            placeholder="Add an internal note…"
            className="th-input w-full resize-none rounded-lg border px-3 py-2 text-[13px] leading-5 outline-none"
          />
          <div className="mt-2 flex justify-end">
            <Button size="sm" onClick={onAdd} disabled={busy || !noteText.trim()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Add note
            </Button>
          </div>
        </div>
      )}
      <div className="mt-3 space-y-2">
        {loading && notes.length === 0 ? (
          <p className="py-6 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
            Loading notes…
          </p>
        ) : notes.length === 0 ? (
          <EmptyState
            className="!py-6"
            icon={<StickyNote className="h-5 w-5" />}
            title="No notes yet"
            description="Internal notes are visible to every operator who can see this device."
          />
        ) : (
          notes.map((n) => {
            const author = n.created_by || "admin";
            return (
              <div key={n.id} className="th-drawer-card !p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="th-avatar !h-6 !w-6 !text-[11px]">{author.charAt(0).toUpperCase()}</span>
                  <span className="text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
                    {author}
                  </span>
                  <span
                    className="text-[12px]"
                    style={{ color: "var(--th-text-faint)" }}
                    title={formatDateTime(n.created_at)}
                  >
                    {timeAgo(n.created_at)}
                  </span>
                </div>
                <p
                  className="whitespace-pre-wrap pl-8 text-[13px] leading-5"
                  style={{ color: "var(--th-text-secondary)" }}
                >
                  {n.note}
                </p>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
