import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle, ClipboardCopy, Edit3, ExternalLink, Loader2, Monitor, PlayCircle, RefreshCw, RotateCcw, Save, Star, Trash2, Wifi, WifiOff, Wrench, X } from "lucide-react";
import { getRemoteSupportDevice, RemoteSupportDevice } from "../api/remoteSupport";
import { Client, DeviceGroup } from "../api/clients";
import { archiveDevice, assignDeviceClient, assignDeviceGroup, clearDeviceMaintenance, Device, DeviceOfflineAnalysis, enterDeviceMaintenance, getDeviceOfflineAnalysis } from "../api/devices";
import { parseUTC, timeAgo } from "../utils/time";
import { isValidRustDeskId, launchRustDesk } from "../services/rustdeskLaunch";
import {
  ACTION_LABELS,
  ACTION_STATUS_LABELS,
  ActionStatus,
  ActionType,
  cancelAction,
  DESTRUCTIVE_ACTIONS,
  getDeviceActions,
  isActiveStatus,
  isTerminalStatus,
  queueDeviceAction,
  RemoteAction,
  retryAction,
  statusColor,
  statusDotColor,
} from "../api/actions";
import { useAuth } from "../auth/AuthContext";
import { DeviceInventory, getDeviceInventory } from "../api/inventory";
import { createDeviceNote, deleteDeviceNote, DeviceNote, getDeviceNotes, updateDeviceNote } from "../api/notes";
import { DeviceRealtimeEvent, DeviceRealtimeStatus } from "../services/deviceRealtime";
import { useDeviceActivity } from "../hooks/useDeviceActivity";
import { useDeviceAlerts } from "../hooks/useDeviceAlerts";
import { useDeviceTelemetry } from "../hooks/useDeviceTelemetry";
import { Alert, AlertSeverity } from "../types/alert";
import ActivityTimeline from "./ActivityTimeline";
import ConfirmationModal from "./ConfirmationModal";
import HealthBadge from "./HealthBadge";
import ResourceBar from "./ResourceBar";

interface DeviceDrawerProps {
  device: Device;
  isOpen: boolean;
  onClose: () => void;
  wsStatus?: DeviceRealtimeStatus;
  latestEvent?: DeviceRealtimeEvent | null;
  clients?: Client[];
  groups?: DeviceGroup[];
  onDeviceUpdated?: (device: Device) => void;
  canOperate?: boolean;
  isFavorite?: boolean;
  onToggleFavorite?: (deviceId: number) => void;
}

type DrawerTab = "overview" | "remote_support" | "management" | "notes" | "timeline";

const drawerTabs: Array<{ id: DrawerTab; label: string }> = [
  { id: "overview",       label: "Overview" },
  { id: "remote_support", label: "Remote Support" },
  { id: "management",     label: "Management" },
  { id: "notes",          label: "Notes" },
  { id: "timeline",       label: "Timeline" },
];

function DetailRow({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <p className="premium-kicker mb-1">{label}</p>
      <p className={`text-xs font-medium leading-5 ${mono ? "font-mono" : ""} ${value ? "text-slate-100" : "text-slate-500"}`}>
        {value || "—"}
      </p>
    </div>
  );
}

function AssignmentSourceBadge({ source }: { source?: string | null }) {
  const normalized = (source || "unassigned").toLowerCase();
  const label =
    normalized === "manual" || normalized === "legacy_manual" ? "manual" :
    normalized === "trusted_domain" ? "domain" :
    normalized === "enrollment_token" ? "token" :
    normalized === "auto_os" || normalized === "system_auto" ? "auto" :
    "unassigned";
  return (
    <span className="inline-flex w-fit items-center rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-semibold text-slate-300">
      {label}
    </span>
  );
}

function HeartbeatFreshness({ lastSeen }: { lastSeen?: string }) {
  if (!lastSeen) return <span className="text-xs font-medium text-slate-500">Never</span>;
  const diffSec = (Date.now() - parseUTC(lastSeen).getTime()) / 1000;
  let label: string;
  let cls: string;
  if (diffSec < 90) { label = "Fresh"; cls = "text-emerald-400"; }
  else if (diffSec < 300) { label = `${Math.floor(diffSec / 60)}m ago`; cls = "text-emerald-300"; }
  else if (diffSec < 900) { label = `${Math.floor(diffSec / 60)}m ago`; cls = "text-amber-400"; }
  else { label = `${Math.floor(diffSec / 3600)}h ago`; cls = "text-red-400"; }
  return <span className={`text-xs font-semibold ${cls}`}>{label}</span>;
}

function WsIndicator({ status }: { status?: DeviceRealtimeStatus }) {
  if (status === "connected") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.7)]" />
        Live
      </div>
    );
  }
  if (status === "connecting") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Connecting
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-slate-500">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
      Polling
    </div>
  );
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function alertSeverityColor(severity: AlertSeverity): string {
  if (severity === "critical") return "text-red-400";
  if (severity === "warning") return "text-amber-400";
  return "text-slate-400";
}

function alertSeverityDot(severity: AlertSeverity): string {
  if (severity === "critical") return "bg-red-400";
  if (severity === "warning") return "bg-amber-400";
  return "bg-slate-500";
}

function alertTimeAgo(iso: string): string {
  return timeAgo(iso);
}

function patchStateLabel(state?: string): string {
  if (state === "up_to_date") return "Up to date";
  if (state === "updates_available") return "Updates available";
  if (state === "reboot_required") return "Reboot required";
  return "Unknown";
}

function patchStateClass(state?: string): string {
  if (state === "up_to_date") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-300";
  if (state === "reboot_required") return "border-red-400/30 bg-red-400/10 text-red-300";
  return "border-amber-400/30 bg-amber-400/10 text-amber-200";
}

function AlertRow({ alert, resolved = false }: { alert: Alert; resolved?: boolean }) {
  return (
    <div className={`flex items-start gap-2 py-2 ${resolved ? "opacity-65" : ""}`}>
      <span className={`mt-1 h-1.5 w-1.5 flex-none rounded-full ${alertSeverityDot(alert.severity)}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-semibold uppercase tracking-wide ${alertSeverityColor(alert.severity)}`}>
            {alert.severity}
          </span>
          {resolved && <span className="text-[10px] text-slate-500">resolved</span>}
          <span className="ml-auto flex-none text-[10px] text-slate-500">{alertTimeAgo(alert.created_at)}</span>
        </div>
        <p className="text-xs leading-5 text-slate-200">{alert.message}</p>
      </div>
    </div>
  );
}

const OFFLINE_REASON_LABELS: Record<string, string> = {
  site_outage:             "Site outage suspected",
  network_lost:            "Network issue likely",
  agent_stopped:           "Agent stopped",
  remote_support_stopped:  "Remote Support stopped",
  stale_heartbeat:         "Stale heartbeat",
  possibly_power_off:      "Possibly powered off",
  unknown:                 "Unknown",
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high:   "text-emerald-300 bg-emerald-400/10 border-emerald-400/25",
  medium: "text-amber-300 bg-amber-400/10 border-amber-400/25",
  low:    "text-slate-400 bg-white/[0.05] border-white/10",
};

export default function DeviceDrawer({
  device,
  isOpen,
  onClose,
  wsStatus,
  latestEvent,
  clients = [],
  groups = [],
  onDeviceUpdated,
  canOperate = false,
  isFavorite = false,
  onToggleFavorite,
}: DeviceDrawerProps) {
  const { user } = useAuth();

  const [maintenanceForm, setMaintenanceForm] = useState<{ duration: string; note: string }>({ duration: "", note: "" });
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);

  const [actions, setActions] = useState<RemoteAction[]>([]);
  const [actionsLoading, setActionsLoading] = useState(false);
  const [selectedActionType, setSelectedActionType] = useState<ActionType>("ping");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionFilter, setActionFilter] = useState<"all" | "active" | "done" | "failed">("all");
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const actionLoadedFor = useRef<number | null>(null);

  const [inventory, setInventory] = useState<DeviceInventory | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [processSearch, setProcessSearch] = useState("");
  const [serviceSearch, setServiceSearch] = useState("");
  const [softwareSearch, setSoftwareSearch] = useState("");
  const inventoryLoadedFor = useRef<number | null>(null);
  const [activeTab, setActiveTab] = useState<DrawerTab>("overview");
  const [notes, setNotes] = useState<DeviceNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const notesLoadedFor = useRef<number | null>(null);

  // Remote Support tab state
  const [rsDevice, setRsDevice] = useState<RemoteSupportDevice | null>(null);
  const [rsLoading, setRsLoading] = useState(false);
  const [rsBusyAction, setRsBusyAction] = useState<string | null>(null);
  const [rsToast, setRsToast] = useState<{ message: string; ok: boolean } | null>(null);
  const [rsCopySuccess, setRsCopySuccess] = useState(false);
  const rsLoadedFor = useRef<number | null>(null);

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
    setActiveTab("overview");
  }, [device.id]);

  const loadActions = useCallback(async () => {
    setActionsLoading(true);
    try {
      const data = await getDeviceActions(device.id);
      setActions(data);
    } catch {
      // non-critical
    } finally {
      setActionsLoading(false);
    }
  }, [device.id]);

  useEffect(() => {
    if (!isOpen) return;
    if (actionLoadedFor.current !== device.id) {
      actionLoadedFor.current = device.id;
      void loadActions();
    }
  }, [isOpen, device.id, loadActions]);

  const loadInventory = useCallback(async () => {
    setInventoryLoading(true);
    try {
      const data = await getDeviceInventory(device.id);
      setInventory(data);
    } catch {
      // non-critical
    } finally {
      setInventoryLoading(false);
    }
  }, [device.id]);

  useEffect(() => {
    if (!isOpen) return;
    if (inventoryLoadedFor.current !== device.id) {
      inventoryLoadedFor.current = device.id;
      void loadInventory();
    }
  }, [isOpen, device.id, loadInventory]);

  const loadNotes = useCallback(async () => {
    setNotesLoading(true);
    try {
      const data = await getDeviceNotes(device.id);
      setNotes(data);
    } catch {
      setNotes([]);
    } finally {
      setNotesLoading(false);
    }
  }, [device.id]);

  useEffect(() => {
    if (!isOpen || activeTab !== "notes") return;
    if (notesLoadedFor.current !== device.id) {
      notesLoadedFor.current = device.id;
      void loadNotes();
    }
  }, [isOpen, activeTab, device.id, loadNotes]);

  useEffect(() => {
    setNoteText("");
    setEditingNoteId(null);
    setEditingText("");
    notesLoadedFor.current = null;
  }, [device.id]);

  // Remote Support data loading
  const loadRsDevice = useCallback(async () => {
    setRsLoading(true);
    try {
      const data = await getRemoteSupportDevice(device.id);
      setRsDevice(data);
    } catch {
      // non-critical — device may not have RS data yet
    } finally {
      setRsLoading(false);
    }
  }, [device.id]);

  useEffect(() => {
    if (!isOpen || activeTab !== "remote_support") return;
    if (rsLoadedFor.current !== device.id) {
      rsLoadedFor.current = device.id;
      void loadRsDevice();
    }
  }, [isOpen, activeTab, device.id, loadRsDevice]);

  useEffect(() => {
    rsLoadedFor.current = null;
    setRsDevice(null);
    setRsCopySuccess(false);
    setRsToast(null);
    setRsBusyAction(null);
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
      .catch(() => { /* non-critical */ });
  }, [isOpen, activeTab, device.id]);

  // Merge realtime action events without a full reload.
  useEffect(() => {
    if (!latestEvent) return;
    const { type, data } = latestEvent;
    if (type !== "action_queued" && type !== "action_status_changed") return;
    const ev = data as Record<string, unknown>;
    if (ev?.device_id !== device.id) return;

    const patch = ev as unknown as RemoteAction;
    if (!patch?.id) return;

    setActions((prev) => {
      const idx = prev.findIndex((a) => a.id === patch.id);
      if (idx === -1) {
        // New action queued from another session — prepend it.
        return [patch, ...prev];
      }
      const updated = [...prev];
      updated[idx] = { ...updated[idx], ...patch };
      return updated;
    });
  }, [latestEvent, device.id]);

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
  }, [activeTab, device.id, noteText, reload]);

  const saveNote = useCallback(async (noteId: number) => {
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
  }, [activeTab, device.id, editingText, reload]);

  // Auto-save when editing an existing note (1.5s debounce)
  useEffect(() => {
    if (!editingNoteId || !editingText.trim()) return;
    const t = window.setTimeout(() => { void saveNote(editingNoteId); }, 1500);
    return () => window.clearTimeout(t);
  }, [editingText]); // eslint-disable-line react-hooks/exhaustive-deps

  const removeNote = useCallback(async (noteId: number) => {
    setNoteBusy(true);
    try {
      await deleteDeviceNote(device.id, noteId);
      setNotes((prev) => prev.filter((item) => item.id !== noteId));
      if (activeTab === "timeline") void reload();
    } finally {
      setNoteBusy(false);
    }
  }, [activeTab, device.id, reload]);

  const filteredProcesses = useMemo(() => {
    const all = inventory?.processes ?? [];
    if (!processSearch.trim()) return all;
    const q = processSearch.toLowerCase();
    return all.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid).includes(q));
  }, [inventory, processSearch]);

  const filteredServices = useMemo(() => {
    const all = inventory?.services ?? [];
    if (!serviceSearch.trim()) return all;
    const q = serviceSearch.toLowerCase();
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.display_name.toLowerCase().includes(q) ||
        s.status.toLowerCase().includes(q)
    );
  }, [inventory, serviceSearch]);

  const filteredSoftware = useMemo(() => {
    const all = inventory?.software ?? [];
    if (!softwareSearch.trim()) return all;
    const q = softwareSearch.toLowerCase();
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.version ?? "").toLowerCase().includes(q) ||
        (s.publisher ?? "").toLowerCase().includes(q)
    );
  }, [inventory, softwareSearch]);

  const isOnline = device.status === "online";
  const assignmentClientId = device.client_id ?? device.resolved_client_id ?? null;
  const availableGroups = groups.filter((group) => group.client_id === assignmentClientId);

  const syncColor =
    device.rustdesk_conflict_detected
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
  const hasInventoryDetails =
    Boolean(inventory && (inventory.processes.length > 0 || inventory.services.length > 0 || (inventory.software ?? []).length > 0));
  const visibleDrawerTabs = drawerTabs;



  return (
    <>
	      {/* Shtresa mbyllese */}
	      <div
        className={`fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] transition-opacity duration-300 ${
          isOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
      />

      {/* Paneli */}
      <div
        className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-[480px] flex-col shadow-2xl transition-transform duration-300 ease-out ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
        style={{
          borderLeft: "1px solid var(--th-border-drawer)",
          background: "var(--th-bg-drawer)",
        }}
      >
        {/* Koka */}
        <div
          className="flex flex-none items-start justify-between px-5 pb-3 pt-4"
          style={{ borderBottom: "1px solid var(--th-border-drawer-section)" }}
        >
          <div className="min-w-0 flex-1">
            {/* Row 1 — status dot + hostname + type badge */}
            <div className="flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 flex-none rounded-full ${
                  isOnline ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" : "bg-slate-600"
                }`}
              />
              <h2 className="truncate text-sm font-bold text-white">
                {device.hostname || "Unknown host"}
              </h2>
              {device.device_type === "server" ? (
                <span className="flex-none rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide"
                  style={{ color: "#a78bfa", background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.22)" }}>
                  Server
                </span>
              ) : device.device_type === "client" ? (
                <span className="flex-none rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide"
                  style={{ color: "#60a5fa", background: "rgba(96,165,250,0.1)", border: "1px solid rgba(96,165,250,0.2)" }}>
                  WS
                </span>
              ) : (
                <span className="flex-none rounded border border-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400"
                  style={{ background: "rgba(255,255,255,0.04)" }}>
                  {device.device_type}
                </span>
              )}
            </div>
            {/* Row 2 — contextual meta */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
              {(device.resolved_client_name || device.client_name) && (
                <span className="text-[10px] font-semibold" style={{ color: "#fb923c" }}>
                  {device.resolved_client_name || device.client_name}
                </span>
              )}
              {(device.resolved_group || device.group_name) && (
                <span className="text-[10px] font-medium text-slate-400">
                  {device.resolved_group || device.group_name}
                </span>
              )}
              {device.current_user && (
                <span className="text-[10px] font-medium text-slate-400">
                  <span className="text-slate-600">user </span>{device.current_user}
                </span>
              )}
              {device.os_name && (
                <span className="max-w-[130px] truncate text-[10px] font-medium text-slate-500" title={device.os_name}>
                  {device.os_name}
                </span>
              )}
              {device.domain && (
                <span className="text-[10px] font-medium text-slate-500">{device.domain}</span>
              )}
            </div>
            <p className="mt-1 text-[10px] font-medium text-slate-600">Device #{device.id}</p>
          </div>
          <div className="ml-3 flex flex-none items-center gap-3">
            <WsIndicator status={wsStatus} />
            {onToggleFavorite && (
              <button
                type="button"
                onClick={() => onToggleFavorite(device.id)}
                title={isFavorite ? "Remove from favorites" : "Add to favorites"}
                className="rounded-lg p-1.5 transition hover:bg-white/5"
                style={{ color: isFavorite ? "#fbbf24" : "var(--th-text-muted)" }}
              >
                <Star className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex flex-none gap-1 overflow-x-auto px-4 py-2" style={{ borderBottom: "1px solid var(--th-border-drawer-section)" }}>
          {visibleDrawerTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                activeTab === tab.id
                  ? "bg-techi-orange/15 text-orange-100 shadow-[inset_0_0_0_1px_rgba(255,85,63,0.22)]"
                  : "text-slate-400 hover:bg-white/[0.05] hover:text-white"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Trupi me scroll */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className={activeTab === "overview" ? "" : "hidden"}>

          {/* Paralajmerim per pajisje te arkivuar por aktive */}
          {device.is_archived && device.freshness_state !== "offline" && (
            <div
              className="mb-4 flex items-start gap-3 rounded-lg px-4 py-3"
              style={{ border: "1px solid rgba(251,146,60,0.25)", background: "rgba(251,146,60,0.07)" }}
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-orange-400" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-orange-300">Archived device is checking in</p>
                <p className="mt-0.5 text-[11px] leading-5 text-orange-200/70">
                  This device is archived but is still sending heartbeats. No automatic action has been taken.
                  Restore the device manually if it should rejoin the active fleet.
                </p>
              </div>
            </div>
          )}

          {/* Paralajmerim per duplikim */}
          {device.duplicate_candidate && (
            <div
              className="mb-4 rounded-lg px-4 py-3"
              style={{ border: "1px solid rgba(251,191,36,0.25)", background: "rgba(251,191,36,0.07)" }}
            >
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-amber-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-amber-300">Possible duplicate device</p>
                  <p className="mt-0.5 text-[11px] leading-5 text-amber-200/70">
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
                <button
                  type="button"
                  disabled={archiveBusy}
                  onClick={async () => {
                    setArchiveBusy(true);
                    try {
                      const updated = await archiveDevice(device.id);
                      onDeviceUpdated?.(updated);
                    } finally {
                      setArchiveBusy(false);
                    }
                  }}
                  className="mt-3 w-full rounded-md border border-amber-400/25 bg-amber-400/10 py-1.5 text-xs font-semibold text-amber-200 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {archiveBusy ? "Archiving…" : "Archive this duplicate"}
                </button>
              )}
            </div>
          )}

          {/* Health & Status */}
          <section className="mb-4">
            <p className="premium-kicker mb-2">Health &amp; Status</p>
            <div
              className="rounded-lg p-4"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              <div className="mb-3 flex items-center justify-between border-b border-white/5 pb-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2.5 w-2.5 flex-none rounded-full ${
                      device.freshness_state === "online"
                        ? "bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.7)]"
                        : device.freshness_state === "stale"
                        ? "bg-amber-300 shadow-[0_0_4px_rgba(251,191,36,0.6)]"
                        : "bg-slate-600"
                    }`}
                  />
                  <span className={`text-xs font-semibold capitalize ${
                    device.freshness_state === "online" ? "text-emerald-300"
                    : device.freshness_state === "stale" ? "text-amber-300"
                    : "text-slate-400"
                  }`}>
                    {device.freshness_state ?? device.status}
                  </span>
                </div>
                <HealthBadge state={healthState} score={healthScore} showLabel />
              </div>

              <div className="grid grid-cols-2 gap-x-5 gap-y-2.5">
                <div>
                  <p className="premium-kicker mb-0.5">Last Seen</p>
                  <p className="text-xs font-medium text-slate-100">
                    {device.last_seen
                      ? parseUTC(device.last_seen).toLocaleString(undefined, {
                          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                        })
                      : <span className="text-slate-500">Never</span>}
                  </p>
                </div>
                <div>
                  <p className="premium-kicker mb-0.5">Freshness</p>
                  <HeartbeatFreshness lastSeen={device.last_seen} />
                </div>

                {/* Offline Analysis — dynamic backend inference */}
                {device.freshness_state !== "online" && offlineAnalysis && offlineAnalysis.reason && (
                  <div className="col-span-2 border-t border-white/5 pt-2">
                    <div className="mb-1.5 flex items-center gap-2">
                      <p className="premium-kicker">Offline Analysis</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                      {/* Reason chip */}
                      <span className="inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold"
                        style={{ background: "rgba(249,115,22,0.12)", border: "1px solid rgba(249,115,22,0.25)", color: "#fb923c" }}>
                        {OFFLINE_REASON_LABELS[offlineAnalysis.reason] ?? offlineAnalysis.reason}
                      </span>
                      {/* Confidence chip */}
                      {offlineAnalysis.confidence && (
                        <span className={`inline-flex items-center rounded border px-1.5 py-px text-[9px] font-bold uppercase tracking-wide ${CONFIDENCE_COLORS[offlineAnalysis.confidence] ?? ""}`}>
                          {offlineAnalysis.confidence}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] leading-4 text-slate-300 mb-1">{offlineAnalysis.explanation}</p>
                    {offlineAnalysis.evidence.length > 0 && (
                      <ul className="space-y-0.5">
                        {offlineAnalysis.evidence.map((e, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-[10px] text-slate-500">
                            <span className="mt-0.5 h-1 w-1 flex-none rounded-full bg-slate-600" />
                            {e}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {device.freshness_state === "online" && (
                  <div className="col-span-2">
                    <p className="text-[11px] text-slate-500">Device is currently online.</p>
                  </div>
                )}

                {/* Health reasons */}
                {healthReasons.length > 0 && (
                  <div className="col-span-2 border-t border-white/5 pt-2">
                    <p className="premium-kicker mb-1">Health Issues</p>
                    <div className="space-y-0.5">
                      {healthReasons.slice(0, 4).map((r) => (
                        <p key={r} className="text-[11px] font-medium text-amber-300">⚠ {r}</p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Fleet Status grid */}
          <section className="mb-4">
            <p className="premium-kicker mb-2">Fleet Status</p>
            <div
              className="grid grid-cols-2 gap-2 rounded-lg p-3"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              {/* RustDesk status */}
              <div className="rounded-md p-2" style={{ background: "rgba(255,255,255,0.03)" }}>
                <p className="premium-kicker mb-0.5">Remote Support</p>
                <p className={`text-xs font-semibold ${
                  device.rustdesk_status === "running" ? "text-emerald-400"
                  : device.rustdesk_install_status === "not_installed" ? "text-slate-500"
                  : "text-amber-400"
                }`}>
                  {device.rustdesk_status === "running" ? "Running"
                   : device.rustdesk_install_status === "not_installed" ? "Not installed"
                   : (device.rustdesk_status ?? "Unknown")}
                </p>
              </div>
              {/* Patch status */}
              <div className="rounded-md p-2" style={{ background: "rgba(255,255,255,0.03)" }}>
                <p className="premium-kicker mb-0.5">Patch</p>
                <p className={`text-xs font-semibold ${
                  snapshot == null ? "text-slate-500"
                  : "text-slate-200"
                }`}>
                  {device.is_in_maintenance ? (
                    <span className="text-sky-300">Maintenance</span>
                  ) : (
                    <span className="text-slate-200">Check Inventory</span>
                  )}
                </p>
              </div>
              {/* Maintenance status */}
              <div className="rounded-md p-2" style={{ background: "rgba(255,255,255,0.03)" }}>
                <p className="premium-kicker mb-0.5">Maintenance</p>
                {device.is_in_maintenance ? (
                  <div>
                    <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/20 px-1.5 py-px text-[10px] font-semibold text-sky-400">
                      ● Active
                    </span>
                    {device.maintenance_ends_at && (
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        until {parseUTC(device.maintenance_ends_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs font-medium text-slate-400">Off</p>
                )}
              </div>
              {/* Duplicate / lifecycle flags */}
              <div className="rounded-md p-2" style={{ background: "rgba(255,255,255,0.03)" }}>
                <p className="premium-kicker mb-0.5">Lifecycle</p>
                <p className={`text-xs font-semibold ${device.is_archived ? "text-amber-400" : "text-emerald-400"}`}>
                  {device.is_archived ? "Archived" : "Active"}
                </p>
                {device.duplicate_candidate && (
                  <p className="mt-0.5 text-[10px] text-amber-400">Possible duplicate</p>
                )}
              </div>
            </div>
          </section>

          {/* Alert Center */}
          {(openAlerts.length > 0 || resolvedAlerts.length > 0) && (
          <section className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <p className="premium-kicker">Alerts</p>
              {openAlerts.length > 0 && (
                <span className="rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-400">
                  {openAlerts.length} active
                </span>
              )}
            </div>
            <div
              className="rounded-lg p-3"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              {openAlerts.length === 0 ? (
                <div className="flex items-center gap-2 py-1">
                  <CheckCircle className="h-4 w-4 text-emerald-500" />
                  <p className="text-xs font-medium text-slate-400">No active alerts</p>
                </div>
              ) : (
                <div className="space-y-0">
                  {/* Group by severity */}
                  {(["critical", "warning"] as const).map((sev) => {
                    const group = openAlerts.filter(a => a.severity === sev);
                    if (!group.length) return null;
                    const isC = sev === "critical";
                    return (
                      <div key={sev} className="mb-2 last:mb-0">
                        <p className={`mb-1 text-[9px] font-bold uppercase tracking-[0.1em] ${isC ? "text-red-500" : "text-amber-500"}`}>
                          {sev} · {group.length}
                        </p>
                        <div className="space-y-1">
                          {group.slice(0, 3).map(a => (
                            <div key={a.id} className="flex items-start gap-1.5">
                              <span className={`mt-1 h-1.5 w-1.5 flex-none rounded-full ${isC ? "bg-red-400" : "bg-amber-400"}`} />
                              <p className="text-[11px] leading-4 text-slate-300">{a.message}</p>
                            </div>
                          ))}
                          {group.length > 3 && (
                            <p className="text-[10px] text-slate-500 pl-3">+{group.length - 3} more</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
          )}

          {/* Mirembajtja */}
          <section className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <p className="premium-kicker">Maintenance</p>
              {device.is_in_maintenance && (
                <span className="rounded-full bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-sky-400">
                  active
                </span>
              )}
            </div>
            <div
              className="rounded-lg p-4"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              {device.is_in_maintenance ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-2">
                    <Wrench className="mt-0.5 h-3.5 w-3.5 flex-none text-sky-400" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-sky-300">Device is in maintenance</p>
                      {device.maintenance_note && (
                        <p className="mt-0.5 text-[11px] text-slate-400">{device.maintenance_note}</p>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-5 gap-y-2">
                    {device.maintenance_started_by && (
                      <div>
                        <p className="premium-kicker mb-0.5">Started by</p>
                        <p className="text-xs font-medium text-slate-200">{device.maintenance_started_by}</p>
                      </div>
                    )}
                    {device.maintenance_started_at && (
                      <div>
                        <p className="premium-kicker mb-0.5">Started at</p>
                        <p className="text-xs font-medium text-slate-200">
                          {parseUTC(device.maintenance_started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </p>
                      </div>
                    )}
                    {device.maintenance_ends_at && (
                      <div className="col-span-2">
                        <p className="premium-kicker mb-0.5">Ends at</p>
                        <p className="text-xs font-medium text-slate-200">
                          {parseUTC(device.maintenance_ends_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </p>
                      </div>
                    )}
                    {!device.maintenance_ends_at && (
                      <div className="col-span-2">
                        <p className="premium-kicker mb-0.5">Duration</p>
                        <p className="text-xs font-medium text-slate-400">Indefinite</p>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
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
                    className="mt-1 w-full rounded-md border border-white/10 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Exit maintenance
                  </button>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <p className="text-[11px] font-medium text-slate-500">
                    Alerts are suppressed while a device is in maintenance. Heartbeats and telemetry continue normally.
                  </p>
	                  {canOperate && (
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
                        className="w-full rounded-lg border border-white/[0.1] bg-slate-950 px-3 py-1.5 text-xs font-medium text-white outline-none placeholder-slate-600 transition focus:border-techi-orange/60"
                      />
                    </label>
                    <label className="block">
                      <span className="premium-kicker mb-1 block">Note (optional)</span>
                      <input
                        type="text"
                        placeholder="Reason..."
                        value={maintenanceForm.note}
                        onChange={(e) => setMaintenanceForm((f) => ({ ...f, note: e.target.value }))}
                        className="w-full rounded-lg border border-white/[0.1] bg-slate-950 px-3 py-1.5 text-xs font-medium text-white outline-none placeholder-slate-600 transition focus:border-techi-orange/60"
                      />
                    </label>
                  </div>
	                  <button
                    type="button"
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
                        onDeviceUpdated?.(updated);
                      } finally {
                        setMaintenanceBusy(false);
                      }
                    }}
                    className="w-full rounded-md border border-sky-400/30 bg-sky-400/10 py-1.5 text-xs font-semibold text-sky-200 transition hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Wrench className="mr-1 inline h-3 w-3" />
	                    Enter maintenance
	                  </button>
	                  </>
	                  )}
	                </div>
              )}
            </div>
          </section>

          {/* Identiteti */}
          <section className="mb-4">
            <p className="premium-kicker mb-2">Identity</p>
            <div
              className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-lg p-4"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              <div>
                <p className="premium-kicker mb-1">Current User</p>
                <div className="flex items-center gap-1.5">
                  <p className={`text-xs font-medium leading-5 ${device.current_user ? "text-slate-100" : "text-slate-500"}`}>
                    {device.current_user || "—"}
                  </p>
                  {device.user_source && device.user_source !== "no_interactive_user" && device.user_source !== "fallback" && (
                    <span
                      className={`inline-flex items-center rounded px-1 py-0.5 text-[9px] font-semibold uppercase leading-3 ${
                        device.user_source === "rdp_session"
                          ? "border border-purple-400/25 bg-purple-400/[0.1] text-purple-300"
                          : "border border-sky-400/25 bg-sky-400/[0.1] text-sky-300"
                      }`}
                      title={device.user_source}
                    >
                      {device.user_source === "rdp_session" ? "RDP" : "Console"}
                    </span>
                  )}
                </div>
                {device.user_session_state && device.user_session_state !== "unknown" && (
                  <p className="mt-0.5 text-[10px] font-medium text-slate-500">
                    Session: {device.user_session_state}
                  </p>
                )}
              </div>
              <DetailRow label="Domain" value={device.domain} />
              <DetailRow label="OS" value={device.os_name} />
              <DetailRow label="Platform" value={device.platform} />
              {(device.cpu || device.ram || device.storage) && (
                <div className="col-span-2">
                  <p className="premium-kicker mb-1">Hardware</p>
                  <p className="text-xs font-medium leading-5 text-slate-200">
                    {[device.cpu, device.ram, device.storage].filter(Boolean).join(" · ")}
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Caktimi */}
          <section className="mb-4">
            <p className="premium-kicker mb-2">Client Assignment</p>
            <div
              className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-lg p-4"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              <DetailRow label="Client" value={device.resolved_client_name || device.client_name || "No client"} />
              <DetailRow label="Group" value={device.resolved_group || device.group_name || "No group"} />
              <div className="col-span-2">
                <p className="premium-kicker mb-1">Assignment Source</p>
                <AssignmentSourceBadge source={device.resolved_assignment_source || device.assignment_source} />
              </div>
	              {canOperate && (
	              <label className="col-span-2 block">
                <span className="premium-kicker mb-1 block">Assign Client</span>
                <select
                  value={device.client_id ?? "none"}
                  onChange={async (event) => {
                    const value = event.target.value === "none" ? null : Number(event.target.value);
                    const updated = await assignDeviceClient(device.id, value);
                    onDeviceUpdated?.(updated);
                  }}
                  className="w-full rounded-lg border border-white/[0.1] bg-slate-950 px-3 py-2 text-xs font-medium text-white outline-none transition focus:border-techi-orange/60"
                >
                  <option value="none">No client</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>{client.name}</option>
                  ))}
                </select>
	              </label>
	              )}
	              {canOperate && (
	              <label className="col-span-2 block">
                <span className="premium-kicker mb-1 block">Assign Group</span>
                <select
                  value={device.group_id ?? "none"}
                  disabled={!assignmentClientId}
                  onChange={async (event) => {
                    const value = event.target.value === "none" ? null : Number(event.target.value);
                    const updated = await assignDeviceGroup(device.id, value);
                    onDeviceUpdated?.(updated);
                  }}
                  className="w-full rounded-lg border border-white/[0.1] bg-slate-950 px-3 py-2 text-xs font-medium text-white outline-none transition focus:border-techi-orange/60 disabled:cursor-not-allowed disabled:text-slate-600"
                >
                  <option value="none">No group</option>
                  {availableGroups.map((group) => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </select>
	              </label>
	              )}
            </div>
          </section>

          {/* Rrjeti */}
          <section className="mb-4">
            <p className="premium-kicker mb-2">Network</p>
            <div
              className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-lg p-4"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              <DetailRow label="Local IP" value={device.local_ip} mono />
              <DetailRow label="Public IP" value={device.public_ip} mono />
            </div>
          </section>


          </div>

          <div className={activeTab === "overview" ? "" : "hidden"}>
          {/* Telemetria */}
          <section className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="premium-kicker">Health &amp; Telemetry</p>
              <HealthBadge state={healthState} score={healthScore} showLabel />
            </div>
            <div
              className="rounded-lg p-4"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              <div className="space-y-3">
                <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3 border-b border-white/5 pb-3">
                  <div
                    className={`flex h-14 w-14 items-center justify-center rounded-lg border text-lg font-bold ${
                      healthState === "critical"
                        ? "border-red-400/30 bg-red-400/10 text-red-300"
                        : healthState === "warning"
                        ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                        : "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                    }`}
                  >
                    {healthScore ?? "—"}
                  </div>
                  <div>
                    <p className="premium-kicker mb-1">Health score</p>
                    <p className="text-xs font-medium text-slate-300">
                      Computed from telemetry, freshness, alerts, trust, and lifecycle signals.
                    </p>
                  </div>
                </div>
                {snapshot ? (
                  <>
                  <ResourceBar label="CPU" percent={snapshot.cpu_percent} warnAt={75} criticalAt={90} />
                  <ResourceBar label="RAM" percent={snapshot.ram_percent} warnAt={80} criticalAt={90} />
                  <ResourceBar label="Disk" percent={snapshot.disk_percent} warnAt={85} criticalAt={95} />
                  <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 border-t border-white/5 pt-3">
                    <div>
                      <p className="premium-kicker mb-1">Uptime</p>
                      <p className="text-xs font-medium text-slate-100">{formatUptime(snapshot.uptime_seconds)}</p>
                    </div>
                    <div>
                      <p className="premium-kicker mb-1">Latency</p>
                      <p className="text-xs font-medium text-slate-100">
                        {snapshot.heartbeat_latency_ms !== null ? `${snapshot.heartbeat_latency_ms}ms` : "—"}
                      </p>
                    </div>
                    <div className="col-span-2">
                      <p className="premium-kicker mb-1">Last Telemetry</p>
                      <p className="text-xs font-medium text-slate-300">
                        {new Date(snapshot.created_at).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </p>
                    </div>
                  </div>
                  {healthReasons.length > 0 && (
                    <div className="border-t border-white/5 pt-3">
                      {healthReasons.map((r) => (
                        <p key={r} className="text-[11px] font-medium text-amber-300">⚠ {r}</p>
                      ))}
                    </div>
                  )}
                  </>
                ) : (
                  <p className="py-2 text-center text-xs font-medium text-slate-500">
                    No telemetry yet — run the agent to collect metrics
                  </p>
                )}
              </div>
            </div>
          </section>

          {/* Sinjalizimet */}
          <section className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <p className="premium-kicker">Alerts</p>
              {openAlerts.length > 0 && (
                <span className="rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-400">
                  {openAlerts.length} active
                </span>
              )}
            </div>
            <div
              className="rounded-lg p-4"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              {openAlerts.length === 0 && resolvedAlerts.length === 0 ? (
                <div className="flex items-center gap-2 py-1">
                  <CheckCircle className="h-4 w-4 text-emerald-500" />
                  <p className="text-xs font-medium text-slate-400">No alerts for this device</p>
                </div>
              ) : (
                <>
                  {openAlerts.length > 0 && (
                    <div className="divide-y divide-white/5">
                      {openAlerts.map((a) => (
                        <AlertRow key={a.id} alert={a} />
                      ))}
                    </div>
                  )}
                  {resolvedAlerts.length > 0 && (
                    <div className={`divide-y divide-white/5 ${openAlerts.length > 0 ? "mt-2 border-t border-white/5 pt-2" : ""}`}>
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Recently Resolved</p>
                      {resolvedAlerts.map((a) => (
                        <AlertRow key={a.id} alert={a} resolved />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
          </div>

          {/* Destructive action confirmation modal — rendered outside tab panels so it works from any tab */}
          {restartConfirmOpen && (
            <ConfirmationModal
              title={
                selectedActionType === "reinstall_rustdesk"
                  ? "Reinstall TECHI Remote Support?"
                  : selectedActionType === "restart_agent"
                  ? "Restart Agent service?"
                  : "Restart device?"
              }
              confirmLabel={
                selectedActionType === "reinstall_rustdesk"
                  ? "Confirm reinstall"
                  : selectedActionType === "restart_agent"
                  ? "Restart Agent"
                  : "Restart device"
              }
              destructive={true}
              loading={actionBusy}
              onClose={() => setRestartConfirmOpen(false)}
              onConfirm={async () => {
                setRestartConfirmOpen(false);
                setActionBusy(true);
                try {
                  const created = await queueDeviceAction(device.id, {
                    action_type: selectedActionType,
                    created_by: user?.username ?? "operator",
                  });
                  setActions((prev) => [created, ...prev]);
                } finally {
                  setActionBusy(false);
                }
              }}
            >
              {selectedActionType === "reinstall_rustdesk" ? (
                <>This will download and silently reinstall TECHI Remote Support on <span className="font-semibold text-slate-200">{device.hostname}</span>. Remote access will be interrupted during reinstall.</>
              ) : selectedActionType === "restart_agent" ? (
                <>This will stop and restart the <span className="font-semibold text-slate-200">TechiAgent</span> Windows service on <span className="font-semibold text-slate-200">{device.hostname}</span>. The agent will reconnect within ~15 seconds. Active actions will be re-queued on reconnect.</>
              ) : (
                <>This will trigger an immediate OS-level restart on <span className="font-semibold text-slate-200">{device.hostname}</span>. The device will go offline and reconnect after boot. All unsaved work on the device will be lost.</>
              )}
            </ConfirmationModal>
          )}

          <div className={activeTab === "management" ? "" : "hidden"}>
          {/* Veprimet remote */}
          <section className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <p className="premium-kicker">Remote Actions</p>
              {actions.filter((a) => isActiveStatus(a.status)).length > 0 && (
                <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">
                  {actions.filter((a) => isActiveStatus(a.status)).length} active
                </span>
              )}
              <button
                type="button"
                onClick={loadActions}
                className="ml-auto rounded p-0.5 text-slate-600 hover:text-slate-300"
                title="Refresh actions"
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            </div>

            <div
              className="rounded-lg p-4"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              {/* Paralajmerime */}
              {device.is_archived && (
                <div className="mb-3 flex items-start gap-2 rounded-md bg-orange-500/10 px-3 py-2 text-[11px] text-orange-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none text-orange-400" />
                  <span>Device is archived. Actions will queue but may not be delivered.</span>
                </div>
              )}
              {device.is_in_maintenance && (
                <div className="mb-3 flex items-start gap-2 rounded-md bg-sky-500/10 px-3 py-2 text-[11px] text-sky-200">
                  <Wrench className="mt-0.5 h-3.5 w-3.5 flex-none text-sky-400" />
                  <span>Device is in maintenance. Actions will still be queued.</span>
                </div>
              )}
              {!device.is_archived && device.freshness_state === "offline" && (() => {
                // Check if a restart action completed within the last 5 minutes
                const RESTART_TYPES = new Set(["restart_device", "restart_agent"]);
                const recentRestart = actions.find((a) => {
                  if (!RESTART_TYPES.has(a.action_type)) return false;
                  if (a.status !== "completed" && !isActiveStatus(a.status)) return false;
                  const ref = a.completed_at ?? a.sent_at ?? a.created_at;
                  return ref ? Date.now() - new Date(ref).getTime() < 5 * 60 * 1000 : false;
                });
                if (recentRestart) {
                  return (
                    <div className="mb-3 flex items-start gap-2 rounded-md bg-sky-500/10 px-3 py-2 text-[11px] text-sky-200">
                      <RefreshCw className="mt-0.5 h-3.5 w-3.5 flex-none text-sky-400 animate-spin" />
                      <span>
                        {recentRestart.action_type === "restart_device"
                          ? "Device restart triggered — waiting for reconnect after boot."
                          : "Agent service restart triggered — reconnect expected within ~15 seconds."}
                      </span>
                    </div>
                  );
                }
                return (
                  <div className="mb-3 flex items-start gap-2 rounded-md bg-slate-700/30 px-3 py-2 text-[11px] text-slate-400">
                    <WifiOff className="mt-0.5 h-3.5 w-3.5 flex-none text-slate-500" />
                    <span>Device is offline. Action will queue and deliver on next heartbeat.</span>
                  </div>
                );
              })()}
              {device.freshness_state === "online" && !device.is_archived && (
                <div className="mb-3 flex items-start gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
                  <Wifi className="mt-0.5 h-3.5 w-3.5 flex-none text-emerald-400" />
                  <span>Device is online. Action will be delivered on next heartbeat.</span>
                </div>
              )}

              {canOperate ? (() => {
                const runAction = async (type: ActionType) => {
                  if (DESTRUCTIVE_ACTIONS.has(type)) {
                    setSelectedActionType(type);
                    setRestartConfirmOpen(true);
                    return;
                  }
                  setActionBusy(true);
                  try {
                    const created = await queueDeviceAction(device.id, { action_type: type, created_by: user?.username ?? "operator" });
                    setActions((prev) => [created, ...prev]);
                  } catch { /* surfaced via WS */ } finally { setActionBusy(false); }
                };
                const Btn = ({ type, label, destructive = false }: { type: ActionType; label: string; destructive?: boolean }) => (
                  <button type="button" disabled={actionBusy}
                    onClick={() => runAction(type)}
                    className="rounded-md px-2 py-1 text-[10px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
                    style={{
                      background: destructive ? "rgba(239,68,68,0.08)" : "rgba(255,255,255,0.04)",
                      border: `1px solid ${destructive ? "rgba(239,68,68,0.2)" : "var(--th-border-drawer-section)"}`,
                      color: destructive ? "#f87171" : "var(--th-text-secondary)",
                    }}>
                    {label}
                  </button>
                );
                const Group = ({ label, children }: { label: string; children: React.ReactNode }) => (
                  <div className="mb-2">
                    <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-slate-600">{label}</p>
                    <div className="flex flex-wrap gap-1">{children}</div>
                  </div>
                );
                return (
                  <div className="mb-3">
                    <Group label="Diagnostics">
                      <Btn type="ping" label="Ping" />
                      <Btn type="immediate_heartbeat" label="Heartbeat" />
                      <Btn type="refresh_inventory" label="Refresh Inv." />
                      <Btn type="sync_inventory" label="Sync Inv." />
                    </Group>
                    <Group label="Agent">
                      <Btn type="restart_agent" label="Restart Agent" destructive />
                      <Btn type="apply_power_policy" label="Power Policy" />
                    </Group>
                    <Group label="Device">
                      <Btn type="restart_device" label="Restart Device" destructive />
                    </Group>
                  </div>
                );
              })() : (
                <p className="mb-3 rounded-md bg-white/[0.03] px-3 py-2 text-[11px] font-medium text-slate-500">
                  Remote actions are read-only for this role.
                </p>
              )}

              {/* Status filter pills */}
              <div className="mb-3 flex gap-1.5">
                {(["all", "active", "done", "failed"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setActionFilter(f)}
                    className={`rounded-md px-2 py-0.5 text-[10px] font-semibold capitalize transition ${
                      actionFilter === f
                        ? "bg-techi-orange/15 text-orange-200 shadow-[inset_0_0_0_1px_rgba(255,85,63,0.22)]"
                        : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-300"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>

              {/* Lista e veprimeve */}
              {actionsLoading ? (
                <p className="py-3 text-center text-[11px] text-slate-500">Loading actions…</p>
              ) : actions.length === 0 ? (
                <p className="py-3 text-center text-[11px] text-slate-500">No actions yet</p>
              ) : (
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {actions
                    .filter((a) => {
                      if (actionFilter === "active") return isActiveStatus(a.status);
                      if (actionFilter === "done") return a.status === "completed";
                      if (actionFilter === "failed") return a.status === "failed" || a.status === "expired" || a.status === "cancelled";
                      return true;
                    })
                    .map((action) => (
                    <ActionRow
                      key={action.id}
                      action={action}
                      onCancel={canOperate ? async (id) => {
                        try {
                          const updated = await cancelAction(id);
                          setActions((prev) => prev.map((a) => a.id === id ? updated : a));
                        } catch {
                          // ignore
                        }
                      } : undefined}
                      onRetry={canOperate ? async (id) => {
                        try {
                          const created = await retryAction(id);
                          setActions((prev) => [created, ...prev]);
                        } catch {
                          // ignore
                        }
                      } : undefined}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
          </div>

          <div className={activeTab === "management" ? "" : "hidden"}>
          {/* Patch status */}
          <section className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="premium-kicker">Patch Status</p>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${patchStateClass(inventory?.patch_state)}`}>
                {patchStateLabel(inventory?.patch_state)}
              </span>
            </div>
            <div
              className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-lg p-4"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              <div>
                <p className="premium-kicker mb-1">Pending Updates</p>
                <p className="text-xs font-medium text-slate-100">
                  {inventory?.pending_updates != null ? inventory.pending_updates : "—"}
                </p>
              </div>
              <div>
                <p className="premium-kicker mb-1">Reboot Required</p>
                <p className={`text-xs font-semibold ${inventory?.reboot_required ? "text-red-300" : "text-emerald-300"}`}>
                  {inventory ? (inventory.reboot_required ? "Yes" : "No") : "—"}
                </p>
              </div>
              <div className="col-span-2">
                <p className="premium-kicker mb-1">Last Update</p>
                <p className="text-xs font-medium text-slate-300">
                  {inventory?.last_update_at || "—"}
                </p>
              </div>
            </div>
          </section>
          </div>

          {hasInventoryDetails && (
          <div className={false ? "" : "hidden"}>
          {inventory && inventory.processes.length > 0 && (
          <section className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="premium-kicker">Processes</p>
              <span className="text-[10px] text-slate-500">
                {inventory.processes.length} collected
              </span>
            </div>
            <div
              className="rounded-lg p-4"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              <>
                  <input
                    type="text"
                    placeholder="Search by name or PID…"
                    value={processSearch}
                    onChange={(e) => setProcessSearch(e.target.value)}
                    className="mb-3 w-full rounded-lg border border-white/[0.1] bg-slate-950 px-3 py-1.5 text-xs font-medium text-white outline-none placeholder-slate-600 transition focus:border-techi-orange/60"
                  />
                  <div className="max-h-60 overflow-y-auto">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 drawer-table-head" style={{ background: "var(--th-bg-drawer-table-head)" }}>
                        <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                          <th className="pb-1.5 pr-3">PID</th>
                          <th className="pb-1.5 pr-3">Name</th>
                          <th className="pb-1.5 text-right">Mem (MB)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {filteredProcesses.map((p) => (
                          <tr key={p.pid} className="text-slate-300 hover:bg-white/[0.02]">
                            <td className="py-1 pr-3 font-mono text-[10px] text-slate-500">{p.pid}</td>
                            <td className="max-w-[200px] truncate py-1 pr-3 font-medium">{p.name}</td>
                            <td className="py-1 text-right text-slate-400">
                              {p.memory_mb != null ? p.memory_mb.toFixed(1) : "—"}
                            </td>
                          </tr>
                        ))}
                        {filteredProcesses.length === 0 && (
                          <tr>
                            <td colSpan={3} className="py-3 text-center text-slate-500">
                              No matches
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
              </>
            </div>
          </section>
          )}

          {/* Sherbimet shfaqen vetem kur ka te dhena */}
          {inventory && inventory.services.length > 0 && (
            <section className="mb-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="premium-kicker">Services</p>
                <span className="text-[10px] text-slate-500">
                  {inventory.services.length} collected
                </span>
              </div>
              <div
                className="rounded-lg p-4"
                style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
              >
                <input
                  type="text"
                  placeholder="Search by name or status…"
                  value={serviceSearch}
                  onChange={(e) => setServiceSearch(e.target.value)}
                  className="mb-3 w-full rounded-lg border border-white/[0.1] bg-slate-950 px-3 py-1.5 text-xs font-medium text-white outline-none placeholder-slate-600 transition focus:border-techi-orange/60"
                />
                <div className="max-h-60 overflow-y-auto">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 drawer-table-head" style={{ background: "var(--th-bg-drawer-table-head)" }}>
                      <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        <th className="pb-1.5 pr-3">Name</th>
                        <th className="pb-1.5 pr-3">Status</th>
                        <th className="pb-1.5 text-right">Startup</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]">
                      {filteredServices.map((s) => (
                        <tr key={s.name} className="text-slate-300 hover:bg-white/[0.02]">
                          <td className="py-1 pr-3">
                            <p className="max-w-[180px] truncate font-medium">{s.display_name || s.name}</p>
                            <p className="font-mono text-[10px] text-slate-600">{s.name}</p>
                          </td>
                          <td className="py-1 pr-3">
                            <span
                              className={`font-semibold ${
                                s.status === "running"
                                  ? "text-emerald-400"
                                  : s.status === "stopped"
                                  ? "text-slate-500"
                                  : "text-amber-400"
                              }`}
                            >
                              {s.status}
                            </span>
                          </td>
                          <td className="py-1 text-right text-slate-500">
                            {s.startup_type ?? "—"}
                          </td>
                        </tr>
                      ))}
                      {filteredServices.length === 0 && (
                        <tr>
                          <td colSpan={3} className="py-3 text-center text-slate-500">
                            No matches
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {inventory && (inventory.software ?? []).length > 0 && (
          <section className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="premium-kicker">Software</p>
              <span className="text-[10px] text-slate-500">
                {(inventory.software ?? []).length} collected
              </span>
            </div>
            <div
              className="rounded-lg p-4"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              <>
                  <input
                    type="text"
                    placeholder="Search by name, version, or publisher…"
                    value={softwareSearch}
                    onChange={(e) => setSoftwareSearch(e.target.value)}
                    className="mb-3 w-full rounded-lg border border-white/[0.1] bg-slate-950 px-3 py-1.5 text-xs font-medium text-white outline-none placeholder-slate-600 transition focus:border-techi-orange/60"
                  />
                  <div className="max-h-72 overflow-y-auto">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 drawer-table-head" style={{ background: "var(--th-bg-drawer-table-head)" }}>
                        <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                          <th className="pb-1.5 pr-3">Name</th>
                          <th className="pb-1.5 pr-3">Version</th>
                          <th className="pb-1.5">Publisher</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {filteredSoftware.map((s, idx) => (
                          <tr key={`${s.name}-${s.version ?? ""}-${idx}`} className="text-slate-300 hover:bg-white/[0.02]">
                            <td className="max-w-[180px] truncate py-1 pr-3 font-medium">{s.name}</td>
                            <td className="max-w-[90px] truncate py-1 pr-3 text-slate-400">{s.version || "—"}</td>
                            <td className="max-w-[140px] truncate py-1 text-slate-500">{s.publisher || "—"}</td>
                          </tr>
                        ))}
                        {filteredSoftware.length === 0 && (
                          <tr>
                            <td colSpan={3} className="py-3 text-center text-slate-500">
                              No matches
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
              </>
            </div>
          </section>
          )}
          </div>
          )}

          <div className={activeTab === "notes" ? "" : "hidden"}>
          <section className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="premium-kicker">Notes</p>
              <span className="text-[10px] text-slate-500">{notes.length} saved</span>
            </div>
            <div
              className="rounded-lg p-4"
              style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
            >
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                rows={3}
                placeholder="Add an internal note..."
                className="w-full resize-none rounded-lg border border-white/[0.1] bg-slate-950 px-3 py-2 text-xs font-medium leading-5 text-white outline-none placeholder-slate-600 transition focus:border-techi-orange/60"
              />
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  disabled={noteBusy || !noteText.trim()}
                  onClick={addNote}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-techi-orange/25 bg-techi-orange/10 px-3 py-1.5 text-xs font-semibold text-orange-200 transition hover:bg-techi-orange/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Save className="h-3 w-3" />
                  Add note
                </button>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              {notesLoading ? (
                <p className="py-4 text-center text-[11px] text-slate-500">Loading notes...</p>
              ) : notes.length === 0 ? (
                <div
                  className="rounded-lg p-4 text-center text-xs font-medium text-slate-500"
                  style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
                >
                  No notes yet.
                </div>
              ) : (
                notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg p-3"
                    style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        {note.created_by || "admin"}
                      </span>
                      <span className="text-[10px] text-slate-600">{actionTimeAgo(note.updated_at)}</span>
	                      {canOperate && (
	                      <div className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          disabled={noteBusy}
                          onClick={() => {
                            setEditingNoteId(note.id);
                            setEditingText(note.note);
                          }}
                          className="rounded p-1 text-slate-600 transition hover:bg-white/[0.05] hover:text-slate-300 disabled:opacity-50"
                          title="Edit note"
                        >
                          <Edit3 className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          disabled={noteBusy}
                          onClick={() => removeNote(note.id)}
                          className="rounded p-1 text-slate-600 transition hover:bg-white/[0.05] hover:text-red-300 disabled:opacity-50"
                          title="Delete note"
                        >
                          <Trash2 className="h-3 w-3" />
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
                          className="w-full resize-none rounded-md border border-white/[0.1] bg-slate-950 px-3 py-2 text-xs font-medium leading-5 text-white outline-none focus:border-techi-orange/60"
                        />
                        <div className="mt-2 flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingNoteId(null);
                              setEditingText("");
                            }}
                            className="rounded-md px-2 py-1 text-[11px] font-semibold text-slate-500 transition hover:bg-white/[0.05] hover:text-slate-300"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={noteBusy || !editingText.trim()}
                            onClick={() => saveNote(note.id)}
                            className="inline-flex items-center gap-1 rounded-md border border-techi-orange/25 bg-techi-orange/10 px-2 py-1 text-[11px] font-semibold text-orange-200 transition hover:bg-techi-orange/20 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Save className="h-3 w-3" />
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap text-xs leading-5 text-slate-300">{note.note}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
          </div>

          <div className={activeTab === "timeline" ? "" : "hidden"}>
          <section
            className="rounded-lg p-4"
            style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
          >
            <ActivityTimeline events={events} loading={loading} onReload={reload} />
          </section>
          </div>

          {/* ── Remote Support tab ── */}
          <div className={activeTab === "remote_support" ? "" : "hidden"}>
            {/* Toast feedback */}
            {rsToast && (
              <div
                className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium"
                style={{
                  background: rsToast.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                  border: `1px solid ${rsToast.ok ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)"}`,
                  color: rsToast.ok ? "#22c55e" : "#ef4444",
                }}
              >
                {rsToast.message}
              </div>
            )}

            {/* Status header + Connect */}
            <section className="mb-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Monitor className="h-4 w-4 text-orange-400/70" />
                  <p className="premium-kicker">TECHI Remote Support</p>
                </div>
                <button
                  type="button"
                  disabled={!isValidRustDeskId(device.rustdesk_id) || device.rustdesk_conflict_detected}
                  onClick={() => launchRustDesk(device.rustdesk_id!)}
                  title={
                    device.rustdesk_conflict_detected
                      ? "Remote Support ID conflict detected"
                      : isValidRustDeskId(device.rustdesk_id)
                      ? "Open TECHI Remote Support"
                      : "Remote ID not resolved yet"
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-orange-400/30 bg-orange-400/15 px-3 py-1.5 text-xs font-semibold text-orange-200 transition hover:bg-orange-400/25 disabled:cursor-not-allowed disabled:border-white/[0.06] disabled:bg-transparent disabled:text-slate-600"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Connect
                </button>
              </div>

              <div
                className="rounded-lg p-4"
                style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
              >
                {/* Remote ID with copy */}
                <div className="mb-4 pb-4" style={{ borderBottom: "1px solid var(--th-border-drawer-section)" }}>
                  <p className="premium-kicker mb-1">Remote ID</p>
                  <div className="flex items-center gap-2">
                    {device.rustdesk_id && isValidRustDeskId(device.rustdesk_id) ? (
                      <span className="font-mono text-sm font-semibold text-orange-300">{device.rustdesk_id}</span>
                    ) : (
                      <span className="text-xs font-medium text-slate-500">{device.rustdesk_id || "Not assigned"}</span>
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
                        className="flex h-6 w-6 items-center justify-center rounded text-slate-500 transition hover:bg-white/[0.08] hover:text-slate-200"
                        title="Copy Remote ID"
                      >
                        {rsCopySuccess ? (
                          <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <ClipboardCopy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {/* Details grid */}
                <div className="grid grid-cols-2 gap-x-5 gap-y-3">
                  <div>
                    <p className="premium-kicker mb-1">Service</p>
                    <RsServiceBadge status={rsDevice?.service_status ?? device.rustdesk_status} />
                  </div>
                  <div>
                    <p className="premium-kicker mb-1">Version</p>
                    <p className="font-mono text-xs font-medium text-slate-100">
                      {device.rustdesk_version ? `v${device.rustdesk_version}` : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="premium-kicker mb-1">Sync State</p>
                    <p className={`text-xs font-semibold ${syncColor}`}>{syncLabel}</p>
                    {device.rustdesk_sync_message && (
                      <p className="mt-0.5 text-[10px] leading-4 text-slate-500">{device.rustdesk_sync_message}</p>
                    )}
                  </div>
                  <div>
                    <p className="premium-kicker mb-1">Last Heartbeat</p>
                    <p className="text-xs font-medium text-slate-100">
                      {device.last_seen
                        ? parseUTC(device.last_seen).toLocaleString(undefined, {
                            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                          })
                        : <span className="text-slate-500">Never</span>}
                    </p>
                  </div>
                  {rsDevice?.install_path && (
                    <div className="col-span-2">
                      <p className="premium-kicker mb-1">Install Path</p>
                      <p className="break-all font-mono text-[11px] text-slate-400">{rsDevice.install_path}</p>
                    </div>
                  )}
                  {rsDevice != null && (
                    <div>
                      <p className="premium-kicker mb-1">Repair Count</p>
                      <p className="text-xs font-medium text-slate-100">{rsDevice.repair_count ?? 0}</p>
                    </div>
                  )}
                  <div className="col-span-2">
                    <p className="premium-kicker mb-1">Config Status</p>
                    <p className="text-xs font-medium text-slate-500">Not available</p>
                  </div>
                </div>

                {!isValidRustDeskId(device.rustdesk_id) && (
                  <p className="mt-3 text-[11px] font-medium text-slate-500">
                    TECHI Remote Support ID not resolved yet — Connect is disabled until a valid ID is confirmed.
                  </p>
                )}
              </div>
            </section>

            {/* Management actions */}
            {canOperate && (
              <section className="mb-4">
                <p className="premium-kicker mb-2">Management</p>
                <div
                  className="rounded-lg p-4"
                  style={{ border: "1px solid var(--th-border-drawer-section)", background: "var(--th-bg-drawer-section)" }}
                >
                  {/* Deploy prompt when not installed */}
                  {(device.rustdesk_install_status === "not_installed" || !device.rustdesk_id) && (
                    <div className="mb-3">
                      <p className="mb-2 text-[11px] font-medium text-slate-400">
                        TECHI Remote Support does not appear to be installed on this device.
                      </p>
                      <button
                        type="button"
                        disabled={rsBusyAction === "deploy"}
                        onClick={async () => {
                          setRsBusyAction("deploy");
                          try {
                            const created = await queueDeviceAction(device.id, {
                              action_type: "sync_rustdesk",
                              created_by: user?.username ?? "operator",
                            });
                            setActions((prev) => [created, ...prev]);
                            setRsToast({ message: "Deploy queued", ok: true });
                            setTimeout(() => setRsToast(null), 3000);
                          } catch (e: unknown) {
                            setRsToast({ message: e instanceof Error ? e.message : "Deploy failed", ok: false });
                            setTimeout(() => setRsToast(null), 3000);
                          } finally {
                            setRsBusyAction(null);
                          }
                        }}
                        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-orange-400/30 bg-orange-400/15 py-2 text-xs font-semibold text-orange-200 transition hover:bg-orange-400/25 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {rsBusyAction === "deploy" ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
                        Deploy TECHI Remote Support
                      </button>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    {/* Sync */}
                    <RsActionButton
                      label="Sync"
                      busy={rsBusyAction === "sync_rustdesk"}
                      onClick={async () => {
                        setRsBusyAction("sync_rustdesk");
                        try {
                          const created = await queueDeviceAction(device.id, { action_type: "sync_rustdesk", created_by: user?.username ?? "operator" });
                          setActions((prev) => [created, ...prev]);
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
                    {/* Restart */}
                    <RsActionButton
                      label="Restart"
                      busy={rsBusyAction === "restart_rustdesk"}
                      onClick={async () => {
                        setRsBusyAction("restart_rustdesk");
                        try {
                          const created = await queueDeviceAction(device.id, { action_type: "restart_rustdesk", created_by: user?.username ?? "operator" });
                          setActions((prev) => [created, ...prev]);
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
                    {/* Reopen */}
                    <RsActionButton
                      label="Reopen"
                      busy={rsBusyAction === "reopen_rustdesk"}
                      onClick={async () => {
                        setRsBusyAction("reopen_rustdesk");
                        try {
                          const created = await queueDeviceAction(device.id, { action_type: "reopen_rustdesk", created_by: user?.username ?? "operator" });
                          setActions((prev) => [created, ...prev]);
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
                    {/* Reinstall — destructive, triggers existing confirmation modal */}
                    <RsActionButton
                      label="Reinstall"
                      destructive
                      busy={rsBusyAction === "reinstall_rustdesk"}
                      onClick={() => {
                        setSelectedActionType("reinstall_rustdesk");
                        setRestartConfirmOpen(true);
                      }}
                    />
                  </div>
                </div>
              </section>
            )}

            {rsLoading && (
              <p className="text-center text-xs text-slate-500">Loading remote support details…</p>
            )}
          </div>
        </div>
      </div>
    </>
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
  const label = ACTION_LABELS[action.action_type as ActionType] ?? action.action_type;
  const statusLabel = ACTION_STATUS_LABELS[action.status] ?? action.status;
  const canCancel = Boolean(onCancel) && isActiveStatus(action.status);
  const canRetry = Boolean(onRetry) && isTerminalStatus(action.status);
  const isRunning = action.status === "running";
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
      className="flex items-start gap-2 rounded-md px-3 py-2 text-xs"
      style={{ background: "var(--th-bg-drawer-section)", border: "1px solid var(--th-border-drawer-section)" }}
    >
      {isRunning ? (
        <Loader2 className="mt-0.5 h-3 w-3 flex-none animate-spin text-sky-400" />
      ) : (
        <span className={`mt-1 h-1.5 w-1.5 flex-none rounded-full ${statusDotColor(action.status)}`} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-slate-100">{label}</span>
          <span className={`text-[10px] font-medium ${statusColor(action.status)}`}>
            {statusLabel}
          </span>
          {action.duration_seconds != null && (
            <span className="text-[10px] text-slate-500">
              {formatDuration(action.duration_seconds)}
            </span>
          )}
          <span className="ml-auto flex-none text-[10px] text-slate-600">
            {actionTimeAgo(relevantTime)}
          </span>
        </div>
        {action.created_by && (
          <p className="text-[10px] text-slate-600">by {action.created_by}</p>
        )}
        {action.result_message && (
          <p className="mt-0.5 text-[10px] text-emerald-400">{action.result_message}</p>
        )}
        {action.error_message && (
          <p className="mt-0.5 text-[10px] text-red-400">{action.error_message}</p>
        )}
        {action.output && action.output !== action.result_message && (
          <pre className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white/[0.03] px-2 py-1 text-[9px] font-mono leading-4 text-slate-400">
            {action.output}
          </pre>
        )}
        {action.stderr_output && (
          <pre className="mt-1 max-h-16 overflow-y-auto whitespace-pre-wrap break-words rounded bg-red-950/30 px-2 py-1 text-[9px] font-mono leading-4 text-red-300">
            {action.stderr_output}
          </pre>
        )}
        <div className="mt-1 flex items-center gap-2">
          {canCancel && (
            <button
              type="button"
              onClick={() => onCancel?.(action.id)}
              className="text-[10px] font-semibold text-slate-500 underline hover:text-slate-300"
            >
              Cancel
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              onClick={() => onRetry?.(action.id)}
              className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 underline hover:text-slate-300"
            >
              <RefreshCw className="h-2.5 w-2.5" />
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Remote Support tab helpers ────────────────────────────────────────────

function RsServiceBadge({ status }: { status?: string }) {
  const isRunning = status === "running";
  const isStopped = status === "stopped" || status === "not_running";
  const isNotInstalled = status === "not_installed";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{
        color: isRunning ? "#22c55e" : isStopped || isNotInstalled ? "#6b7280" : "#94a3b8",
        background: isRunning ? "rgba(34,197,94,0.1)" : "rgba(255,255,255,0.05)",
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: isRunning ? "#22c55e" : "#4b5563" }}
      />
      {isRunning ? "Running" : isStopped ? "Stopped" : isNotInstalled ? "Not installed" : (status ?? "Unknown")}
    </span>
  );
}

function RsActionButton({
  label,
  busy,
  onClick,
  destructive = false,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="flex items-center justify-center gap-1.5 rounded-md py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        border: `1px solid ${destructive ? "rgba(239,68,68,0.2)" : "var(--th-border-drawer-section)"}`,
        background: destructive ? "rgba(239,68,68,0.08)" : "rgba(255,255,255,0.04)",
        color: destructive ? "#f87171" : "var(--th-text-secondary)",
      }}
    >
      {busy && <RefreshCw className="h-3 w-3 animate-spin" />}
      {label}
    </button>
  );
}
