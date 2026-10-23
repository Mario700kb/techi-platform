import { ApiError } from "../api/client";
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTabIndicator } from "../hooks/useTabIndicator";
import { useNow } from "../hooks/useNow";
import { deviceFreshness } from "../utils/devicePresence";
import { DeviceStatusChip } from "./DeviceStatusChip";
import {
  Activity,
  AlertTriangle,
  AppWindow,
  CheckCircle,
  ChevronRight,
  ClipboardCopy,
  Download,
  Edit3,
  Fingerprint,
  HeartPulse,
  Loader2,
  Monitor,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Star,
  StickyNote,
  Trash2,
  UploadCloud,
  Wifi,
  WifiOff,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  getConnectUrl,
  getRemoteSupportDevice,
  getRemoteSupportPassword,
  setRemoteSupportPassword,
  regenerateRemoteSupportPassword,
  RemoteSupportDevice,
} from "../api/remoteSupport";
import { Client, DeviceGroup } from "../api/clients";
import {
  archiveDevice,
  clearDeviceMaintenance,
  Device,
  DeviceOfflineAnalysis,
  enterDeviceMaintenance,
  getDeviceOfflineAnalysis,
  updateDevice,
} from "../api/devices";
import { formatDateTime, formatLocalDateTime, parseUTC, timeAgo } from "../utils/time";
import { deviceTypeLabel, headerGroup } from "../utils/deviceBadges";
import { freshnessTone, humanize, isDeviceOffline, remoteSupportStatus, TERMS, TONE } from "../utils/deviceStatus";
import { isValidRustDeskId, buildRustDeskFallbackUrlFromTechiUrl, launchConnect } from "../services/rustdeskLaunch";
import {
  actionTypeLabel,
  ACTION_STATUS_LABELS,
  ActionType,
  cancelAction,
  DESTRUCTIVE_ACTIONS,
  getDeviceActions,
  getDeviceAgentChannel,
  isActiveStatus,
  isTerminalStatus,
  queueDeviceAction,
  RemoteAction,
  retryAction,
  statusColor,
  statusDotColor,
} from "../api/actions";
import { useAuth } from "../auth/AuthContext";
import { appCache } from "../store/appCache";
import {
  DeviceInventory,
  getDeviceInventory,
  inventoryCacheKey,
  patchStatusFromEvent,
  withPatchStatus,
} from "../api/inventory";
import { createDeviceNote, deleteDeviceNote, DeviceNote, getDeviceNotes, updateDeviceNote } from "../api/notes";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { useDeviceActivity } from "../hooks/useDeviceActivity";
import { useDeviceAlerts } from "../hooks/useDeviceAlerts";
import { useDeviceTelemetry } from "../hooks/useDeviceTelemetry";
import { usePlatformFeatures } from "../hooks/usePlatformFeatures";
import ConnectMenu from "./ConnectMenu";
import DeviceInventoryPanel from "./DeviceInventoryPanel";
import DeviceSecurityCard from "./DeviceSecurityCard";
import { Button, ConnectButton, EmptyState, Kv, SectionHeader } from "./ui";
import DeviceAssignmentCard from "./DeviceAssignmentCard";
import DeviceIdentityCard from "./DeviceIdentityCard";
import { Alert, ALERT_KIND_LABELS, ALERT_SEVERITY_TONE, AlertSeverity } from "../types/alert";
import AlertKindIcon from "./AlertKindIcon";
import ActivityTimeline from "./ActivityTimeline";
import ComponentStatesPanel from "./ComponentStatesPanel";
import ConfirmationModal from "./ConfirmationModal";
import HealthBadge from "./HealthBadge";
import { deviceDisplayName, deviceHostnameSubtitle } from "../utils/deviceLabel";
import DeviceLivePanel, { HeartbeatValues } from "./DeviceLivePanel";
import DeviceLast24hCard from "./DeviceLast24hCard";
import DeviceMonitoringPanel from "./DeviceMonitoringPanel";
import DevicePowerShellPanel from "./DevicePowerShellPanel";
import RemoteSupportIdOrigin from "./RemoteSupportIdOrigin";
import { addQueuedAction } from "../utils/remoteActions";
import { isActiveUpdate, upsertAction, updateTargetVersion } from "../utils/agentUpdate";
import { AgentUpdateCompact } from "./AgentUpdateProgress";
import { useDeviceLive } from "../hooks/useDeviceLive";

interface DeviceDrawerProps {
  device: Device;
  isOpen: boolean;
  onClose: () => void;
  latestEvent?: DeviceRealtimeEvent | null;
  clients?: Client[];
  groups?: DeviceGroup[];
  onDeviceUpdated?: (device: Device) => void;
  canOperate?: boolean;
  isFavorite?: boolean;
  onToggleFavorite?: (deviceId: number) => void;
  /** Tab to open on (e.g. "management" for a Linux console from Connect). */
  initialTab?: string;
}

/** Recently resolved alerts shown before "Show N more". */
const RESOLVED_SHOWN = 3;

type DrawerTab =
  "overview" | "monitoring" | "remote_support" | "terminal" | "software" | "management" | "notes" | "timeline";

// "management" is the Maintenance tab (id kept to limit churn).
const drawerTabs: Array<{ id: DrawerTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "monitoring", label: "Monitoring" },
  { id: "remote_support", label: "Remote Support" },
  { id: "software", label: "Software" },
  { id: "management", label: "Maintenance" },
  { id: "notes", label: "Notes" },
  { id: "timeline", label: "Timeline" },
];

// Lazy so xterm.js only loads when a terminal is actually opened — the main
// bundle and the flag-off experience are unchanged.
const DeviceTerminal = lazy(() => import("./DeviceTerminal"));

/** How serious a health reason reads: "critical"/"offline" ones are red. */
function issueTone(reason: string): string {
  if (/critical|offline|down|fail|stopped/i.test(reason)) return TONE.critical;
  return TONE.warning;
}

/** Health issues as tinted chips on one wrapping line (the first four; the rest in a "+N" chip). */
function HealthIssueChips({ reasons }: { reasons: string[] }) {
  const shown = reasons.slice(0, 4);
  const rest = reasons.slice(4);
  return (
    <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label="Health issues">
      {shown.map((r) => (
        <li key={r} className="th-issue-chip" title={r} style={{ "--chip-tone": issueTone(r) } as React.CSSProperties}>
          <i aria-hidden="true" />
          <span>{r}</span>
        </li>
      ))}
      {rest.length > 0 && (
        <li
          className="th-issue-chip"
          title={rest.join("\n")}
          style={{ "--chip-tone": TONE.neutral } as React.CSSProperties}
        >
          <span>+{rest.length} more</span>
        </li>
      )}
    </ul>
  );
}

function HeartbeatFreshness({ lastSeen }: { lastSeen?: string }) {
  if (!lastSeen) return <span className="text-xs font-medium text-slate-500">Never</span>;
  const diffSec = (Date.now() - parseUTC(lastSeen).getTime()) / 1000;
  let label: string;
  let cls: string;
  if (diffSec < 90) {
    label = "Fresh";
    cls = "text-emerald-400";
  } else if (diffSec < 300) {
    label = timeAgo(lastSeen);
    cls = "text-emerald-300";
  } else if (diffSec < 900) {
    label = timeAgo(lastSeen);
    cls = "text-amber-400";
  } else {
    label = timeAgo(lastSeen);
    cls = "text-red-400";
  }
  return <span className={`text-xs font-semibold ${cls}`}>{label}</span>;
}

function alertDuration(alert: Alert): string | null {
  if (!alert.resolved_at) return null;
  const minutes = Math.max(
    0,
    Math.round((parseUTC(alert.resolved_at).getTime() - parseUTC(alert.created_at).getTime()) / 60_000),
  );
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function AlertRow({ alert, resolved = false }: { alert: Alert; resolved?: boolean }) {
  // A resolved alert is dated by when it was resolved; when it opened and how
  // long it lasted are in the tooltip.
  const at = resolved && alert.resolved_at ? alert.resolved_at : alert.created_at;
  const duration = resolved ? alertDuration(alert) : null;
  const title =
    resolved && alert.resolved_at
      ? `Opened ${formatDateTime(alert.created_at)} · resolved ${formatDateTime(alert.resolved_at)}${duration ? ` · lasted ${duration}` : ""}`
      : formatDateTime(alert.created_at);
  const tone = ALERT_SEVERITY_TONE[alert.severity as AlertSeverity] ?? "var(--th-text-muted)";
  return (
    <div className={`flex items-start gap-2.5 py-1.5 ${resolved ? "opacity-80" : ""}`}>
      {/* The kind says what happened; the colour says how serious it was. */}
      <span className="mt-0.5 flex-none" style={{ color: tone }} aria-hidden="true">
        <AlertKindIcon kind={alert.kind} className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[12px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
            {ALERT_KIND_LABELS[alert.kind] ?? alert.kind}
          </span>
          <span
            className="th-status-chip !h-5 flex-none !px-1.5 !text-[11px] capitalize"
            style={{ "--chip-tone": tone } as React.CSSProperties}
          >
            <i />
            {alert.severity}
          </span>
          {resolved && (
            <span className="flex-none text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              Resolved
            </span>
          )}
          <time
            dateTime={at}
            title={title}
            className="ml-auto flex-none text-[12px]"
            style={{ color: "var(--th-text-muted)" }}
          >
            {timeAgo(at)}
          </time>
        </div>
        <p className="text-xs leading-5" style={{ color: "var(--th-text-secondary)" }}>
          {alert.message}
        </p>
      </div>
    </div>
  );
}

const OFFLINE_REASON_LABELS: Record<string, string> = {
  site_outage: "Site outage suspected",
  network_lost: "Network issue likely",
  agent_stopped: "Agent stopped",
  remote_support_stopped: "Remote Support stopped",
  stale_heartbeat: "Stale heartbeat",
  possibly_power_off: "Possibly powered off",
  unknown: "Unknown",
};

export default function DeviceDrawer({
  device,
  isOpen,
  onClose,
  latestEvent,
  clients = [],
  groups = [],
  onDeviceUpdated,
  canOperate = false,
  isFavorite = false,
  onToggleFavorite,
  initialTab,
}: DeviceDrawerProps) {
  useNow();
  const { user, hasPermission, can } = useAuth();

  const [maintenanceForm, setMaintenanceForm] = useState<{ duration: string; note: string }>({
    duration: "",
    note: "",
  });
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [noteToDelete, setNoteToDelete] = useState<number | null>(null);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(device.display_name ?? "");
  const [nameSaving, setNameSaving] = useState(false);

  const [openedFor, setOpenedFor] = useState<number | null>(null);
  if (isOpen && openedFor !== device.id) setOpenedFor(device.id);
  const {
    data: actionsData,
    loading: actionsLoading,
    reload: loadActions,
    setData: setActionsData,
  } = useCachedQuery(openedFor === device.id ? `page.device.${device.id}.actions` : null, () =>
    getDeviceActions(device.id),
  );
  // Why the last action the operator asked for was not queued (shown in
  // Maintenance); a conflict names the action in the way so it can be cancelled.
  const [actionProblem, setActionProblem] = useState<{
    message: string;
    conflictId?: number;
  } | null>(null);
  const reportActionError = (requested: ActionType, err: unknown) => {
    if (err instanceof ApiError && err.code === "action_conflict" && typeof err.data?.action_id === "number") {
      const blocking = String(err.data.action_type ?? "");
      setActionProblem({
        message: `${actionTypeLabel(requested)} was not sent: ${actionTypeLabel(blocking)} (#${err.data.action_id}) is still ${String(err.data.status ?? "queued")}. It goes out as soon as the device is reachable — or cancel it and try again.`,
        conflictId: err.data.action_id,
      });
      return;
    }
    setActionProblem({
      message: `${actionTypeLabel(requested)} was not sent: ${err instanceof Error ? err.message : "the platform refused it"}.`,
    });
  };
  const actions = actionsData ?? [];
  const setActions = useCallback(
    (update: (prev: RemoteAction[]) => RemoteAction[]) => setActionsData((prev) => update(prev ?? [])),
    [setActionsData],
  );
  const [selectedActionType, setSelectedActionType] = useState<ActionType>("ping");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionFilter, setActionFilter] = useState<"all" | "active" | "done" | "failed">("all");
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);

  // Inventory is deliberately NOT auto-fetched. It used to load on every drawer
  // open, for every device, whether or not anyone looked at it — one wasted
  // GET /devices/{id}/inventory per open across a 770-device fleet. The mobile
  // drawer already required an explicit tap; desktop now matches it, and the
  // operator can re-pull whenever they want via the Refresh button. A copy
  // pulled earlier this session is shown without a request.
  const inventoryKey = inventoryCacheKey(device.id);
  const [inventoryRequestedFor, setInventoryRequestedFor] = useState<number | null>(null);
  const inventoryQuery = useCachedQuery(inventoryRequestedFor === device.id ? inventoryKey : null, () =>
    getDeviceInventory(device.id),
  );
  const inventory = inventoryQuery.data ?? appCache.peek<DeviceInventory>(inventoryKey);
  const platformFeatures = usePlatformFeatures();
  const [activeTab, setActiveTab] = useState<DrawerTab>("overview");
  const drawerTabsRef = useTabIndicator<HTMLDivElement>(activeTab);
  const [notesFor, setNotesFor] = useState<number | null>(null);
  if (isOpen && activeTab === "notes" && notesFor !== device.id) setNotesFor(device.id);
  const {
    data: notesData,
    loading: notesLoading,
    setData: setNotesData,
  } = useCachedQuery(notesFor === device.id ? `page.device.${device.id}.notes` : null, () => getDeviceNotes(device.id));
  const notes = notesData ?? [];
  const setNotes = useCallback(
    (update: (prev: DeviceNote[]) => DeviceNote[]) => setNotesData((prev) => update(prev ?? [])),
    [setNotesData],
  );
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");

  // Remote Support tab state
  const [rsFor, setRsFor] = useState<number | null>(null);
  if (isOpen && activeTab === "remote_support" && rsFor !== device.id) setRsFor(device.id);
  const { data: rsDevice, loading: rsLoading } = useCachedQuery<RemoteSupportDevice>(
    rsFor === device.id ? `page.device.${device.id}.remote-support` : null,
    () => getRemoteSupportDevice(device.id),
  );
  const [rsBusyAction, setRsBusyAction] = useState<string | null>(null);
  const [rsToast, setRsToast] = useState<{ message: string; ok: boolean } | null>(null);
  const [maintFormOpen, setMaintFormOpen] = useState(false);
  const offline = isDeviceOffline(device);
  // Now, by the shared clock: the header, the offline analysis and the
  // archive hint follow the device as it ages, between events.
  const freshness = deviceFreshness(device);
  const canConnectRs =
    isValidRustDeskId(device.rustdesk_id) &&
    !device.rustdesk_conflict_detected &&
    hasPermission("remote_support_connect");
  const connectRsTitle = !hasPermission("remote_support_connect")
    ? "Permission required: remote_support_connect"
    : device.rustdesk_conflict_detected
      ? `${TERMS.remoteSupportId} conflict detected`
      : isValidRustDeskId(device.rustdesk_id)
        ? `Open ${TERMS.remoteSupport}`
        : `${TERMS.remoteSupportId} not resolved yet`;
  const connectRemoteSupport = async () => {
    try {
      const res = await getConnectUrl(device.id);
      launchConnect(res.connect_url, buildRustDeskFallbackUrlFromTechiUrl(res.connect_url), () => {
        setRsToast({ message: "Opening the Remote Support app instead", ok: true });
        setTimeout(() => setRsToast(null), 3000);
      });
    } catch (err) {
      setRsToast({ message: err instanceof Error ? err.message : "Connect failed", ok: false });
      setTimeout(() => setRsToast(null), 3000);
    }
  };
  const [rsCopySuccess, setRsCopySuccess] = useState(false);
  const [rsPassword, setRsPassword] = useState<string | null>(null);
  const [rsPasswordSource, setRsPasswordSource] = useState<string | null>(null);
  const [rsPasswordBusy, setRsPasswordBusy] = useState(false);
  const [rsCustomPassword, setRsCustomPassword] = useState("");

  // Offline analysis state
  const [offlineAnalysis, setOfflineAnalysis] = useState<DeviceOfflineAnalysis | null>(null);
  const offlineAnalysisLoadedFor = useRef<number | null>(null);

  const { events, loading, reload } = useDeviceActivity({
    deviceId: device.id,
    latestEvent,
    enabled: isOpen && activeTab === "timeline",
  });
  const { snapshot, healthScore, healthState, healthReasons } = useDeviceTelemetry({
    deviceId: device.id,
    latestEvent,
  });
  const { openAlerts, resolvedAlerts } = useDeviceAlerts({
    deviceId: device.id,
    latestEvent,
  });
  const [showAllResolved, setShowAllResolved] = useState(false);
  const maintenanceRef = useRef<HTMLElement>(null);
  useEffect(() => setShowAllResolved(false), [device.id]);
  const displayName = deviceDisplayName(device);
  const hostnameSubtitle = deviceHostnameSubtitle(device);

  useEffect(() => {
    setNameDraft(device.display_name ?? "");
    setNameEditing(false);
  }, [device.id, device.display_name]);

  async function saveDisplayName() {
    const trimmed = nameDraft.trim();
    setNameSaving(true);
    try {
      const updated = await updateDevice(device.id, { display_name: trimmed || null });
      onDeviceUpdated?.(updated);
      setNameEditing(false);
    } finally {
      setNameSaving(false);
    }
  }

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handler);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    setActiveTab(initialTab && drawerTabs.some((t) => t.id === initialTab) ? (initialTab as DrawerTab) : "overview");
  }, [device.id, initialTab]);

  const { reload: reloadInventory } = inventoryQuery;
  const loadInventory = useCallback(() => {
    if (inventoryRequestedFor === device.id) void reloadInventory();
    else setInventoryRequestedFor(device.id);
  }, [inventoryRequestedFor, device.id, reloadInventory]);

  useEffect(() => {
    setNoteText("");
    setEditingNoteId(null);
    setEditingText("");
  }, [device.id]);

  useEffect(() => {
    setRsCopySuccess(false);
    setRsToast(null);
    setRsBusyAction(null);
    setRsPassword(null);
    setRsPasswordSource(null);
    setRsCustomPassword("");
    offlineAnalysisLoadedFor.current = null;
    setOfflineAnalysis(null);
  }, [device.id]);

  // Load offline analysis when Overview tab becomes active
  useEffect(() => {
    if (!isOpen || activeTab !== "overview") return;
    if (offlineAnalysisLoadedFor.current === device.id) return;
    offlineAnalysisLoadedFor.current = device.id;
    getDeviceOfflineAnalysis(device.id)
      .then(setOfflineAnalysis)
      .catch(() => {
        /* non-critical */
      });
  }, [isOpen, activeTab, device.id]);

  const { setData: setInventory } = inventoryQuery;
  useEffect(() => {
    const patch = patchStatusFromEvent(latestEvent ?? null);
    if (patch?.device_id !== device.id) return;
    setInventory((prev) => (prev ? withPatchStatus(prev, patch) : prev));
  }, [latestEvent, device.id, setInventory]);

  // Merge realtime action events without a full reload.
  useEffect(() => {
    if (!latestEvent) return;
    const { type, data } = latestEvent;
    if (type !== "action_queued" && type !== "action_status_changed") return;
    const ev = data as Record<string, unknown>;
    if (ev?.device_id !== device.id) return;

    const patch = ev as unknown as RemoteAction;
    if (!patch?.id) return;

    // A new one (queued from another session) is prepended; a known one only
    // moves forward — the same event also reaches the Components panel's
    // socket, which reports it here too, and a late copy must not undo a newer
    // one (an update at 60% dropping back to 20%).
    setActions((prev) => upsertAction(prev, patch));
  }, [latestEvent, device.id, setActions]);
  const noteActionChange = useCallback(
    (action: RemoteAction) => {
      if (action.device_id !== device.id) return;
      setActions((prev) => upsertAction(prev, action));
    },
    [device.id, setActions],
  );

  const addNote = useCallback(async () => {
    const note = noteText.trim();
    if (!note) return;
    setNoteBusy(true);
    try {
      const created = await createDeviceNote(device.id, note);
      setNotes((prev) => [created, ...prev]);
      setNoteText("");
      if (activeTab === "timeline") void reload();
    } finally {
      setNoteBusy(false);
    }
  }, [activeTab, device.id, noteText, reload, setNotes]);

  const saveNote = useCallback(
    async (noteId: number) => {
      const note = editingText.trim();
      if (!note) return;
      setNoteBusy(true);
      try {
        const updated = await updateDeviceNote(device.id, noteId, note);
        setNotes((prev) => prev.map((item) => (item.id === noteId ? updated : item)));
        setEditingNoteId(null);
        setEditingText("");
        if (activeTab === "timeline") void reload();
      } finally {
        setNoteBusy(false);
      }
    },
    [activeTab, device.id, editingText, reload, setNotes],
  );

  // Auto-save when editing an existing note (1.5s debounce)
  useEffect(() => {
    if (!editingNoteId || !editingText.trim()) return;
    const t = window.setTimeout(() => {
      void saveNote(editingNoteId);
    }, 1500);
    return () => window.clearTimeout(t);
  }, [editingText]); // eslint-disable-line react-hooks/exhaustive-deps

  const removeNote = useCallback(
    async (noteId: number) => {
      setNoteBusy(true);
      try {
        await deleteDeviceNote(device.id, noteId);
        setNotes((prev) => prev.filter((item) => item.id !== noteId));
        if (activeTab === "timeline") void reload();
      } finally {
        setNoteBusy(false);
      }
    },
    [activeTab, device.id, reload, setNotes],
  );

  const syncColor = device.rustdesk_conflict_detected
    ? "text-red-400"
    : device.rustdesk_sync_state === "synced"
      ? "text-emerald-400"
      : device.rustdesk_sync_state === "degraded"
        ? "text-amber-400"
        : "text-slate-400";

  const syncLabel = device.rustdesk_manual_override
    ? "Manual override"
    : device.rustdesk_conflict_detected
      ? "Conflict"
      : device.rustdesk_sync_state;
  // Is the agent's live command channel open? Checked while the actions tab
  // is shown, so the banner says whether an action runs now or at the next
  // heartbeat.
  const [channelConnected, setChannelConnected] = useState<boolean | null>(null);
  useEffect(() => {
    if (!isOpen || activeTab !== "management") return;
    let cancelled = false;
    const check = () =>
      getDeviceAgentChannel(device.id)
        .then((r) => !cancelled && setChannelConnected(r.connected))
        .catch(() => !cancelled && setChannelConnected(null));
    void check();
    const timer = setInterval(check, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isOpen, activeTab, device.id]);

  // Live view: the stream starts as the drawer opens (whatever the tab, so
  // Overview has frames by the time it is shown) and stops when it closes or
  // shows another device. Only Windows and Linux agents have the channel.
  const livePlatform = /^(windows|linux)/i.test(device.platform || "");
  const live = useDeviceLive(device.id, isOpen && livePlatform && !device.is_archived);
  const streaming = live.state === "live" && live.snapshot !== null;
  // One place for current values: the panel shows the stream, or else what
  // the last heartbeat said, labelled with its age.
  const heartbeatValues: HeartbeatValues | null = snapshot
    ? {
        cpu_percent: snapshot.cpu_percent,
        ram_percent: snapshot.ram_percent,
        disk_percent: snapshot.disk_percent,
        uptime_seconds: snapshot.uptime_seconds,
        current_user: device.current_user,
        at: snapshot.created_at,
        processes: inventory?.device_id === device.id ? inventory.processes : null,
      }
    : null;

  const isWindows = !device.platform || /^windows/i.test(device.platform);
  // Linux has the Windows drawer too: its root shell lives in Maintenance, as
  // the administrator console, where PowerShell is on Windows.
  const isLinux = /^linux/i.test(device.platform || "");
  const terminalCapable = Boolean(device.capabilities && "terminal" in device.capabilities);
  // Capability-driven Terminal tab: only when FEATURE_TERMINAL is on AND the
  // device reports the terminal capability. Inserted after Remote Support so the
  // Connect-oriented tabs sit together; Windows (no terminal cap) and Linux
  // (its console is in Maintenance) never see it.
  const hasTerminal = platformFeatures.FEATURE_TERMINAL && terminalCapable && !isLinux;
  const visibleDrawerTabs = hasTerminal
    ? [...drawerTabs.slice(0, 3), { id: "terminal" as DrawerTab, label: "Terminal" }, ...drawerTabs.slice(3)]
    : drawerTabs;
  // Administrator console — PowerShell (Windows, agent 2.1.29+) or the root
  // shell (Linux): admin/owner only, behind the same platform flag as the
  // terminal, opened with a two-factor code. The backend enforces all again.
  const showPowerShell = (isWindows || isLinux) && platformFeatures.FEATURE_TERMINAL && can("admin");
  const powerShellCapable = isLinux
    ? terminalCapable
    : Boolean(device.capabilities && "powershell" in device.capabilities);
  // Agent actions a Linux agent answers "not supported" to.
  const linuxUnsupported = new Set<ActionType>(["apply_power_policy", "reopen_rustdesk", "repair_config_rustdesk"]);
  const supported = (type: ActionType) => !(isLinux && linuxUnsupported.has(type));

  return (
    <>
      {/* Shtresa mbyllese */}
      <div
        className={`th-drawer-scrim fixed inset-0 z-40 backdrop-blur-[2px] ${
          isOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        style={{ background: "var(--th-scrim)" }}
        data-open={isOpen}
        role="presentation"
        onClick={onClose}
      />

      {/* Paneli */}
      <div
        className={`th-drawer th-drawer-panel fixed right-0 top-0 z-50 flex h-full w-full max-w-[720px] 2xl:max-w-[780px] flex-col shadow-2xl ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
        data-open={isOpen}
        style={{
          borderLeft: "1px solid var(--th-border-drawer)",
          background: "var(--th-bg-drawer)",
        }}
      >
        {/* Koka */}
        <header className="flex-none px-5 pt-4" style={{ borderBottom: "1px solid var(--th-border-drawer-section)" }}>
          <div className="flex items-start gap-3">
            <span className="th-palette-icon !h-10 !w-10 flex-none" aria-hidden="true">
              {deviceTypeLabel(device) === TERMS.server ? (
                <Server className="h-5 w-5" />
              ) : (
                <Monitor className="h-5 w-5" />
              )}
              <i style={{ background: freshnessTone(freshness) }} />
            </span>

            <div className="min-w-0 flex-1">
              {nameEditing ? (
                <div className="flex min-w-0 items-center gap-1.5">
                  <input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveDisplayName();
                      if (e.key === "Escape") {
                        setNameDraft(device.display_name ?? "");
                        setNameEditing(false);
                      }
                    }}
                    maxLength={128}
                    autoFocus
                    placeholder={device.hostname || "Device name"}
                    aria-label="Display name"
                    className="th-input h-8 min-w-0 flex-1 rounded-md border px-2 text-[14px] font-semibold"
                  />
                  <button
                    type="button"
                    disabled={nameSaving}
                    onClick={() => void saveDisplayName()}
                    title="Save name"
                    aria-label="Save name"
                    className="th-icon-btn th-icon-btn-ghost !min-h-8 !min-w-8"
                  >
                    {nameSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  </button>
                  <button
                    type="button"
                    disabled={nameSaving}
                    onClick={() => {
                      setNameDraft(device.display_name ?? "");
                      setNameEditing(false);
                    }}
                    title="Cancel"
                    aria-label="Cancel"
                    className="th-icon-btn th-icon-btn-ghost !min-h-8 !min-w-8"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="group/name flex min-w-0 items-center gap-1">
                  <h2
                    className="min-w-0 break-words text-[17px] font-semibold leading-snug"
                    style={{ color: "var(--th-text-primary)" }}
                    title={displayName}
                  >
                    {displayName}
                  </h2>
                  {canOperate && (
                    <button
                      type="button"
                      onClick={() => setNameEditing(true)}
                      title="Rename device"
                      aria-label="Rename device"
                      className="th-icon-btn th-icon-btn-ghost !min-h-7 !min-w-7 opacity-0 focus-visible:opacity-100 group-hover/name:opacity-100"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
              <p className="mt-0.5 truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                {[
                  // The console's category (standard group first, then the
                  // OS), not the legacy device_type column; a standard group
                  // is not repeated after it.
                  deviceTypeLabel(device),
                  device.resolved_client_name || device.client_name || TERMS.noClient,
                  headerGroup(device),
                  hostnameSubtitle ? `host ${hostnameSubtitle}` : null,
                  `#${device.id}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>

            <div className="flex flex-none items-center gap-0.5">
              {onToggleFavorite && (
                <button
                  type="button"
                  onClick={() => onToggleFavorite(device.id)}
                  title={isFavorite ? "Remove from favorites" : "Add to favorites"}
                  aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
                  className="th-icon-btn th-icon-btn-ghost"
                  style={isFavorite ? { color: "var(--th-status-warning)" } : undefined}
                >
                  <Star className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                title="Close (Esc)"
                className="th-icon-btn th-icon-btn-ghost"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Status strip + primary action */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <DeviceStatusChip device={device} />
            {healthScore != null && (
              <span
                className="th-status-chip"
                style={
                  {
                    "--chip-tone":
                      healthState === "critical"
                        ? "var(--th-status-critical)"
                        : healthState === "warning"
                          ? "var(--th-status-warning)"
                          : "var(--th-status-online)",
                  } as React.CSSProperties
                }
                title="Health score of 100"
              >
                <i />
                Health {healthScore}
              </span>
            )}
            {device.is_in_maintenance && (
              <span className="th-status-chip" style={{ "--chip-tone": TONE.maintenance } as React.CSSProperties}>
                <i />
                Maintenance
              </span>
            )}
            {platformFeatures.FEATURE_PLATFORM_CORE ? (
              // One split button: Connect opens Remote Support as before; the
              // arrow lists the device's other Connect methods.
              <div className="ml-auto">
                <ConnectMenu
                  deviceId={device.id}
                  hostname={device.hostname}
                  onMain={() => void connectRemoteSupport()}
                  mainDisabledReason={canConnectRs ? null : connectRsTitle}
                  mainHint={connectRsTitle}
                  onRemoteSupport={() => void connectRemoteSupport()}
                  onOpenTerminal={
                    hasTerminal
                      ? () => setActiveTab("terminal")
                      : isLinux && showPowerShell
                        ? () => setActiveTab("management")
                        : undefined
                  }
                />
              </div>
            ) : (
              <ConnectButton
                className="ml-auto"
                disabled={!canConnectRs}
                onClick={() => void connectRemoteSupport()}
                title={connectRsTitle}
              />
            )}
          </div>

          <div
            ref={drawerTabsRef}
            role="tablist"
            aria-label="Device sections"
            className="th-tabs mt-3 !flex-nowrap overflow-x-auto"
            style={{ scrollbarWidth: "none" }}
          >
            {visibleDrawerTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="th-tab flex-none whitespace-nowrap !px-3"
              >
                {tab.label}
              </button>
            ))}
          </div>
        </header>

        {/* Trupi me scroll */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* Toast feedback */}
          {rsToast && (
            <div
              className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium"
              style={{
                background: rsToast.ok
                  ? "color-mix(in srgb, var(--th-status-online) 10%, transparent)"
                  : "color-mix(in srgb, var(--th-status-critical) 10%, transparent)",
                border: `1px solid ${rsToast.ok ? "color-mix(in srgb, var(--th-status-online) 25%, transparent)" : "color-mix(in srgb, var(--th-status-critical) 25%, transparent)"}`,
                color: rsToast.ok ? "var(--th-status-online)" : "var(--th-status-critical)",
              }}
            >
              {rsToast.message}
            </div>
          )}
          <div className={activeTab === "overview" ? "th-tab-panel" : "hidden"}>
            {/* Paralajmerim per pajisje te arkivuar por aktive */}
            {device.is_archived && freshness !== "offline" && (
              <div
                className="mb-3.5 flex items-start gap-3 rounded-lg px-4 py-3"
                style={{
                  border: "1px solid color-mix(in srgb, var(--th-accent) 25%, transparent)",
                  background: "color-mix(in srgb, var(--th-accent) 7%, transparent)",
                }}
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-orange-400" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-orange-300">Archived device is checking in</p>
                  <p className="mt-0.5 text-[11px] leading-5 text-orange-200/70">
                    This device is archived but is still sending heartbeats. No automatic action has been taken. Restore
                    the device manually if it should rejoin the active fleet.
                  </p>
                </div>
              </div>
            )}

            {/* Paralajmerim per duplikim */}
            {device.duplicate_candidate && (
              <div className="th-drawer-callout mb-3.5" data-tone="warning">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold">Possible duplicate device</p>
                    <p className="mt-0.5 text-[12px] leading-5" style={{ color: "var(--th-text-secondary)" }}>
                      {device.duplicate_of_device_id
                        ? `Fingerprint similarity with Device #${device.duplicate_of_device_id}${
                            device.duplicate_score != null
                              ? ` — ${Math.round(device.duplicate_score * 100)}% match`
                              : ""
                          }. Review and archive this record if it is a stale duplicate.`
                        : "This device may be a duplicate of an existing record. No automatic action has been taken."}
                    </p>
                  </div>
                </div>
                {canOperate && !device.is_archived && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={archiveBusy}
                    onClick={() => setArchiveConfirmOpen(true)}
                    className="mt-3 w-full"
                  >
                    {archiveBusy ? "Archiving…" : "Archive this duplicate"}
                  </Button>
                )}
              </div>
            )}

            {/* Status */}
            <section className="mb-3.5" aria-label="Status">
              <SectionHeader
                title="Status"
                meta={
                  healthReasons.length === 0
                    ? "No issues"
                    : `${healthReasons.length} issue${healthReasons.length === 1 ? "" : "s"}`
                }
              />
              <div className="th-drawer-card">
                <dl className="th-kv">
                  <Kv label="Last seen">
                    {streaming ? (
                      <>
                        <span style={{ color: "var(--th-status-online)" }}>Live now</span>
                        {device.last_seen && (
                          <span className="th-kv-sub">last heartbeat {formatLocalDateTime(device.last_seen)}</span>
                        )}
                      </>
                    ) : device.last_seen ? (
                      // Two lines like "Live now": the Live section below
                      // does not move when the stream starts or stops.
                      <>
                        {formatLocalDateTime(device.last_seen)}
                        <span className="th-kv-sub">
                          <HeartbeatFreshness lastSeen={device.last_seen} />
                        </span>
                      </>
                    ) : (
                      <span className="th-kv-muted">Never</span>
                    )}
                  </Kv>
                  <Kv label="Health">
                    <HealthBadge state={healthState} score={healthScore} showLabel />
                  </Kv>
                  <Kv label="Health issues" span>
                    {healthReasons.length > 0 ? (
                      <HealthIssueChips reasons={healthReasons} />
                    ) : (
                      <span className="th-kv-muted">No issues</span>
                    )}
                  </Kv>
                </dl>

                {freshness !== "online" && offlineAnalysis && offlineAnalysis.reason && (
                  <div className="th-drawer-callout mt-2" data-tone="warning">
                    <div className="flex flex-wrap items-center gap-2">
                      <AlertTriangle className="h-4 w-4 flex-none" />
                      <span className="text-[13px] font-semibold">
                        {OFFLINE_REASON_LABELS[offlineAnalysis.reason] ?? offlineAnalysis.reason}
                      </span>
                      {offlineAnalysis.confidence && (
                        <span className="text-[12px] capitalize" style={{ color: "var(--th-text-muted)" }}>
                          · {offlineAnalysis.confidence} confidence
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[13px]" style={{ color: "var(--th-text-secondary)" }}>
                      {offlineAnalysis.explanation}
                    </p>
                    {offlineAnalysis.evidence.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                        {offlineAnalysis.evidence.map((e, i) => (
                          <li key={i}>· {e}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </section>

            {!device.is_archived && (
              <DeviceLivePanel
                key={`live-${device.id}`}
                live={live}
                fallback={heartbeatValues}
                liveCapable={livePlatform}
              />
            )}

            {/* History only: current values are in the Live panel above. */}
            <DeviceLast24hCard
              deviceId={device.id}
              active={isOpen && activeTab === "overview"}
              onOpenMonitoring={() => setActiveTab("monitoring")}
            />

            {/* Sinjalizimet */}
            <section className="mb-3.5" aria-label="Alerts">
              <SectionHeader
                title="Alerts"
                meta={
                  openAlerts.length > 0 ? (
                    <span
                      className="th-status-chip !h-6"
                      style={{ "--chip-tone": TONE.critical } as React.CSSProperties}
                    >
                      <i />
                      {openAlerts.length} active
                    </span>
                  ) : resolvedAlerts.length > 0 ? (
                    `None active · ${resolvedAlerts.length} resolved`
                  ) : (
                    "None active"
                  )
                }
              />
              <div className="th-drawer-card">
                {openAlerts.length === 0 && resolvedAlerts.length === 0 ? (
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-emerald-500" />
                    <p className="text-xs font-medium text-slate-400">No alerts for this device</p>
                  </div>
                ) : (
                  <>
                    {openAlerts.length > 0 && (
                      <div className="divide-y divide-[color:var(--th-border-drawer-section)]">
                        {openAlerts.map((a) => (
                          <AlertRow key={a.id} alert={a} />
                        ))}
                      </div>
                    )}
                    {resolvedAlerts.length > 0 && (
                      <div
                        className={`divide-y divide-[color:var(--th-border-drawer-section)] ${openAlerts.length > 0 ? "mt-2 border-t pt-2" : ""}`}
                        style={{ borderColor: "var(--th-border-drawer-section)" }}
                      >
                        <p className="mb-1 text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                          Recently resolved
                        </p>
                        {(showAllResolved ? resolvedAlerts : resolvedAlerts.slice(0, RESOLVED_SHOWN)).map((a) => (
                          <AlertRow key={a.id} alert={a} resolved />
                        ))}
                        {resolvedAlerts.length > RESOLVED_SHOWN && (
                          <button
                            type="button"
                            className="th-link-btn -ml-2 mt-1"
                            onClick={() => setShowAllResolved((v) => !v)}
                            aria-expanded={showAllResolved}
                          >
                            {showAllResolved ? "Show fewer" : `Show ${resolvedAlerts.length - RESOLVED_SHOWN} more`}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>
            {/* Services */}
            <section className="mb-3.5" aria-label="Services">
              <SectionHeader
                title="Services"
                meta={`${TERMS.remoteSupport} ${remoteSupportStatus(device).label.toLowerCase()}`}
              />
              <div className="th-svc-strip">
                {(() => {
                  const rs = remoteSupportStatus(device);
                  const tiles: {
                    label: string;
                    value: string;
                    tone: string;
                    /** Shown small beside the value. */
                    sub?: string;
                    /** Shown only as the tile's tooltip. */
                    hint?: string;
                    onClick?: () => void;
                  }[] = [
                    {
                      label: TERMS.remoteSupport,
                      value: rs.label,
                      tone: rs.tone,
                      sub: device.rustdesk_version ? `v${device.rustdesk_version}` : undefined,
                      onClick: () => setActiveTab("remote_support"),
                    },
                    {
                      label: "Updates",
                      value: "View software",
                      tone: TONE.neutral,
                      hint: "Patches and installed apps",
                      onClick: () => setActiveTab("software"),
                    },
                    {
                      label: "Maintenance",
                      value: device.is_in_maintenance ? "Active" : "Off",
                      tone: device.is_in_maintenance ? TONE.maintenance : TONE.neutral,
                      hint: "Details and controls at the end of Overview",
                      onClick: () => maintenanceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
                      sub:
                        device.is_in_maintenance && device.maintenance_ends_at
                          ? `until ${formatLocalDateTime(device.maintenance_ends_at)}`
                          : undefined,
                    },
                    {
                      label: "Lifecycle",
                      value: device.is_archived ? "Archived" : "Active",
                      tone: device.is_archived ? TONE.warning : TONE.online,
                      sub: device.duplicate_candidate ? "Possible duplicate" : undefined,
                    },
                  ];
                  return tiles.map((t) => {
                    const value = t.value.charAt(0).toUpperCase() + t.value.slice(1);
                    const title = [`${t.label}: ${value}`, t.sub, t.hint].filter(Boolean).join(" · ");
                    const body = (
                      <>
                        <span className="th-svc-tile-label">
                          {t.label}
                          {t.onClick && <ChevronRight aria-hidden="true" />}
                        </span>
                        <span className="th-svc-tile-value" style={{ "--tile-tone": t.tone } as React.CSSProperties}>
                          <i aria-hidden="true" />
                          {value}
                          {t.sub && <small>{t.sub}</small>}
                        </span>
                        {t.hint && <span className="sr-only">{t.hint}</span>}
                      </>
                    );
                    return t.onClick ? (
                      <button
                        key={t.label}
                        type="button"
                        onClick={t.onClick}
                        title={title}
                        className="th-drawer-tile th-svc-tile"
                      >
                        {body}
                      </button>
                    ) : (
                      <div key={t.label} title={title} className="th-drawer-tile th-svc-tile">
                        {body}
                      </div>
                    );
                  });
                })()}
              </div>
            </section>

            {isWindows && (
              <DeviceSecurityCard
                agentVersion={device.agent_version}
                inventory={inventory ?? null}
                loading={inventoryQuery.refreshing}
                error={inventoryQuery.error}
                onLoad={loadInventory}
              />
            )}

            <DeviceIdentityCard
              device={device}
              liveUser={streaming ? live.snapshot?.current_user : null}
              linux={platformFeatures.FEATURE_LINUX}
            />

            <DeviceAssignmentCard
              device={device}
              clients={clients}
              groups={groups}
              canAssignClient={canOperate}
              canAssignLocation={hasPermission("manage_clients")}
              canAssignGroup={canOperate}
              active={activeTab === "overview"}
              onDeviceUpdated={onDeviceUpdated}
            />

            {/* Rrjeti */}
            <section className="mb-3.5" aria-label="Network">
              <SectionHeader title="Network" meta={device.domain ? `Domain ${device.domain}` : undefined} />
              <div className="th-drawer-card !py-2.5">
                <dl className="th-kv">
                  <Kv label="Local IP" mono>
                    {device.local_ip}
                  </Kv>
                  <Kv label="Public IP" mono>
                    {device.public_ip}
                  </Kv>
                </dl>
              </div>
            </section>

            {/* Platform Components — Installed/Desired/Health + lifecycle metadata (read-only) */}
            <ComponentStatesPanel
              key={`components-${device.id}`}
              deviceId={device.id}
              actions={actionsData ?? undefined}
              onActionChange={noteActionChange}
              liveChannel={channelConnected}
            />
            {/* Mirembajtja */}
            <section className="mb-3.5" aria-label="Maintenance" ref={maintenanceRef}>
              <SectionHeader
                title="Maintenance"
                meta={
                  device.is_in_maintenance ? (
                    <span
                      className="th-status-chip !h-6"
                      style={{ "--chip-tone": TONE.maintenance } as React.CSSProperties}
                    >
                      <i />
                      Active
                    </span>
                  ) : (
                    "Off"
                  )
                }
              />
              <div className="th-drawer-card">
                {device.is_in_maintenance ? (
                  <div className="space-y-2.5">
                    <div className="flex items-start gap-2">
                      <Wrench className="mt-0.5 h-3.5 w-3.5 flex-none" style={{ color: TONE.maintenance }} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold" style={{ color: TONE.maintenance }}>
                          Device is in maintenance
                        </p>
                        {device.maintenance_note && (
                          <p className="mt-0.5 text-[11px] text-slate-400">{device.maintenance_note}</p>
                        )}
                      </div>
                    </div>
                    <dl className="th-kv">
                      {device.maintenance_started_by && <Kv label="Started by">{device.maintenance_started_by}</Kv>}
                      {device.maintenance_started_at && (
                        <Kv label="Started at">{formatLocalDateTime(device.maintenance_started_at)}</Kv>
                      )}
                      {device.maintenance_ends_at ? (
                        <Kv label="Ends at">{formatLocalDateTime(device.maintenance_ends_at)}</Kv>
                      ) : (
                        <Kv label="Duration">
                          <span className="th-kv-muted">Indefinite</span>
                        </Kv>
                      )}
                    </dl>
                    {hasPermission("maintenance_mode") && (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={maintenanceBusy}
                        onClick={async () => {
                          setMaintenanceBusy(true);
                          try {
                            const updated = await clearDeviceMaintenance(device.id);
                            onDeviceUpdated?.(updated);
                          } finally {
                            setMaintenanceBusy(false);
                          }
                        }}
                        className="mt-1 w-full"
                      >
                        Exit maintenance
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                        Pauses alerts for this device. Heartbeats and telemetry continue.
                      </p>
                      {canOperate && hasPermission("maintenance_mode") && !maintFormOpen && (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="flex-none"
                          onClick={() => setMaintFormOpen(true)}
                        >
                          <Wrench className="h-3.5 w-3.5" /> Start
                        </Button>
                      )}
                    </div>
                    {canOperate && hasPermission("maintenance_mode") && maintFormOpen && (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block">
                            <span className="premium-kicker mb-1 block">Duration (minutes)</span>
                            <input
                              type="number"
                              min={1}
                              placeholder="Leave blank for indefinite"
                              value={maintenanceForm.duration}
                              onChange={(e) => setMaintenanceForm((f) => ({ ...f, duration: e.target.value }))}
                              className="th-input h-9 w-full rounded-lg border px-3 text-[13px] outline-none placeholder-slate-600 transition focus:border-techi-orange/60"
                            />
                          </label>
                          <label className="block">
                            <span className="premium-kicker mb-1 block">Note (optional)</span>
                            <input
                              type="text"
                              placeholder="Reason..."
                              value={maintenanceForm.note}
                              onChange={(e) => setMaintenanceForm((f) => ({ ...f, note: e.target.value }))}
                              className="th-input h-9 w-full rounded-lg border px-3 text-[13px] outline-none placeholder-slate-600 transition focus:border-techi-orange/60"
                            />
                          </label>
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setMaintFormOpen(false)}
                            disabled={maintenanceBusy}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            disabled={maintenanceBusy}
                            onClick={async () => {
                              setMaintenanceBusy(true);
                              try {
                                const updated = await enterDeviceMaintenance(device.id, {
                                  duration_minutes: maintenanceForm.duration ? Number(maintenanceForm.duration) : null,
                                  note: maintenanceForm.note || null,
                                  started_by: user?.display_name ?? user?.username ?? "operator",
                                });
                                setMaintenanceForm({ duration: "", note: "" });
                                setMaintFormOpen(false);
                                onDeviceUpdated?.(updated);
                              } finally {
                                setMaintenanceBusy(false);
                              }
                            }}
                          >
                            <Wrench className="h-3.5 w-3.5" /> Enter maintenance
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </section>
          </div>

          <div className={activeTab === "monitoring" ? "th-tab-panel" : "hidden"}>
            <DeviceMonitoringPanel
              key={device.id}
              deviceId={device.id}
              active={isOpen && activeTab === "monitoring"}
              onShowAlerts={() => setActiveTab("overview")}
            />
          </div>

          {archiveConfirmOpen && (
            <ConfirmationModal
              title="Archive this duplicate?"
              confirmLabel="Archive device"
              destructive
              loading={archiveBusy}
              onClose={() => setArchiveConfirmOpen(false)}
              onConfirm={async () => {
                setArchiveBusy(true);
                try {
                  const updated = await archiveDevice(device.id);
                  onDeviceUpdated?.(updated);
                  setArchiveConfirmOpen(false);
                } catch {
                  // The modal stays open so the operator can retry.
                } finally {
                  setArchiveBusy(false);
                }
              }}
            >
              <span className="font-semibold">{deviceDisplayName(device)}</span> leaves the active fleet and stops
              raising alerts. It stays in history and can be restored from Archived devices.
            </ConfirmationModal>
          )}

          {noteToDelete !== null && (
            <ConfirmationModal
              title="Delete this note?"
              confirmLabel="Delete note"
              destructive
              loading={noteBusy}
              onClose={() => setNoteToDelete(null)}
              onConfirm={async () => {
                try {
                  await removeNote(noteToDelete);
                  setNoteToDelete(null);
                } catch {
                  // The modal stays open so the operator can retry.
                }
              }}
            >
              The note is removed for every operator. This cannot be undone.
            </ConfirmationModal>
          )}

          {/* Destructive action confirmation modal — rendered outside tab panels so it works from any tab */}
          {restartConfirmOpen && (
            <ConfirmationModal
              title={
                selectedActionType === "reinstall_rustdesk"
                  ? `Reinstall ${TERMS.remoteSupport}?`
                  : selectedActionType === "restart_agent"
                    ? `Restart the ${TERMS.agent}?`
                    : "Restart device?"
              }
              confirmLabel={
                selectedActionType === "reinstall_rustdesk"
                  ? "Confirm reinstall"
                  : selectedActionType === "restart_agent"
                    ? "Restart agent"
                    : "Restart device"
              }
              destructive={true}
              loading={actionBusy}
              onClose={() => setRestartConfirmOpen(false)}
              onConfirm={async () => {
                setRestartConfirmOpen(false);
                setActionBusy(true);
                setActionProblem(null);
                try {
                  const created = await queueDeviceAction(device.id, {
                    action_type: selectedActionType,
                    created_by: user?.username ?? "operator",
                  });
                  setActions((prev) => addQueuedAction(prev, created));
                } catch (err) {
                  reportActionError(selectedActionType, err);
                } finally {
                  setActionBusy(false);
                }
              }}
            >
              {selectedActionType === "reinstall_rustdesk" ? (
                <>
                  This will download and silently reinstall {TERMS.remoteSupport} on{" "}
                  <span className="font-semibold text-slate-200">{device.hostname}</span>. Remote access will be
                  interrupted during reinstall.
                </>
              ) : selectedActionType === "restart_agent" ? (
                <>
                  This will stop and restart the {TERMS.agent} (the <span className="font-mono">TechiAgent</span>{" "}
                  Windows service) on <span className="font-semibold text-slate-200">{device.hostname}</span>. The agent
                  will reconnect within ~15 seconds. Active actions will be re-queued on reconnect.
                </>
              ) : (
                <>
                  This will trigger an immediate OS-level restart on{" "}
                  <span className="font-semibold text-slate-200">{device.hostname}</span>. The device will go offline
                  and reconnect after boot. All unsaved work on the device will be lost.
                </>
              )}
            </ConfirmationModal>
          )}

          <div className={activeTab === "management" ? "th-tab-panel" : "hidden"}>
            {/* Veprimet remote */}
            <section className="mb-4">
              <div className="mb-2 flex items-center gap-2">
                <p className="premium-kicker">Remote actions</p>
                {actions.filter((a) => isActiveStatus(a.status)).length > 0 && (
                  <span
                    className="th-status-chip !h-6"
                    style={{ "--chip-tone": "var(--th-status-warning)" } as React.CSSProperties}
                  >
                    <i />
                    {actions.filter((a) => isActiveStatus(a.status)).length} in progress
                  </span>
                )}
                <button
                  type="button"
                  onClick={loadActions}
                  className="th-icon-btn th-icon-btn-ghost ml-auto !min-h-7 !min-w-7"
                  title="Refresh actions"
                  aria-label="Refresh actions"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </div>

              <div>
                {/* Paralajmerime */}
                {device.is_archived && (
                  <div className="th-drawer-callout mb-3 flex items-start gap-2 text-[13px]" data-tone="warning">
                    <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
                    <span>Device is archived. Actions will queue but may not be delivered.</span>
                  </div>
                )}
                {device.is_in_maintenance && (
                  <div className="th-drawer-callout mb-3 flex items-start gap-2 text-[13px]" data-tone="maint">
                    <Wrench className="mt-0.5 h-4 w-4 flex-none" />
                    <span>Device is in maintenance. Actions will still be queued.</span>
                  </div>
                )}
                {!device.is_archived &&
                  freshness === "offline" &&
                  (() => {
                    // Check if a restart action completed within the last 5 minutes
                    const RESTART_TYPES = new Set(["restart_device", "restart_agent"]);
                    const recentRestart = actions.find((a) => {
                      if (!RESTART_TYPES.has(a.action_type)) return false;
                      if (a.status !== "completed" && !isActiveStatus(a.status)) return false;
                      const ref = a.completed_at ?? a.sent_at ?? a.created_at;
                      return ref ? Date.now() - parseUTC(ref).getTime() < 5 * 60 * 1000 : false;
                    });
                    if (recentRestart) {
                      return (
                        <div className="th-drawer-callout mb-3 flex items-start gap-2 text-[13px]" data-tone="info">
                          <RefreshCw className="mt-0.5 h-4 w-4 flex-none animate-spin" />
                          <span>
                            {recentRestart.action_type === "restart_device"
                              ? "Device restart triggered — waiting for reconnect after boot."
                              : "Agent service restart triggered — reconnect expected within ~15 seconds."}
                          </span>
                        </div>
                      );
                    }
                    return (
                      <div className="th-drawer-callout mb-3 flex items-start gap-2 text-[13px]" data-tone="neutral">
                        <WifiOff className="mt-0.5 h-4 w-4 flex-none" />
                        <span>Device is offline. Action will queue and deliver on next heartbeat.</span>
                      </div>
                    );
                  })()}
                {freshness === "online" && !device.is_archived && (
                  <div className="th-drawer-callout mb-3 flex items-start gap-2 text-[13px]" data-tone="online">
                    <Wifi className="mt-0.5 h-4 w-4 flex-none" />
                    <span>
                      {channelConnected
                        ? "Device is connected live. Actions run within seconds."
                        : "Device is online. Action will be delivered on next heartbeat (within 5 minutes)."}
                    </span>
                  </div>
                )}

                {actionProblem && (
                  <div
                    className="th-drawer-callout mb-3 flex items-start gap-2 text-[13px]"
                    data-tone="warning"
                    role="alert"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
                    <span className="min-w-0 flex-1">{actionProblem.message}</span>
                    <span className="flex flex-none items-center gap-1.5">
                      {actionProblem.conflictId !== undefined && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={async () => {
                            const id = actionProblem.conflictId!;
                            try {
                              await cancelAction(id);
                              setActionProblem(null);
                              void loadActions();
                            } catch (err) {
                              setActionProblem({
                                message: `Could not cancel #${id}: ${err instanceof Error ? err.message : "try again"}.`,
                              });
                            }
                          }}
                        >
                          Cancel #{actionProblem.conflictId}
                        </Button>
                      )}
                      <button
                        type="button"
                        className="th-icon-btn th-icon-btn-ghost !min-h-7 !min-w-7"
                        aria-label="Dismiss"
                        onClick={() => setActionProblem(null)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                )}

                {canOperate ? (
                  (() => {
                    const runAction = async (type: ActionType) => {
                      if (DESTRUCTIVE_ACTIONS.has(type)) {
                        setSelectedActionType(type);
                        setRestartConfirmOpen(true);
                        return;
                      }
                      setActionBusy(true);
                      setActionProblem(null);
                      try {
                        const created = await queueDeviceAction(device.id, {
                          action_type: type,
                          created_by: user?.username ?? "operator",
                        });
                        setActions((prev) => addQueuedAction(prev, created));
                      } catch (err) {
                        // Nothing was queued, so nothing will arrive over the socket.
                        reportActionError(type, err);
                      } finally {
                        setActionBusy(false);
                      }
                    };
                    const Btn = ({
                      type,
                      label,
                      destructive = false,
                      perm,
                    }: {
                      type: ActionType;
                      label: string;
                      destructive?: boolean;
                      perm: string;
                    }) => {
                      const allowed = hasPermission(perm);
                      if (destructive && !allowed) return null;
                      if (!supported(type)) return null;
                      return (
                        <DrawerActionTile
                          type={type}
                          label={label}
                          destructive={destructive}
                          disabled={actionBusy || !allowed}
                          title={!allowed ? "Permission required" : undefined}
                          onClick={() => runAction(type)}
                        />
                      );
                    };
                    const Group = ({ label, children }: { label: string; children: React.ReactNode }) => (
                      <div className="mb-4">
                        <p className="th-menu-label !px-0 !pt-0">{label}</p>
                        <div className="grid grid-cols-2 gap-2">{children}</div>
                      </div>
                    );
                    return (
                      <div className="mb-2">
                        <Group label="Diagnostics">
                          <Btn type="ping" label="Ping" perm="diagnostics" />
                          <Btn type="immediate_heartbeat" label="Heartbeat" perm="diagnostics" />
                          <Btn type="refresh_inventory" label="Refresh inventory" perm="view_inventory" />
                          <Btn type="sync_inventory" label="Sync inventory" perm="view_inventory" />
                        </Group>
                        <Group label="Agent">
                          <Btn type="restart_agent" label="Restart agent" destructive perm="restart_agent" />
                          <Btn type="apply_power_policy" label="Power policy" perm="maintenance_mode" />
                        </Group>
                        <Group label="Remote Support">
                          <Btn type="restart_rustdesk" label="Restart service" perm="remote_support_manage" />
                          <Btn type="sync_rustdesk" label="Sync ID" perm="remote_support_manage" />
                          <Btn type="reopen_rustdesk" label="Reopen app" perm="remote_support_manage" />
                          <Btn type="repair_config_rustdesk" label="Repair config" perm="remote_support_manage" />
                        </Group>
                        <Group label="Device">
                          <Btn type="restart_device" label="Restart device" destructive perm="restart_device" />
                        </Group>
                      </div>
                    );
                  })()
                ) : (
                  <p className="th-drawer-callout mb-3 text-[13px]" data-tone="neutral">
                    Remote actions are read-only for this role.
                  </p>
                )}

                {/* History */}
                <div
                  className="mb-2 flex items-center justify-between gap-3 border-t pt-4"
                  style={{ borderColor: "var(--th-border-drawer-section)" }}
                >
                  <p className="text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                    History
                  </p>
                  <div className="th-segmented w-[260px]" role="radiogroup" aria-label="Filter actions">
                    {(["all", "active", "done", "failed"] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        role="radio"
                        aria-checked={actionFilter === f}
                        onClick={() => setActionFilter(f)}
                        className="capitalize"
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Lista e veprimeve */}
                {actionsLoading ? (
                  <p className="py-6 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                    Loading actions…
                  </p>
                ) : actions.length === 0 ? (
                  <p className="py-6 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                    No actions sent to this device yet.
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-72 overflow-y-auto">
                    {actions
                      .filter((a) => {
                        if (actionFilter === "active") return isActiveStatus(a.status);
                        if (actionFilter === "done") return a.status === "completed";
                        if (actionFilter === "failed")
                          return a.status === "failed" || a.status === "expired" || a.status === "cancelled";
                        return true;
                      })
                      .map((action) => (
                        <ActionRow
                          key={action.id}
                          action={action}
                          onCancel={
                            canOperate
                              ? async (id) => {
                                  try {
                                    const updated = await cancelAction(id);
                                    setActions((prev) => prev.map((a) => (a.id === id ? updated : a)));
                                  } catch {
                                    // ignore
                                  }
                                }
                              : undefined
                          }
                          onRetry={
                            canOperate
                              ? async (id) => {
                                  try {
                                    const created = await retryAction(id);
                                    setActions((prev) => addQueuedAction(prev, created));
                                  } catch {
                                    // ignore
                                  }
                                }
                              : undefined
                          }
                        />
                      ))}
                  </div>
                )}
              </div>
            </section>

            {showPowerShell && (
              <DevicePowerShellPanel
                key={device.id}
                deviceId={device.id}
                deviceName={displayName}
                clientName={device.client_name ?? device.resolved_client_name}
                currentUser={device.current_user}
                osCaption={device.os_caption}
                capable={powerShellCapable}
                active={isOpen && activeTab === "management"}
                offline={offline}
                kind={isLinux ? "linux" : "powershell"}
              />
            )}
          </div>

          <div className={activeTab === "software" ? "th-tab-panel" : "hidden"}>
            {/* Manual fetch control — see the inventory state above for why
              this is not automatic. */}
            <DeviceInventoryPanel
              key={device.id}
              inventory={inventory}
              loading={inventoryQuery.refreshing}
              error={inventoryQuery.error}
              onLoad={loadInventory}
            />
          </div>

          <div className={activeTab === "notes" ? "th-tab-panel" : "hidden"}>
            <section className="mb-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="premium-kicker">Notes</p>
                <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                  {notes.length} {notes.length === 1 ? "note" : "notes"}
                </span>
              </div>
              <div className="th-drawer-card">
                <textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  rows={3}
                  placeholder="Add an internal note..."
                  className="th-input w-full resize-none rounded-lg border px-3 py-2 text-[13px] leading-5 outline-none"
                />
                <div className="mt-2 flex justify-end">
                  <Button type="button" size="sm" disabled={noteBusy || !noteText.trim()} onClick={addNote}>
                    <Save className="h-3 w-3" />
                    Add note
                  </Button>
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {notesLoading ? (
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
                  notes.map((note) => (
                    <div
                      key={note.id}
                      className="rounded-lg p-3"
                      style={{
                        border: "1px solid var(--th-border-drawer-section)",
                        background: "var(--th-bg-drawer-section)",
                      }}
                    >
                      <div className="mb-1.5 flex items-center gap-2">
                        <span className="th-avatar !h-6 !w-6 !text-[11px]">
                          {(note.created_by || "A").charAt(0).toUpperCase()}
                        </span>
                        <span className="text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
                          {note.created_by || "admin"}
                        </span>
                        <time
                          dateTime={note.updated_at}
                          title={formatDateTime(note.updated_at)}
                          className="text-[12px]"
                          style={{ color: "var(--th-text-faint)" }}
                        >
                          {actionTimeAgo(note.updated_at)}
                        </time>
                        {canOperate && (
                          <div className="ml-auto flex items-center gap-1">
                            <button
                              type="button"
                              disabled={noteBusy}
                              onClick={() => {
                                setEditingNoteId(note.id);
                                setEditingText(note.note);
                              }}
                              className="th-icon-btn th-icon-btn-ghost !min-h-7 !min-w-7"
                              title="Edit note"
                              aria-label="Edit note"
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={noteBusy}
                              onClick={() => setNoteToDelete(note.id)}
                              className="th-icon-btn th-icon-btn-ghost !min-h-7 !min-w-7 hover:!text-[var(--th-status-critical)]"
                              title="Delete note"
                              aria-label="Delete note"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                      {canOperate && editingNoteId === note.id ? (
                        <div>
                          <textarea
                            value={editingText}
                            onChange={(e) => setEditingText(e.target.value)}
                            rows={3}
                            className="th-input w-full resize-none rounded-lg border px-3 py-2 text-[13px] leading-5 outline-none"
                          />
                          <div className="mt-2 flex justify-end gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setEditingNoteId(null);
                                setEditingText("");
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              disabled={noteBusy || !editingText.trim()}
                              onClick={() => saveNote(note.id)}
                            >
                              <Save className="h-3 w-3" />
                              Save
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <p
                          className="whitespace-pre-wrap pl-8 text-[13px] leading-5"
                          style={{ color: "var(--th-text-secondary)" }}
                        >
                          {note.note}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>

          <div className={activeTab === "timeline" ? "th-tab-panel" : "hidden"}>
            <section className="th-drawer-card">
              <ActivityTimeline events={events} loading={loading} onReload={reload} />
            </section>
          </div>

          {/* ── Terminal tab (Platform Expansion Phase 5) ── */}
          {hasTerminal && activeTab === "terminal" && (
            <div className="min-h-[340px]">
              <Suspense
                fallback={
                  <div className="p-4 text-xs" style={{ color: "var(--th-text-muted)" }}>
                    Loading terminal…
                  </div>
                }
              >
                <DeviceTerminal deviceId={device.id} />
              </Suspense>
            </div>
          )}

          {/* ── Remote Support tab ── */}
          <div className={activeTab === "remote_support" ? "th-tab-panel" : "hidden"}>
            {/* Credentials + service */}
            <section className="mb-5">
              <div className="mb-2 flex items-center justify-between">
                <p className="premium-kicker">Connection</p>
                <RsServiceBadge
                  status={rsDevice?.service_status ?? device.rustdesk_status}
                  installStatus={device.rustdesk_install_status}
                />
              </div>

              <div className="th-drawer-card">
                {/* Remote ID with copy */}
                <div className="mb-4 pb-4" style={{ borderBottom: "1px solid var(--th-border-drawer-section)" }}>
                  <p className="mb-1 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                    {TERMS.remoteSupportId}
                  </p>
                  <div className="flex items-center gap-2">
                    {device.rustdesk_id && isValidRustDeskId(device.rustdesk_id) ? (
                      <span
                        className="font-mono text-[22px] font-semibold tracking-wide"
                        style={{ color: "var(--th-text-primary)" }}
                      >
                        {device.rustdesk_id.replace(/(\d{3})(?=\d)/g, "$1 ")}
                      </span>
                    ) : (
                      <span className="text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                        {device.rustdesk_id || "Not assigned yet"}
                      </span>
                    )}
                    {device.rustdesk_id && (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(device.rustdesk_id!);
                            setRsCopySuccess(true);
                            setTimeout(() => setRsCopySuccess(false), 2000);
                          } catch {
                            // clipboard may be unavailable
                          }
                        }}
                        className="th-icon-btn th-icon-btn-ghost !min-h-8 !min-w-8"
                        title={`Copy ${TERMS.remoteSupportId}`}
                        aria-label={`Copy ${TERMS.remoteSupportId}`}
                      >
                        {rsCopySuccess ? (
                          <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <ClipboardCopy className="h-4 w-4" />
                        )}
                      </button>
                    )}
                  </div>
                  <RemoteSupportIdOrigin device={device} />
                </div>

                {/* Per-device Remote Support password — owner/admin only */}
                {can("admin") && (
                  <div className="mb-4 pb-4" style={{ borderBottom: "1px solid var(--th-border-drawer-section)" }}>
                    <p className="mb-1.5 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                      Password
                    </p>
                    {rsPassword === null ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={rsPasswordBusy}
                        onClick={async () => {
                          setRsPasswordBusy(true);
                          try {
                            const res = await getRemoteSupportPassword(device.id);
                            setRsPassword(res.password);
                            setRsPasswordSource(res.source ?? null);
                          } catch (e) {
                            setRsToast({
                              message: e instanceof Error ? e.message : "Failed to load password",
                              ok: false,
                            });
                          } finally {
                            setRsPasswordBusy(false);
                          }
                        }}
                      >
                        <span className="font-mono tracking-[0.2em]" style={{ color: "var(--th-text-faint)" }}>
                          ••••••••
                        </span>
                        {rsPasswordBusy ? "Loading…" : "Reveal"}
                      </Button>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span
                            className="font-mono text-[15px] font-semibold"
                            style={{ color: "var(--th-text-primary)" }}
                          >
                            {rsPassword}
                          </span>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(rsPassword);
                                setRsToast({ message: "Password copied", ok: true });
                                setTimeout(() => setRsToast(null), 2000);
                              } catch {
                                setRsToast({ message: "Copy failed", ok: false });
                              }
                            }}
                            className="th-icon-btn th-icon-btn-ghost !min-h-8 !min-w-8"
                            title="Copy password"
                            aria-label="Copy password"
                          >
                            <ClipboardCopy className="h-3.5 w-3.5" />
                          </button>
                          {rsPasswordSource && <span className="th-role-chip">{rsPasswordSource}</span>}
                        </div>
                        {hasPermission("remote_support_manage") && (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={rsPasswordBusy}
                              onClick={async () => {
                                setRsPasswordBusy(true);
                                try {
                                  const res = await regenerateRemoteSupportPassword(device.id);
                                  setRsPassword(res.password);
                                  setRsPasswordSource("generated");
                                  setRsToast({ message: "New password — applied on next heartbeat", ok: true });
                                  setTimeout(() => setRsToast(null), 3000);
                                } catch (e) {
                                  setRsToast({
                                    message: e instanceof Error ? e.message : "Regenerate failed",
                                    ok: false,
                                  });
                                } finally {
                                  setRsPasswordBusy(false);
                                }
                              }}
                            >
                              Regenerate
                            </Button>
                            <input
                              type="text"
                              placeholder="Custom password (min 8)"
                              aria-label="Custom password"
                              value={rsCustomPassword}
                              onChange={(e) => setRsCustomPassword(e.target.value)}
                              className="th-input h-8 min-w-0 flex-1 rounded-lg border px-2.5 text-[13px] outline-none"
                            />
                            <Button
                              type="button"
                              size="sm"
                              disabled={rsPasswordBusy || rsCustomPassword.trim().length < 8}
                              onClick={async () => {
                                setRsPasswordBusy(true);
                                try {
                                  const res = await setRemoteSupportPassword(device.id, rsCustomPassword.trim());
                                  setRsPassword(res.password);
                                  setRsPasswordSource("custom");
                                  setRsCustomPassword("");
                                  setRsToast({ message: "Custom password set — applied on next heartbeat", ok: true });
                                  setTimeout(() => setRsToast(null), 3000);
                                } catch (e) {
                                  setRsToast({ message: e instanceof Error ? e.message : "Set failed", ok: false });
                                } finally {
                                  setRsPasswordBusy(false);
                                }
                              }}
                            >
                              Set
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Details */}
                <dl className="th-dl">
                  <dt>Version</dt>
                  <dd className="font-mono">{device.rustdesk_version ? `v${device.rustdesk_version}` : "—"}</dd>
                  <dt>ID sync</dt>
                  <dd>
                    <span className={syncColor}>{syncLabel ? humanize(syncLabel) : "Unknown"}</span>
                    {device.rustdesk_sync_message && (
                      <span className="block text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                        {device.rustdesk_sync_message}
                      </span>
                    )}
                  </dd>
                  <dt>Configuration</dt>
                  <dd>
                    {device.rustdesk_install_status === "not_installed" ? (
                      <span style={{ color: "var(--th-text-muted)" }}>Not installed</span>
                    ) : device.rustdesk_sync_state === "synced" ? (
                      <span className="text-emerald-400">Synced</span>
                    ) : device.rustdesk_sync_state === "degraded" ? (
                      <span className="text-amber-400">Degraded</span>
                    ) : device.rustdesk_sync_state === "failed" ? (
                      <span className="text-red-400">Failed</span>
                    ) : (
                      <span style={{ color: "var(--th-text-muted)" }}>
                        {device.rustdesk_sync_state ? humanize(device.rustdesk_sync_state) : "Not synced"}
                      </span>
                    )}
                  </dd>
                  <dt>Last heartbeat</dt>
                  <dd>
                    {device.last_seen ? (
                      formatLocalDateTime(device.last_seen)
                    ) : (
                      <span style={{ color: "var(--th-text-muted)" }}>Never</span>
                    )}
                  </dd>
                  {rsDevice != null && (
                    <>
                      <dt>Repairs</dt>
                      <dd className="tabular-nums">{rsDevice.repair_count ?? 0}</dd>
                    </>
                  )}
                  {rsDevice?.install_path && (
                    <>
                      <dt>Install path</dt>
                      <dd className="break-all font-mono text-[12px]" style={{ color: "var(--th-text-secondary)" }}>
                        {rsDevice.install_path}
                      </dd>
                    </>
                  )}
                </dl>

                {!isValidRustDeskId(device.rustdesk_id) && (
                  <p className="mt-3 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                    {TERMS.remoteSupportId} not resolved yet. Connect is disabled until a valid ID is confirmed.
                  </p>
                )}
              </div>
            </section>

            {/* Management actions */}
            {canOperate &&
              (hasPermission("remote_support_manage") ||
                hasPermission("reinstall_remote_support") ||
                hasPermission("deployment")) && (
                <section className="mb-5">
                  <p className="premium-kicker mb-2">Actions</p>
                  <div>
                    {/* Deploy prompt when not installed */}
                    {(device.rustdesk_install_status === "not_installed" || !device.rustdesk_id) &&
                      hasPermission("deployment") && (
                        <div className="mb-3">
                          <p className="mb-2 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                            {TERMS.remoteSupport} does not appear to be installed on this device. Sync asks the{" "}
                            {TERMS.agent} to check again and report its ID.
                          </p>
                          <Button
                            type="button"
                            className="w-full"
                            disabled={rsBusyAction === "deploy"}
                            onClick={async () => {
                              setRsBusyAction("deploy");
                              try {
                                const created = await queueDeviceAction(device.id, {
                                  action_type: "sync_rustdesk",
                                  created_by: user?.username ?? "operator",
                                });
                                setActions((prev) => addQueuedAction(prev, created));
                                setRsToast({ message: "Sync queued", ok: true });
                                setTimeout(() => setRsToast(null), 3000);
                              } catch (e: unknown) {
                                setRsToast({ message: e instanceof Error ? e.message : "Sync failed", ok: false });
                                setTimeout(() => setRsToast(null), 3000);
                              } finally {
                                setRsBusyAction(null);
                              }
                            }}
                          >
                            {rsBusyAction === "deploy" ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
                            Sync {TERMS.remoteSupport}
                          </Button>
                        </div>
                      )}

                    <div className="grid grid-cols-2 gap-2">
                      {/* Sync */}
                      {hasPermission("remote_support_manage") && (
                        <DrawerActionTile
                          type="sync_rustdesk"
                          label="Sync ID"
                          busy={rsBusyAction === "sync_rustdesk"}
                          onClick={async () => {
                            setRsBusyAction("sync_rustdesk");
                            try {
                              const created = await queueDeviceAction(device.id, {
                                action_type: "sync_rustdesk",
                                created_by: user?.username ?? "operator",
                              });
                              setActions((prev) => addQueuedAction(prev, created));
                              setRsToast({ message: "Sync queued", ok: true });
                              setTimeout(() => setRsToast(null), 3000);
                            } catch (e: unknown) {
                              setRsToast({ message: e instanceof Error ? e.message : "Sync failed", ok: false });
                              setTimeout(() => setRsToast(null), 3000);
                            } finally {
                              setRsBusyAction(null);
                            }
                          }}
                        />
                      )}
                      {/* Restart */}
                      {hasPermission("remote_support_manage") && (
                        <DrawerActionTile
                          type="restart_rustdesk"
                          label="Restart service"
                          busy={rsBusyAction === "restart_rustdesk"}
                          onClick={async () => {
                            setRsBusyAction("restart_rustdesk");
                            try {
                              const created = await queueDeviceAction(device.id, {
                                action_type: "restart_rustdesk",
                                created_by: user?.username ?? "operator",
                              });
                              setActions((prev) => addQueuedAction(prev, created));
                              setRsToast({ message: "Restart queued", ok: true });
                              setTimeout(() => setRsToast(null), 3000);
                            } catch (e: unknown) {
                              setRsToast({ message: e instanceof Error ? e.message : "Restart failed", ok: false });
                              setTimeout(() => setRsToast(null), 3000);
                            } finally {
                              setRsBusyAction(null);
                            }
                          }}
                        />
                      )}
                      {/* Reopen */}
                      {hasPermission("remote_support_manage") && supported("reopen_rustdesk") && (
                        <DrawerActionTile
                          type="reopen_rustdesk"
                          label="Reopen app"
                          busy={rsBusyAction === "reopen_rustdesk"}
                          onClick={async () => {
                            setRsBusyAction("reopen_rustdesk");
                            try {
                              const created = await queueDeviceAction(device.id, {
                                action_type: "reopen_rustdesk",
                                created_by: user?.username ?? "operator",
                              });
                              setActions((prev) => addQueuedAction(prev, created));
                              setRsToast({ message: "Reopen queued", ok: true });
                              setTimeout(() => setRsToast(null), 3000);
                            } catch (e: unknown) {
                              setRsToast({ message: e instanceof Error ? e.message : "Reopen failed", ok: false });
                              setTimeout(() => setRsToast(null), 3000);
                            } finally {
                              setRsBusyAction(null);
                            }
                          }}
                        />
                      )}
                      {/* Reinstall — destructive, triggers existing confirmation modal */}
                      {hasPermission("reinstall_remote_support") && !isLinux && (
                        <DrawerActionTile
                          type="reinstall_rustdesk"
                          label="Reinstall"
                          destructive
                          busy={rsBusyAction === "reinstall_rustdesk"}
                          onClick={() => {
                            setSelectedActionType("reinstall_rustdesk");
                            setRestartConfirmOpen(true);
                          }}
                        />
                      )}
                    </div>
                  </div>
                </section>
              )}

            {rsLoading && <p className="text-center text-xs text-slate-500">Loading {TERMS.remoteSupport} details…</p>}
          </div>
        </div>
      </div>
    </>
  );
}

const ACTION_META: Partial<Record<ActionType, { icon: typeof Activity; hint: string }>> = {
  ping: { icon: Activity, hint: "Check the agent responds" },
  immediate_heartbeat: { icon: HeartPulse, hint: "Request a fresh heartbeat now" },
  refresh_inventory: { icon: RefreshCw, hint: "Collect hardware and software" },
  sync_inventory: { icon: UploadCloud, hint: "Send inventory to the server" },
  restart_agent: { icon: RotateCcw, hint: "Restart the TECHI agent service" },
  apply_power_policy: { icon: Zap, hint: "Keep the PC awake for support" },
  restart_rustdesk: { icon: RotateCcw, hint: "Restart the background service" },
  sync_rustdesk: { icon: Fingerprint, hint: "Re-check and repair the ID" },
  reopen_rustdesk: { icon: AppWindow, hint: "Reopen the Remote Support app" },
  repair_config_rustdesk: { icon: Wrench, hint: "Rewrite the server configuration" },
  restart_device: { icon: Power, hint: "Reboot the device now" },
  reinstall_rustdesk: { icon: Download, hint: "Remove and install again" },
};

function DrawerActionTile({
  type,
  label,
  destructive = false,
  disabled = false,
  busy = false,
  title,
  onClick,
}: {
  type: ActionType;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  onClick: () => void;
}) {
  const meta = ACTION_META[type];
  const Icon = meta?.icon ?? Activity;
  return (
    <button
      type="button"
      className="th-action-tile"
      data-destructive={destructive}
      disabled={disabled || busy}
      title={title}
      onClick={onClick}
    >
      <span className="th-action-icon">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-medium">{label}</span>
        {meta?.hint && (
          <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
            {meta.hint}
          </span>
        )}
      </span>
    </button>
  );
}

function actionTimeAgo(iso?: string | null): string {
  return iso ? timeAgo(iso) : "";
}

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function ActionRow({
  action,
  onCancel,
  onRetry,
}: {
  action: RemoteAction;
  onCancel?: (id: number) => void;
  onRetry?: (id: number) => void;
}) {
  const label = actionTypeLabel(action.action_type);
  const statusLabel = ACTION_STATUS_LABELS[action.status] ?? action.status;
  const canCancel = Boolean(onCancel) && isActiveStatus(action.status);
  const canRetry = Boolean(onRetry) && isTerminalStatus(action.status);
  const isRunning = action.status === "running";
  // An agent update under way shows its stage and progress; its
  // result_message is that progress detail until it ends.
  const liveUpdate = isActiveUpdate(action);
  const relevantTime =
    action.completed_at ??
    action.failed_at ??
    action.cancelled_at ??
    action.expired_at ??
    action.acknowledged_at ??
    action.sent_at ??
    action.queued_at ??
    action.created_at;

  return (
    <div
      className="flex items-start gap-3 rounded-lg px-3 py-2.5 text-[13px]"
      style={{ background: "var(--th-bg-drawer-section)", border: "1px solid var(--th-border-drawer-section)" }}
    >
      {isRunning ? (
        <Loader2 className="mt-0.5 h-3.5 w-3.5 flex-none animate-spin text-sky-400" />
      ) : (
        <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${statusDotColor(action.status)}`} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-medium" style={{ color: "var(--th-text-primary)" }}>
            {label}
          </span>
          <span className={`text-[12px] font-medium ${statusColor(action.status)}`}>{statusLabel}</span>
          {action.duration_seconds != null && (
            <span className="text-[11px] text-slate-500">{formatDuration(action.duration_seconds)}</span>
          )}
          <time
            dateTime={relevantTime ?? undefined}
            title={relevantTime ? formatDateTime(relevantTime) : undefined}
            className="ml-auto flex-none text-[12px] tabular-nums"
            style={{ color: "var(--th-text-faint)" }}
          >
            {actionTimeAgo(relevantTime)}
          </time>
        </div>
        {action.created_by && (
          <p className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
            by {action.created_by}
          </p>
        )}
        {liveUpdate && <AgentUpdateCompact action={action} toVersion={updateTargetVersion(action)} />}
        {action.result_message && !liveUpdate && (
          <p className="mt-0.5 text-[11px] text-emerald-400">{action.result_message}</p>
        )}
        {action.error_message && <p className="mt-0.5 text-[11px] text-red-400">{action.error_message}</p>}
        {action.output && action.output !== action.result_message && (
          <pre
            className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap break-words rounded px-2 py-1 text-[11px] font-mono leading-4 text-slate-400"
            style={{ background: "var(--th-chip-bg)" }}
          >
            {action.output}
          </pre>
        )}
        {action.stderr_output && (
          <pre
            className="mt-1 max-h-16 overflow-y-auto whitespace-pre-wrap break-words rounded px-2 py-1 text-[11px] font-mono leading-4 text-red-300"
            style={{ background: "color-mix(in srgb, var(--th-status-critical) 8%, transparent)" }}
          >
            {action.stderr_output}
          </pre>
        )}
        {(canCancel || canRetry) && (
          <div className="-ml-2 mt-1 flex items-center gap-1">
            {canCancel && (
              <button type="button" onClick={() => onCancel?.(action.id)} className="th-link-btn">
                Cancel
              </button>
            )}
            {canRetry && (
              <button type="button" onClick={() => onRetry?.(action.id)} className="th-link-btn gap-1">
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Remote Support tab helpers ────────────────────────────────────────────

function RsServiceBadge({ status, installStatus }: { status?: string | null; installStatus?: string | null }) {
  const view = remoteSupportStatus({ rustdesk_status: status, rustdesk_install_status: installStatus });
  return (
    <span className="th-status-chip !h-6" style={{ "--chip-tone": view.tone } as React.CSSProperties}>
      <i />
      {view.label}
    </span>
  );
}
