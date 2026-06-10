import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, AlertTriangle, ExternalLink, Loader2, MoreHorizontal, PlayCircle, RotateCcw, Search, ServerOff, Star, Trash2, Wrench } from "lucide-react";
import { clearDeviceMaintenance, Device, DeviceFilters, enterDeviceMaintenance } from "../api/devices";
import { PatchStatus } from "../api/inventory";
import { ActionStatus, isActiveStatus, queueDeviceAction } from "../api/actions";
import { isValidRustDeskId, launchRustDesk } from "../services/rustdeskLaunch";
import { DeviceHealthSummary } from "../types/telemetry";
import { Badge, Button } from "./ui";
import ConfirmationModal from "./ConfirmationModal";
import { parseUTC } from "../utils/time";

export interface ActiveActionEntry {
  action_type: string;
  status: ActionStatus;
}

interface DevicesTableProps {
  devices: Device[];
  loading: boolean;
  error: string | null;
  filters: DeviceFilters;
  searchQuery: string;
  onSearch: (value: string) => void;
  onFilterChange: (key: keyof DeviceFilters, value: string | boolean | undefined) => void;
  onRefresh: () => void;
  onDeviceSelect?: (device: Device) => void;
  onDeviceDelete?: (device: Device) => void;
  onDeviceArchive?: (device: Device) => void;
  onDeviceRestore?: (device: Device) => void;
  healthMap?: Record<number, DeviceHealthSummary>;
  patchMap?: Record<number, PatchStatus>;
  activeActionMap?: Record<number, ActiveActionEntry>;
  alertsMap?: Record<number, { critical: number; warning: number }>;
  canOperate?: boolean;
  canDelete?: boolean;
  currentUser?: string;
  onBulkComplete?: () => void;
  favorites?: Set<number>;
  onToggleFavorite?: (deviceId: number) => void;
  quickFilter: QuickFilter;
  onQuickFilterChange: (filter: QuickFilter) => void;
  scopedDeviceCount: number;
  tableLoading?: boolean;
  page?: number;
  limit?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  onLimitChange?: (limit: number) => void;
}

export type QuickFilter =
  | "all" | "online" | "stale" | "offline" | "servers" | "workstations"
  | "needs_updates" | "reboot_required" | "warnings" | "critical"
  | "healthy" | "maintenance" | "needs_attention" | "low_health" | "rustdesk_issues" | "favorites";

const QUICK_FILTERS: { id: QuickFilter; label: string }[] = [
  { id: "all",             label: "All" },
  { id: "online",          label: "Online" },
  { id: "stale",           label: "Stale" },
  { id: "offline",         label: "Offline" },
  { id: "servers",         label: "Servers" },
  { id: "workstations",    label: "Workstations" },
  { id: "needs_updates",   label: "Needs Updates" },
  { id: "reboot_required", label: "Reboot Required" },
  { id: "warnings",        label: "Warnings" },
  { id: "critical",        label: "Critical" },
  { id: "healthy",         label: "Healthy" },
  { id: "maintenance",     label: "Maintenance" },
  { id: "needs_attention", label: "Needs Attention" },
  { id: "low_health",      label: "Low Health" },
  { id: "rustdesk_issues", label: "RustDesk Issues" },
  { id: "favorites",       label: "★ Favorites" },
];

type PendingAction = "archive" | "restore" | "delete";
export type HealthFilter = "all" | DeviceHealthSummary["health_state"];

// ─── Visual constants ────────────────────────────────────────────────────────

const compactBadgeClass = "!min-h-[1.35rem] !px-1.5 !py-0.5 !text-[10px] !leading-3";
const subtleBadgeClass = `border-white/10 bg-white/[0.025] text-slate-400 ${compactBadgeClass}`;
const FILTER_INPUT_CLS =
  "th-input rounded-lg border px-3 py-1.5 text-xs font-medium focus:border-techi-orange/50 focus:outline-none";
const ACTION_MENU_WIDTH = 192;
const ACTION_MENU_MAX_HEIGHT = 220;
const ACTION_MENU_GAP = 6;
const ACTION_MENU_MARGIN = 8;

// ─── Cell helpers ────────────────────────────────────────────────────────────

/** Status dot + colored health score in the leftmost cell. */
const renderStatusCell = (device: Device, health?: DeviceHealthSummary) => {
  const state = device.freshness_state ?? device.status;
  const isOnline = state === "online";
  const isStale = state === "stale";

  const score = health?.health_score ?? null;
  const healthState = health?.health_state ?? "healthy";
  const scoreColor =
    score === null
      ? "text-slate-700"
      : healthState === "critical"
      ? "text-red-400"
      : healthState === "warning"
      ? "text-amber-400"
      : "text-emerald-400/80";

  return (
    <div
      className="flex flex-col items-center gap-0.5"
      title={`${device.freshness_state ?? device.status}${score != null ? ` · health ${score}` : ""}`}
    >
      <span
        className={`inline-block h-2.5 w-2.5 flex-none rounded-full ${
          isOnline
            ? "bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.7)]"
            : isStale
            ? "bg-amber-300 shadow-[0_0_4px_rgba(251,191,36,0.6)]"
            : "bg-slate-600"
        }`}
      />
      <span className={`text-[9px] font-bold tabular-nums leading-none ${scoreColor}`}>
        {score != null ? score : "—"}
      </span>
    </div>
  );
};

/** Lightweight client-side offline reason badge (no API call). */
interface ClientOfflineSummary {
  offlineCount: number;
  inactiveLastSeen: number[];
}

const getOfflineReasonBadge = (
  device: Device,
  clientSummary?: ClientOfflineSummary,
) => {
  const freshness = device.freshness_state ?? device.status;
  if (freshness === "online") return null;
  if (!device.last_seen) return null;

  // RS stopped but device recently active
  const rsStatus = (device.rustdesk_status ?? "").toLowerCase();
  const rsInstall = (device.rustdesk_install_status ?? "").toLowerCase();
  if (
    ["stopped", "not_running", "offline"].includes(rsStatus) &&
    !["not_installed", "unknown", ""].includes(rsInstall)
  ) {
    return { label: "RS stopped", color: "#f97316", bg: "rgba(249,115,22,0.12)", border: "rgba(249,115,22,0.25)" };
  }

  // Site outage: ≥2 peers from same client offline near same time
  if (device.client_id && device.last_seen) {
    const t = new Date(device.last_seen).getTime();
    const nearbyPeers = clientSummary?.inactiveLastSeen.filter(
      (lastSeen) => lastSeen !== t && Math.abs(lastSeen - t) < 10 * 60 * 1000
    ).length ?? 0;
    if (nearbyPeers >= 2)
      return { label: "Site?", color: "#f87171", bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.3)" };
  }

  // Single device offline (no other offline from same client)
  if (freshness === "offline" && device.client_id) {
    if ((clientSummary?.offlineCount ?? 0) <= 1)
      return { label: "Power?", color: "#94a3b8", bg: "rgba(148,163,184,0.08)", border: "rgba(148,163,184,0.2)" };
  }

  // Has IP → network issue
  if (device.public_ip || device.local_ip)
    return { label: "Network", color: "#60a5fa", bg: "rgba(96,165,250,0.1)", border: "rgba(96,165,250,0.22)" };

  // Stale only
  if (freshness === "stale")
    return { label: "Stale", color: "#fbbf24", bg: "rgba(251,191,36,0.1)", border: "rgba(251,191,36,0.22)" };

  return null;
};

/** Server / Workstation pill badge. */
const getDeviceTypeBadge = (device: Device) => {
  const cat = device.resolved_device_category;
  const dt = device.device_type;
  const isServer = cat === "servers" || dt === "server";
  const isWs = cat === "clientpc" || dt === "client";

  if (isServer)
    return (
      <span
        className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide"
        style={{
          color: "#a78bfa",
          background: "rgba(167,139,250,0.12)",
          border: "1px solid rgba(167,139,250,0.22)",
        }}
      >
        Server
      </span>
    );
  if (isWs)
    return (
      <span
        className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide"
        style={{
          color: "#60a5fa",
          background: "rgba(96,165,250,0.1)",
          border: "1px solid rgba(96,165,250,0.2)",
        }}
      >
        WS
      </span>
    );
  return null;
};

/** Color-coded "last seen" display. */
const getLastSeenDisplay = (lastSeen?: string): { text: string; cls: string } => {
  if (!lastSeen) return { text: "Never", cls: "text-slate-600" };
  const diffMs = Date.now() - parseUTC(lastSeen).getTime();
  const mins = diffMs / 60_000;
  const hours = diffMs / 3_600_000;
  const days = diffMs / 86_400_000;
  if (mins < 5) return { text: "Just now", cls: "text-emerald-400" };
  if (hours < 1) return { text: `${Math.floor(mins)}m ago`, cls: "text-emerald-400" };
  if (hours < 24) return { text: `${Math.floor(hours)}h ago`, cls: "text-slate-300" };
  if (days < 7) return { text: `${Math.floor(days)}d ago`, cls: "text-amber-400" };
  return { text: `${Math.floor(days)}d ago`, cls: "text-red-400" };
};

const getAssignmentBadge = (device: Device) => {
  const source =
    device.resolved_assignment_source || device.assignment_source || "unassigned";
  if (source === "enrollment_token")
    return (
      <Badge variant="ghost" className={subtleBadgeClass} title="Enrollment token assignment">
        token
      </Badge>
    );
  if (source === "manual" || source === "legacy_manual")
    return (
      <Badge variant="ghost" className={subtleBadgeClass} title="Manual assignment">
        manual
      </Badge>
    );
  if (source === "trusted_domain")
    return (
      <Badge variant="ghost" className={subtleBadgeClass} title="Domain assignment">
        domain
      </Badge>
    );
  if (source === "auto_os" || source === "system_auto")
    return (
      <Badge variant="ghost" className={subtleBadgeClass} title="Auto assigned from domain">
        auto
      </Badge>
    );
  return (
    <Badge variant="ghost" className={subtleBadgeClass} title="Unassigned">
      unassigned
    </Badge>
  );
};

const getUserSourceBadge = (device: Device) => {
  if (
    !device.user_source ||
    device.user_source === "no_interactive_user" ||
    device.user_source === "fallback"
  )
    return null;
  const label = device.user_source === "rdp_session" ? "rdp" : "con";
  const cls =
    device.user_source === "rdp_session"
      ? `border-purple-400/25 bg-purple-400/[0.08] text-purple-300 ${compactBadgeClass}`
      : `border-sky-400/25 bg-sky-400/[0.08] text-sky-300 ${compactBadgeClass}`;
  const stateLabel =
    device.user_session_state && device.user_session_state !== "unknown"
      ? ` · ${device.user_session_state}`
      : "";
  return (
    <Badge variant="ghost" className={cls} title={`${device.user_source}${stateLabel}`}>
      {label}
    </Badge>
  );
};

const getPatchBadge = (patch?: PatchStatus) => {
  const state = patch?.patch_state ?? "unknown";
  if (state === "up_to_date")
    return (
      <Badge variant="ghost" className={subtleBadgeClass}>
        patched
      </Badge>
    );
  if (state === "reboot_required")
    return (
      <Badge
        variant="ghost"
        className={`border-red-400/20 bg-red-400/[0.06] text-red-300 ${compactBadgeClass}`}
      >
        reboot
      </Badge>
    );
  if (state === "updates_available") {
    const count = patch?.pending_updates ?? 0;
    return (
      <Badge
        variant="ghost"
        className={`border-amber-400/20 bg-amber-400/[0.06] text-amber-300 ${compactBadgeClass}`}
      >
        {count > 0 ? `${count} upd` : "updates"}
      </Badge>
    );
  }
  return null; // skip "patch unknown" to reduce noise
};

const isSuggestedArchive = (device: Device) => {
  if (device.is_archived || device.freshness_state !== "offline" || !device.last_seen)
    return false;
  const diffDays =
    (Date.now() - parseUTC(device.last_seen).getTime()) / (1000 * 60 * 60 * 24);
  return diffDays > 30;
};

const getMaintenanceBadge = (device: Device) => {
  if (!device.is_in_maintenance) return null;
  const title = device.maintenance_ends_at
    ? `In maintenance until ${parseUTC(device.maintenance_ends_at).toLocaleString()}`
    : device.maintenance_note
    ? `In maintenance: ${device.maintenance_note}`
    : "In maintenance";
  return (
    <Badge
      variant="ghost"
      className={`border-sky-400/30 bg-sky-400/10 text-sky-200 ${compactBadgeClass}`}
      title={title}
    >
      <Wrench className="mr-0.5 inline h-2 w-2" />
      maint.
    </Badge>
  );
};

const getDuplicateBadge = (device: Device) => {
  if (!device.duplicate_candidate) return null;
  const scoreLabel =
    device.duplicate_score != null ? ` ${Math.round(device.duplicate_score * 100)}%` : "";
  return (
    <Badge
      variant="ghost"
      className={`border-amber-400/30 bg-amber-400/10 text-amber-200 ${compactBadgeClass}`}
      title={
        device.duplicate_of_device_id
          ? `Possible duplicate of Device #${device.duplicate_of_device_id} (similarity${scoreLabel})`
          : "Possible duplicate detected"
      }
    >
      <AlertTriangle className="mr-0.5 inline h-2 w-2" />
      dupe
    </Badge>
  );
};

const getLifecycleSignals = (device: Device) => (
  <>
    {device.is_archived && (
      <Badge
        variant="neutral"
        className={compactBadgeClass}
        title={
          device.archived_at
            ? `Archived ${parseUTC(device.archived_at).toLocaleString()}`
            : "Archived device"
        }
      >
        archived
      </Badge>
    )}
    {device.is_archived && device.freshness_state !== "offline" && (
      <Badge
        variant="ghost"
        className={`border-orange-400/30 bg-orange-400/10 text-orange-200 ${compactBadgeClass}`}
        title="This archived device is still sending heartbeats"
      >
        checked in
      </Badge>
    )}
    {isSuggestedArchive(device) && (
      <Badge
        variant="ghost"
        className={`border-amber-300/25 bg-amber-300/10 text-amber-100 ${compactBadgeClass}`}
        title="Offline for more than 30 days"
      >
        archive?
      </Badge>
    )}
    {getMaintenanceBadge(device)}
    {getDuplicateBadge(device)}
  </>
);

// ─── Main component ───────────────────────────────────────────────────────────

const DevicesTable = memo(function DevicesTable({
  devices,
  loading,
  error,
  filters,
  searchQuery,
  onSearch,
  onFilterChange,
  onRefresh,
  onDeviceSelect,
  onDeviceDelete,
  onDeviceArchive,
  onDeviceRestore,
  healthMap = {},
  patchMap = {},
  activeActionMap = {},
  alertsMap = {},
  canOperate = false,
  canDelete = false,
  currentUser,
  onBulkComplete,
  favorites = new Set<number>(),
  onToggleFavorite,
  quickFilter,
  onQuickFilterChange,
  scopedDeviceCount,
  tableLoading = false,
  page = 1,
  limit = 20,
  total = 0,
  onPageChange,
  onLimitChange,
}: DevicesTableProps) {
  const [openActionDeviceId, setOpenActionDeviceId] = useState<number | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const [pendingAction, setPendingAction] = useState<{ type: PendingAction; device: Device } | null>(null);
  type SortKey = "hostname" | "client_name" | "last_seen";
  const [sortKey, setSortKey] = useState<SortKey>("hostname");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const applyQuickFilter = (f: QuickFilter) => {
    onQuickFilterChange(f === quickFilter ? "all" : f);
  };
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // Bulk action state
  type BulkActionType = "restart_device" | "restart_agent" | "sync_rustdesk" | "reinstall_rustdesk" | "maintenance_enter" | "maintenance_exit";
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [pendingBulkAction, setPendingBulkAction] = useState<{ action: BulkActionType; destructive: boolean } | null>(null);
  const [bulkMaintMinutes, setBulkMaintMinutes] = useState<number | null>(60);
  const [bulkToast, setBulkToast] = useState<{ message: string; ok: boolean } | null>(null);
  const bulkToastTimer = useRef<number | undefined>();
  const showBulkToast = (message: string, ok: boolean) => {
    setBulkToast({ message, ok });
    window.clearTimeout(bulkToastTimer.current);
    bulkToastTimer.current = window.setTimeout(() => setBulkToast(null), 4000);
  };
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollPositionRef = useRef({ left: 0, top: 0 });

  // Reset selection when device list changes (e.g. filter applied from parent)
  useEffect(() => { setSelectedIds(new Set()); }, [devices]);

  // Per-pill counts (computed from the unfiltered devices prop)
  const pillCounts = useMemo(() => {
    const counts: Record<QuickFilter, number> = Object.fromEntries(
      QUICK_FILTERS.map(({ id }) => [id, 0])
    ) as Record<QuickFilter, number>;
    counts.all = devices.length;
    for (const d of devices) {
      const health = healthMap[d.id];
      const patch = patchMap[d.id];
      if (d.freshness_state === "online") counts.online++;
      if (d.freshness_state === "stale") counts.stale++;
      if (d.freshness_state === "offline") counts.offline++;
      if (d.device_type === "server" || d.resolved_device_category === "servers") counts.servers++;
      if (d.device_type === "client" || d.resolved_device_category === "clientpc") counts.workstations++;
      if (patch?.patch_state === "updates_available") counts.needs_updates++;
      if (patch?.patch_state === "reboot_required") counts.reboot_required++;
      if (health?.health_state === "healthy") counts.healthy++;
      if (health?.health_state === "warning") counts.warnings++;
      if (health?.health_state === "critical") counts.critical++;
      if (d.is_in_maintenance) counts.maintenance++;
      if (d.freshness_state !== "online" || (alertsMap[d.id]?.critical ?? 0) > 0 || (health?.health_score ?? 100) < 60) counts.needs_attention++;
      if ((health?.health_score ?? 100) < 60) counts.low_health++;
      if (d.rustdesk_install_status !== "not_installed" && (d.rustdesk_status ?? "") !== "running") counts.rustdesk_issues++;
      if (favorites.has(d.id)) counts.favorites++;
    }
    return counts;
  }, [devices, patchMap, healthMap, alertsMap, favorites]);

  // Apply quick filter on top of the parent-filtered list, then sort
  const displayDevices = useMemo(() => {
    const filtered = quickFilter === "all" ? devices : devices.filter(d => {
      switch (quickFilter) {
        case "online":          return d.freshness_state === "online";
        case "stale":           return d.freshness_state === "stale";
        case "offline":         return d.freshness_state === "offline";
        case "servers":         return d.device_type === "server" || d.resolved_device_category === "servers";
        case "workstations":    return d.device_type === "client" || d.resolved_device_category === "clientpc";
        case "needs_updates":   return patchMap[d.id]?.patch_state === "updates_available";
        case "reboot_required": return patchMap[d.id]?.patch_state === "reboot_required";
        case "warnings":        return healthMap[d.id]?.health_state === "warning";
        case "critical":        return healthMap[d.id]?.health_state === "critical";
        case "healthy":         return healthMap[d.id]?.health_state === "healthy";
        case "maintenance":     return d.is_in_maintenance === true;
        case "needs_attention": return (
          d.freshness_state !== "online" ||
          (alertsMap[d.id]?.critical ?? 0) > 0 ||
          (healthMap[d.id]?.health_score ?? 100) < 60
        );
        case "low_health":      return (healthMap[d.id]?.health_score ?? 100) < 60;
        case "rustdesk_issues": return (
          d.rustdesk_install_status !== "not_installed" &&
          (d.rustdesk_status ?? "") !== "running"
        );
        case "favorites":       return favorites.has(d.id);
        default:                return true;
      }
    });
    return [...filtered].sort((a, b) => {
      let cmp: number;
      if (sortKey === "hostname") {
        cmp = (a.hostname ?? "").localeCompare(b.hostname ?? "");
      } else if (sortKey === "client_name") {
        cmp = (a.client_name ?? "").localeCompare(b.client_name ?? "");
      } else {
        cmp = (a.last_seen ?? "").localeCompare(b.last_seen ?? "");
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [devices, quickFilter, patchMap, healthMap, alertsMap, favorites, sortKey, sortDir]);

  const offlineSummaryByClient = useMemo(() => {
    const summaries = new Map<number, ClientOfflineSummary>();
    for (const device of devices) {
      if (!device.client_id) continue;
      const freshness = device.freshness_state ?? device.status;
      const summary = summaries.get(device.client_id) ?? { offlineCount: 0, inactiveLastSeen: [] };
      if (freshness === "offline") summary.offlineCount += 1;
      if ((freshness === "offline" || freshness === "stale") && device.last_seen) {
        summary.inactiveLastSeen.push(new Date(device.last_seen).getTime());
      }
      summaries.set(device.client_id, summary);
    }
    return summaries;
  }, [devices]);

  const allSelected = displayDevices.length > 0 && displayDevices.every(d => selectedIds.has(d.id));
  const someSelected = !allSelected && displayDevices.some(d => selectedIds.has(d.id));
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(displayDevices.map(d => d.id)));
  const toggleOne = (id: number) => setSelectedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollLeft = scrollPositionRef.current.left;
    node.scrollTop = scrollPositionRef.current.top;
  }, [devices]);

  useEffect(() => {
    if (openActionDeviceId === null) return;
    const closeMenu = () => {
      setOpenActionDeviceId(null);
      setMenuAnchor(null);
    };
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-action-menu]") && !target.closest("[data-action-trigger]")) {
        closeMenu();
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    window.addEventListener("resize", closeMenu);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
      window.removeEventListener("resize", closeMenu);
    };
  }, [openActionDeviceId]);

  const activeActionDevice =
    openActionDeviceId !== null
      ? displayDevices.find((d) => d.id === openActionDeviceId) ?? devices.find((d) => d.id === openActionDeviceId) ?? null
      : null;

  const getMenuAnchor = (trigger: HTMLElement) => {
    const rect = trigger.getBoundingClientRect();
    const availableBelow = window.innerHeight - rect.bottom - ACTION_MENU_MARGIN;
    const opensUp =
      availableBelow < ACTION_MENU_MAX_HEIGHT && rect.top > availableBelow;
    const top = opensUp
      ? Math.max(
          ACTION_MENU_MARGIN,
          rect.top - ACTION_MENU_MAX_HEIGHT - ACTION_MENU_GAP
        )
      : Math.max(
          ACTION_MENU_MARGIN,
          Math.min(
            rect.bottom + ACTION_MENU_GAP,
            window.innerHeight - ACTION_MENU_MAX_HEIGHT - ACTION_MENU_MARGIN
          )
        );
    const preferredLeft = rect.right - ACTION_MENU_WIDTH;
    const left = Math.min(
      Math.max(ACTION_MENU_MARGIN, preferredLeft),
      window.innerWidth - ACTION_MENU_WIDTH - ACTION_MENU_MARGIN
    );
    return { top, left };
  };

  const confirmAction = () => {
    if (!pendingAction) return;
    if (pendingAction.type === "archive") onDeviceArchive?.(pendingAction.device);
    if (pendingAction.type === "restore") onDeviceRestore?.(pendingAction.device);
    if (pendingAction.type === "delete") onDeviceDelete?.(pendingAction.device);
    setPendingAction(null);
  };

  return (
    <div className="space-y-2.5">
      {/* Filter bar */}
      {/* ── Fleet Health Panel ── */}
      {devices.length > 0 && (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {([
          {
            id: "needs_updates" as QuickFilter,
            label: "Updates",
            count: pillCounts.needs_updates,
            color: "#fbbf24", bg: "rgba(251,191,36,0.1)", border: "rgba(251,191,36,0.25)",
          },
          {
            id: "reboot_required" as QuickFilter,
            label: "Reboot",
            count: pillCounts.reboot_required,
            color: "#f87171", bg: "rgba(248,113,113,0.1)", border: "rgba(248,113,113,0.25)",
          },
          {
            id: "offline" as QuickFilter,
            label: "Offline >24h",
            count: devices.filter(d => {
              if (d.freshness_state !== "offline" || !d.last_seen) return false;
              return (Date.now() - new Date(d.last_seen).getTime()) > 86_400_000;
            }).length,
            color: "#94a3b8", bg: "rgba(148,163,184,0.08)", border: "rgba(148,163,184,0.2)",
          },
          {
            id: "maintenance" as QuickFilter,
            label: "Maintenance",
            count: pillCounts.maintenance,
            color: "#38bdf8", bg: "rgba(56,189,248,0.1)", border: "rgba(56,189,248,0.25)",
          },
          {
            id: "rustdesk_issues" as QuickFilter,
            label: "RS Issues",
            count: pillCounts.rustdesk_issues,
            color: "#f97316", bg: "rgba(249,115,22,0.1)", border: "rgba(249,115,22,0.25)",
          },
          {
            id: "low_health" as QuickFilter,
            label: "Health <60",
            count: pillCounts.low_health,
            color: "#f87171", bg: "rgba(248,113,113,0.1)", border: "rgba(248,113,113,0.25)",
          },
        ] as const).map(card => (
          <button
            key={card.id}
            type="button"
            onClick={() => applyQuickFilter(quickFilter === card.id ? "all" : card.id)}
            className="rounded-xl px-3 py-2.5 text-left transition-all hover:opacity-90"
            style={{
              background: quickFilter === card.id ? card.bg : "var(--th-bg-card)",
              border: `1px solid ${quickFilter === card.id ? card.border : "var(--th-border-card)"}`,
            }}
          >
            <p className="text-2xl font-bold tabular-nums" style={{ color: card.count > 0 ? card.color : "var(--th-text-muted)" }}>
              {card.count}
            </p>
            <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>
              {card.label}
            </p>
          </button>
        ))}
      </div>
      )}

      {/* ── Bulk Action Bar ── */}
      {selectedIds.size > 0 && canOperate && (
      <div
        className="flex flex-wrap items-center gap-2 rounded-xl px-4 py-3"
        style={{ background: "rgba(249,115,22,0.08)", border: "1px solid rgba(249,115,22,0.25)" }}
      >
        <span className="text-sm font-semibold" style={{ color: "#fb923c" }}>
          {selectedIds.size} device{selectedIds.size !== 1 ? "s" : ""} selected
        </span>
        <div className="ml-2 flex flex-wrap gap-1.5">
          {([
            { label: "Restart Device",    action: "restart_device"   as const, destructive: true  },
            { label: "Restart Agent",     action: "restart_agent"    as const, destructive: true  },
            { label: "Sync RS",           action: "sync_rustdesk"    as const, destructive: false },
            { label: "Reinstall RS",      action: "reinstall_rustdesk" as const, destructive: true },
          ] as const).map(btn => (
            <button
              key={btn.action}
              type="button"
              disabled={bulkBusy}
              onClick={() => {
                setPendingBulkAction({ action: btn.action, destructive: btn.destructive });
                setBulkConfirmOpen(true);
              }}
              className="rounded-md px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-40"
              style={{
                background: btn.destructive ? "rgba(248,113,113,0.12)" : "rgba(255,255,255,0.05)",
                border: `1px solid ${btn.destructive ? "rgba(248,113,113,0.3)" : "rgba(255,255,255,0.12)"}`,
                color: btn.destructive ? "#f87171" : "var(--th-text-secondary)",
              }}
            >
              {btn.label}
            </button>
          ))}
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => { setPendingBulkAction({ action: "maintenance_enter", destructive: false }); setBulkConfirmOpen(true); }}
            className="rounded-md px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-40"
            style={{ background: "rgba(56,189,248,0.1)", border: "1px solid rgba(56,189,248,0.25)", color: "#38bdf8" }}
          >
            Enter Maintenance
          </button>
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => { setPendingBulkAction({ action: "maintenance_exit", destructive: false }); setBulkConfirmOpen(true); }}
            className="rounded-md px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-40"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "var(--th-text-secondary)" }}
          >
            Exit Maintenance
          </button>
        </div>
        <button
          type="button"
          onClick={() => setSelectedIds(new Set())}
          className="ml-auto text-[11px] font-medium transition hover:opacity-70"
          style={{ color: "var(--th-text-muted)" }}
        >
          Clear
        </button>
      </div>
      )}

      <div
        className="rounded-xl p-3"
        style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: "var(--th-text-primary)" }}>
              Devices catalog
            </h2>
            <p className="mt-0.5 text-xs" style={{ color: "var(--th-text-muted)" }}>
              Full device roster for all managed clients.
            </p>
          </div>
          <Button size="sm" onClick={onRefresh}>
            Refresh list
          </Button>
        </div>

        {/* Quick filter pills */}
        <div className="mt-2.5 flex flex-wrap gap-1">
          {QUICK_FILTERS.map(f => {
            const count = pillCounts[f.id];
            const active = quickFilter === f.id;
            const hasAlert = (f.id === "critical" || f.id === "needs_attention") && count > 0;
            const hasWarn  = (f.id === "warnings" || f.id === "low_health" || f.id === "rustdesk_issues") && count > 0;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => applyQuickFilter(f.id)}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-all"
                style={{
                  background: active
                    ? hasAlert ? "rgba(248,113,113,0.18)"
                    : hasWarn  ? "rgba(251,191,36,0.15)"
                    : "rgba(249,115,22,0.18)"
                    : "rgba(255,255,255,0.04)",
                  border: `1px solid ${active
                    ? hasAlert ? "rgba(248,113,113,0.4)"
                    : hasWarn  ? "rgba(251,191,36,0.35)"
                    : "rgba(249,115,22,0.35)"
                    : "rgba(255,255,255,0.08)"}`,
                  color: active
                    ? hasAlert ? "#f87171"
                    : hasWarn  ? "#fbbf24"
                    : "#fb923c"
                    : count === 0 ? "var(--th-text-muted)" : "var(--th-text-secondary)",
                  opacity: count === 0 && f.id !== "all" ? 0.45 : 1,
                }}
              >
                {f.label}
                {f.id !== "all" && (
                  <span className="rounded-full px-1 text-[9px] font-bold tabular-nums"
                    style={{ background: "rgba(255,255,255,0.08)" }}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-2 grid gap-1.5 lg:grid-cols-[1.6fr_1fr] xl:grid-cols-[2fr_1fr_1fr_1fr_1fr]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search hostname, user, domain or IP..."
              className={`${FILTER_INPUT_CLS} w-full py-1.5 pl-9 pr-3`}
            />
          </div>
          <select
            value={filters.freshness_state || "all"}
            onChange={(e) => onFilterChange("freshness_state", e.target.value)}
            className={FILTER_INPUT_CLS}
            aria-label="Filter by device status"
          >
            <option value="all">All statuses</option>
            <option value="online">Online</option>
            <option value="stale">Stale</option>
            <option value="offline">Offline</option>
          </select>
          <select
            value={["healthy", "warnings", "critical"].includes(quickFilter) ? quickFilter : "all"}
            onChange={(e) => onQuickFilterChange(e.target.value as QuickFilter)}
            className={FILTER_INPUT_CLS}
            aria-label="Filter by health"
          >
            <option value="all">All health</option>
            <option value="healthy">Healthy</option>
            <option value="warnings">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <select
            value={filters.lifecycle_state || "active"}
            onChange={(e) => onFilterChange("lifecycle_state", e.target.value)}
            className={FILTER_INPUT_CLS}
            aria-label="Filter by lifecycle state"
          >
            <option value="active">Active devices</option>
            <option value="archived">Archived devices</option>
            <option value="all">All devices</option>
          </select>
          <select
            value={
              filters.duplicate_candidates
                ? "duplicate"
                : filters.maintenance_state || "all"
            }
            onChange={(e) => {
              const value = e.target.value;
              if (value === "duplicate") {
                onFilterChange("maintenance_state", undefined);
                onFilterChange("duplicate_candidates", true);
                return;
              }
              onFilterChange("duplicate_candidates", undefined);
              onFilterChange(
                "maintenance_state",
                value === "all" ? undefined : value
              );
            }}
            className={FILTER_INPUT_CLS}
            aria-label="Filter by maintenance state"
          >
            <option value="all">All signals</option>
            <option value="maintenance">In maintenance</option>
            <option value="normal">Normal only</option>
            <option value="duplicate">Duplicates only</option>
          </select>
        </div>
      </div>

      {/* States */}
      {loading ? (
        <div className="premium-card-soft overflow-hidden">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b px-4 py-3 animate-pulse"
              style={{ borderColor: "var(--th-border-subtle)", opacity: 1 - i * 0.09 }}
            >
              <div className="h-2 w-2 flex-none rounded-full bg-slate-700" />
              <div className="h-3 w-32 rounded bg-slate-700/80" />
              <div className="h-3 w-20 rounded bg-slate-700/60 ml-4" />
              <div className="h-3 w-24 rounded bg-slate-700/50 ml-auto" />
              <div className="h-3 w-16 rounded bg-slate-700/40" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="premium-card-soft py-12 text-center">
          <p className="text-[15px] font-semibold text-white">Unable to load devices</p>
          <p className="mt-1 text-[13px] text-red-300">{error}</p>
          <Button onClick={onRefresh} size="sm" className="mt-4">
            Try again
          </Button>
        </div>
      ) : devices.length === 0 ? (
        <div className="premium-card-soft flex flex-col items-center gap-3 py-14 text-center">
          <ServerOff className="h-8 w-8 text-slate-600" />
          <div>
            <p className="text-[15px] font-semibold text-slate-200">No devices found</p>
            <p className="mt-1 text-[13px] text-slate-500">
              Adjust filters or search terms to reveal devices.
            </p>
          </div>
        </div>
      ) : (
        <div
          className="overflow-hidden rounded-xl"
          style={{ border: "1px solid var(--th-border-card)", background: "var(--th-bg-card)" }}
        >
          <div
            ref={scrollRef}
            className="overflow-x-auto"
            onScroll={(event) => {
              scrollPositionRef.current = {
                left: event.currentTarget.scrollLeft,
                top: event.currentTarget.scrollTop,
              };
              if (openActionDeviceId !== null) {
                setOpenActionDeviceId(null);
                setMenuAnchor(null);
              }
            }}
          >
            <table className="min-w-[960px] w-full border-separate border-spacing-0 text-left">
              {/* ── Header ── */}
              <thead>
                <tr style={{ background: "var(--th-bg-table-head, rgba(255,255,255,0.025))", borderBottom: "1px solid var(--th-border-subtle)" }}>
                  {/* Checkbox */}
                  <th className="w-[36px] px-2 py-2" style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => { if (el) el.indeterminate = someSelected; }}
                      onChange={toggleAll}
                      className="h-3.5 w-3.5 cursor-pointer rounded accent-orange-500"
                      title="Select all"
                    />
                  </th>
                  {[
                    { label: "St",            w: "w-[52px]",  sortable: null },
                    { label: "Hostname",                       sortable: "hostname" as SortKey },
                    { label: "Client / Group",                 sortable: "client_name" as SortKey },
                    { label: "User",                           sortable: null },
                    { label: "Domain",                         sortable: null },
                    { label: "IP",                             sortable: null },
                    { label: "OS",                             sortable: null },
                    { label: "Last Seen",                      sortable: "last_seen" as SortKey },
                    { label: "Actions",                        sortable: null },
                  ].map(({ label, w, sortable }) => (
                    <th
                      key={label}
                      className={`px-2.5 py-2 text-left text-[9px] font-semibold uppercase tracking-[0.1em] ${w ?? ""} ${sortable ? "cursor-pointer select-none hover:text-slate-200" : ""}`}
                      style={{ color: sortable && sortKey === sortable ? "var(--th-text-primary, #e2e8f0)" : "var(--th-text-muted)", borderBottom: "1px solid var(--th-border-subtle)" }}
                      onClick={sortable ? () => handleSort(sortable) : undefined}
                    >
                      <span className="inline-flex items-center gap-1">
                        {label}
                        {sortable && sortKey === sortable && (
                          <span className="text-[8px] opacity-70">{sortDir === "asc" ? "▲" : "▼"}</span>
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>

              {/* ── Rows ── */}
              <tbody>
                {displayDevices.map((device, rowIdx) => {
                  const health = healthMap[device.id];
                  const ls = getLastSeenDisplay(device.last_seen);
                  const canConnect =
                    isValidRustDeskId(device.rustdesk_id) &&
                    !device.rustdesk_conflict_detected;
                  const devAlerts = alertsMap[device.id];
                  const offlineBadge = getOfflineReasonBadge(
                    device,
                    device.client_id ? offlineSummaryByClient.get(device.client_id) : undefined,
                  );
                  const healthScore = healthMap[device.id]?.health_score;
                  const isLowHealth = healthScore != null && healthScore < 60;
                  const rsIssue =
                    device.rustdesk_install_status !== "not_installed" &&
                    (device.rustdesk_status ?? "") !== "running";

                  return (
                    <tr
                      key={device.id}
                      className="group cursor-pointer transition-colors duration-75"
                      style={{
                        background: rowIdx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.008)",
                        borderBottom: "1px solid var(--th-border-subtle)",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.028)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = rowIdx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.008)")}
                      onClick={() => onDeviceSelect?.(device)}
                    >
                      {/* ── Checkbox ── */}
                      <td className="w-[36px] px-2 py-1.5 align-middle" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(device.id)}
                          onChange={() => toggleOne(device.id)}
                          aria-label={`Select ${device.hostname}`}
                          className="h-3.5 w-3.5 cursor-pointer rounded accent-orange-500"
                        />
                      </td>

                      {/* ── Status + Health ── */}
                      <td className="w-[52px] px-2 py-1.5 align-middle">
                        <div className="flex items-center justify-center gap-1">
                          {renderStatusCell(device, health)}
                          {activeActionMap[device.id] && (
                            <ActionIndicator entry={activeActionMap[device.id]} />
                          )}
                        </div>
                      </td>

                      {/* ── Hostname ── */}
                      <td className="px-2.5 py-1.5 align-middle">
                        <div
                          className="max-w-[180px] truncate text-[12px] font-bold leading-[1.3]"
                          style={{ color: "var(--th-text-primary)" }}
                          title={device.hostname || "Unknown"}
                        >
                          {device.hostname || "Unknown"}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-0.5">
                          {getDeviceTypeBadge(device)}
                          {getPatchBadge(patchMap[device.id])}
                          {getLifecycleSignals(device)}
                          {devAlerts?.critical ? (
                            <span className="inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-bold tabular-nums"
                              style={{ color: "#f87171", background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.22)" }}>
                              <span className="h-1.5 w-1.5 rounded-full bg-red-400" style={{ boxShadow: "0 0 3px rgba(248,113,113,0.7)" }} />
                              {devAlerts.critical}
                            </span>
                          ) : null}
                          {devAlerts?.warning ? (
                            <span className="inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-bold tabular-nums"
                              style={{ color: "#fbbf24", background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.22)" }}>
                              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                              {devAlerts.warning}
                            </span>
                          ) : null}
                          {offlineBadge && (
                            <span
                              className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-semibold"
                              style={{
                                color: offlineBadge.color,
                                background: offlineBadge.bg,
                                border: `1px solid ${offlineBadge.border}`,
                              }}
                              title="Offline reason (inferred)"
                            >
                              {offlineBadge.label}
                            </span>
                          )}
                          {isLowHealth && (
                            <span className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-bold"
                              style={{ color: "#f87171", background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.22)" }}
                              title={`Health score: ${healthScore}`}>
                              H:{healthScore}
                            </span>
                          )}
                          {rsIssue && !offlineBadge && (
                            <span className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-semibold"
                              style={{ color: "#f97316", background: "rgba(249,115,22,0.1)", border: "1px solid rgba(249,115,22,0.22)" }}
                              title={`RS: ${device.rustdesk_status}`}>
                              RS
                            </span>
                          )}
                        </div>
                      </td>

                      {/* ── Client / Group ── */}
                      <td className="px-2.5 py-1.5 align-middle">
                        <div
                          className="max-w-[160px] truncate text-[12px] font-semibold leading-[1.3]"
                          style={{ color: "var(--th-text-primary)" }}
                          title={device.client_name || "No client"}
                        >
                          {device.client_name || (
                            <span style={{ color: "var(--th-text-muted)" }}>No client</span>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1">
                          <span
                            className="max-w-[130px] truncate text-[9px] font-medium leading-3"
                            style={{ color: "var(--th-text-muted)" }}
                          >
                            {device.group_name || "No group"}
                          </span>
                          {getAssignmentBadge(device)}
                        </div>
                      </td>

                      {/* ── User ── */}
                      <td className="whitespace-nowrap px-2.5 py-1.5 align-middle">
                        <div className="flex items-center gap-1">
                          <span
                            className="max-w-[120px] truncate text-[11px] font-medium"
                            style={{ color: "var(--th-text-secondary)" }}
                          >
                            {device.current_user || "—"}
                          </span>
                          {getUserSourceBadge(device)}
                        </div>
                      </td>

                      {/* ── Domain ── */}
                      <td
                        className="whitespace-nowrap px-2.5 py-1.5 align-middle text-[11px] font-medium"
                        style={{ color: "var(--th-text-secondary)" }}
                      >
                        {device.domain || "—"}
                      </td>

                      {/* ── IP (public + local stacked) ── */}
                      <td className="whitespace-nowrap px-2.5 py-1.5 align-middle">
                        <div className="font-mono text-[10px]" style={{ color: "var(--th-text-secondary)" }}>
                          {device.public_ip || "—"}
                        </div>
                        {device.local_ip && (
                          <div className="font-mono text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                            {device.local_ip}
                          </div>
                        )}
                      </td>

                      {/* ── OS ── */}
                      <td
                        className="max-w-[120px] truncate px-2.5 py-1.5 align-middle text-[10px] font-medium"
                        style={{ color: "var(--th-text-muted)" }}
                        title={device.os_name || "—"}
                      >
                        {device.os_name || "—"}
                      </td>

                      {/* ── Last Seen ── */}
                      <td className="whitespace-nowrap px-2.5 py-1.5 align-middle">
                        <span className={`text-[11px] font-semibold tabular-nums ${ls.cls}`}>
                          {ls.text}
                        </span>
                      </td>

                      {/* ── Actions ── */}
                      <td
                        className="px-2 py-1.5 align-middle"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center gap-1.5">
                          {/* Star / favourite */}
                          {onToggleFavorite && (
                            <button
                              type="button"
                              onClick={() => onToggleFavorite(device.id)}
                              title={favorites.has(device.id) ? "Remove from favorites" : "Add to favorites"}
                              className="flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors"
                              style={{ color: favorites.has(device.id) ? "#fbbf24" : "var(--th-text-muted)" }}
                            >
                              <Star className={`h-3 w-3 ${favorites.has(device.id) ? "fill-current" : ""}`} />
                            </button>
                          )}
                          {/* Connect button — styled like RS page */}
                          <button
                            type="button"
                            disabled={!canConnect}
                            onClick={() => launchRustDesk(device.rustdesk_id)}
                            title={
                              device.rustdesk_conflict_detected
                                ? "Remote Support ID conflict"
                                : canConnect
                                ? "Open TECHI Remote Support"
                                : "Remote ID not resolved yet"
                            }
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-all"
                            style={{
                              background: canConnect
                                ? "rgba(249,115,22,0.15)"
                                : "rgba(255,255,255,0.03)",
                              border: `1px solid ${
                                canConnect
                                  ? "rgba(249,115,22,0.3)"
                                  : "var(--th-border-subtle)"
                              }`,
                              color: canConnect ? "#f97316" : "var(--th-text-muted)",
                              cursor: canConnect ? "pointer" : "not-allowed",
                              opacity: canConnect ? 1 : 0.45,
                            }}
                          >
                            <ExternalLink className="h-3 w-3" />
                            Connect
                          </button>

                          {canOperate && (
                            <button
                              type="button"
                              data-action-trigger="true"
                              className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors"
                              style={{
                                border: "1px solid var(--th-border-subtle)",
                                background: "rgba(255,255,255,0.03)",
                                color: "var(--th-text-muted)",
                              }}
                              onMouseEnter={(e) => {
                                (e.currentTarget as HTMLElement).style.background =
                                  "rgba(255,255,255,0.07)";
                                (e.currentTarget as HTMLElement).style.color =
                                  "var(--th-text-secondary)";
                              }}
                              onMouseLeave={(e) => {
                                (e.currentTarget as HTMLElement).style.background =
                                  "rgba(255,255,255,0.03)";
                                (e.currentTarget as HTMLElement).style.color =
                                  "var(--th-text-muted)";
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (openActionDeviceId === device.id) {
                                  setOpenActionDeviceId(null);
                                  setMenuAnchor(null);
                                } else {
                                  setMenuAnchor(getMenuAnchor(e.currentTarget));
                                  setOpenActionDeviceId(device.id);
                                }
                              }}
                              title="More actions"
                            >
                              <MoreHorizontal className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5"
            style={{
              borderTop: "1px solid var(--th-border-subtle)",
              background: "var(--th-bg-table-head, rgba(255,255,255,0.02))",
            }}
          >
            {/* Left: count + page size + loading */}
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[11px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                {total > 0
                  ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total} devices`
                  : `${displayDevices.length} devices`}
                {selectedIds.size > 0 && (
                  <span className="ml-2 font-semibold" style={{ color: "#fb923c" }}>
                    · {selectedIds.size} selected
                  </span>
                )}
              </span>
              {total > 0 && (
                <select
                  value={limit}
                  onChange={(e) => onLimitChange?.(Number(e.target.value))}
                  aria-label="Rows per page"
                  className="rounded border px-2 py-0.5 text-[11px] font-medium focus:outline-none"
                  style={{
                    borderColor: "var(--th-border-subtle)",
                    background: "rgba(15,23,42,0.7)",
                    color: "var(--th-text-secondary)",
                  }}
                >
                  <option value={10}>10 / page</option>
                  <option value={20}>20 / page</option>
                  <option value={50}>50 / page</option>
                </select>
              )}
              {tableLoading && <Loader2 className="h-3 w-3 animate-spin text-orange-400/70" />}
            </div>

            {/* Right: pagination or Fleet active */}
            {total > limit ? (
              <PaginationControls
                page={page}
                total={total}
                limit={limit}
                onPageChange={onPageChange}
              />
            ) : (
              <span
                className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--th-text-muted)", opacity: 0.6 }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                  style={{ boxShadow: "0 0 4px rgba(52,211,153,0.5)" }}
                />
                Fleet active
              </span>
            )}
          </div>
        </div>
      )}

      {/* Portal action menu */}
      {activeActionDevice &&
        menuAnchor &&
        createPortal(
          <div
            data-action-menu="true"
            style={{ position: "fixed", top: menuAnchor.top, left: menuAnchor.left }}
            className="th-elevated z-[10000] max-h-[220px] w-48 overflow-y-auto rounded-lg border p-1 shadow-2xl"
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-semibold text-sky-100 transition hover:bg-sky-500/10"
              onClick={() => {
                setOpenActionDeviceId(null);
                setMenuAnchor(null);
                void queueDeviceAction(activeActionDevice.id, {
                  action_type: "ping",
                  created_by: currentUser ?? "unknown",
                });
              }}
            >
              <PlayCircle className="h-3.5 w-3.5" />
              Ping device
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-semibold text-slate-300 transition hover:bg-white/[0.05]"
              onClick={() => {
                setOpenActionDeviceId(null);
                setMenuAnchor(null);
                void queueDeviceAction(activeActionDevice.id, {
                  action_type: "refresh_inventory",
                  created_by: currentUser ?? "unknown",
                });
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Refresh inventory
            </button>
            {!activeActionDevice.is_archived ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-semibold text-amber-100 transition hover:bg-amber-500/10"
                onClick={() => {
                  setOpenActionDeviceId(null);
                  setMenuAnchor(null);
                  setPendingAction({ type: "archive", device: activeActionDevice });
                }}
              >
                <Archive className="h-3.5 w-3.5" />
                Archive device
              </button>
            ) : (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-semibold text-emerald-100 transition hover:bg-emerald-500/10"
                onClick={() => {
                  setOpenActionDeviceId(null);
                  setMenuAnchor(null);
                  setPendingAction({ type: "restore", device: activeActionDevice });
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Restore device
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-semibold text-red-200 transition hover:bg-red-500/10 hover:text-red-100"
                onClick={() => {
                  setOpenActionDeviceId(null);
                  setMenuAnchor(null);
                  setPendingAction({ type: "delete", device: activeActionDevice });
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove permanently
              </button>
            )}
          </div>,
          document.body
        )}

      {/* ── Bulk toast ── */}
      {bulkToast && (
        <div
          className="fixed right-4 top-4 z-[99999] rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg"
          style={{
            background: bulkToast.ok ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
            border: `1px solid ${bulkToast.ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
            color: bulkToast.ok ? "#22c55e" : "#ef4444",
          }}
        >
          {bulkToast.message}
        </div>
      )}

      {/* ── Bulk action confirmation modal ── */}
      {bulkConfirmOpen && pendingBulkAction && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
          onClick={() => !bulkBusy && setBulkConfirmOpen(false)}>
          <div className="w-full max-w-[380px] rounded-2xl shadow-2xl" onClick={e => e.stopPropagation()}
            style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}>
            <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
              <p className="text-sm font-bold" style={{ color: "var(--th-text-primary)" }}>
                {pendingBulkAction.action === "maintenance_enter" ? "Enter Maintenance" :
                 pendingBulkAction.action === "maintenance_exit" ? "Exit Maintenance" :
                 `Bulk: ${pendingBulkAction.action.replace(/_/g, " ")}`}
              </p>
              <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                Applies to {selectedIds.size} device{selectedIds.size !== 1 ? "s" : ""}.
              </p>
            </div>
            <div className="px-5 py-4">
              {pendingBulkAction.action === "maintenance_enter" && (
                <div className="mb-4">
                  <p className="mb-2 text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Duration</p>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { label: "1 hour",        mins: 60 },
                      { label: "4 hours",       mins: 240 },
                      { label: "8 hours",       mins: 480 },
                      { label: "Tomorrow",      mins: Math.round(((new Date(new Date().setHours(24,0,0,0)).getTime() - Date.now()) / 60000)) },
                      { label: "Indefinite",    mins: null },
                    ].map(opt => (
                      <button key={opt.label} type="button"
                        onClick={() => setBulkMaintMinutes(opt.mins)}
                        className="rounded-md px-2.5 py-1 text-[11px] font-semibold transition"
                        style={{
                          background: bulkMaintMinutes === opt.mins ? "rgba(56,189,248,0.15)" : "rgba(255,255,255,0.04)",
                          border: `1px solid ${bulkMaintMinutes === opt.mins ? "rgba(56,189,248,0.35)" : "rgba(255,255,255,0.1)"}`,
                          color: bulkMaintMinutes === opt.mins ? "#38bdf8" : "var(--th-text-secondary)",
                        }}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" disabled={bulkBusy}
                  onClick={() => setBulkConfirmOpen(false)}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid var(--th-border-subtle)", color: "var(--th-text-muted)" }}>
                  Cancel
                </button>
                <button type="button" disabled={bulkBusy}
                  onClick={async () => {
                    const action = pendingBulkAction.action;
                    const selectedDevices = devices.filter(d => selectedIds.has(d.id));
                    setBulkBusy(true);
                    let ok = 0; let fail = 0;
                    try {
                      for (const d of selectedDevices) {
                        try {
                          if (action === "maintenance_enter") {
                            await enterDeviceMaintenance(d.id, { duration_minutes: bulkMaintMinutes, started_by: currentUser ?? "operator" });
                          } else if (action === "maintenance_exit") {
                            await clearDeviceMaintenance(d.id);
                          } else {
                            await queueDeviceAction(d.id, { action_type: action as import("../api/actions").ActionType, created_by: currentUser ?? "operator" });
                          }
                          ok++;
                        } catch { fail++; }
                      }
                      showBulkToast(`${action.replace(/_/g," ")}: ${ok} queued${fail ? `, ${fail} failed` : ""}`, fail === 0);
                      setSelectedIds(new Set());
                      onBulkComplete?.();
                    } finally {
                      setBulkBusy(false);
                      setBulkConfirmOpen(false);
                    }
                  }}
                  className="rounded-lg px-4 py-1.5 text-xs font-semibold transition disabled:opacity-50"
                  style={{
                    background: pendingBulkAction.destructive ? "rgba(248,113,113,0.15)" : "rgba(249,115,22,0.15)",
                    border: `1px solid ${pendingBulkAction.destructive ? "rgba(248,113,113,0.35)" : "rgba(249,115,22,0.35)"}`,
                    color: pendingBulkAction.destructive ? "#f87171" : "#fb923c",
                  }}>
                  {bulkBusy ? "Processing…" : `Confirm (${selectedIds.size})`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {pendingAction && (
        <ConfirmDeviceAction
          type={pendingAction.type}
          device={pendingAction.device}
          onCancel={() => setPendingAction(null)}
          onConfirm={confirmAction}
        />
      )}
    </div>
  );
});

export default DevicesTable;

// ─── Sub-components ───────────────────────────────────────────────────────────

function PaginationControls({
  page,
  total,
  limit,
  onPageChange,
}: {
  page: number;
  total: number;
  limit: number;
  onPageChange?: (page: number) => void;
}) {
  const totalPages = Math.ceil(total / limit);

  const getPageNums = (): (number | null)[] => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const nums: (number | null)[] = [1];
    if (page > 3) nums.push(null);
    const lo = Math.max(2, page - 1);
    const hi = Math.min(totalPages - 1, page + 1);
    for (let p = lo; p <= hi; p++) nums.push(p);
    if (page < totalPages - 2) nums.push(null);
    nums.push(totalPages);
    return nums;
  };

  const btnBase: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "1.5rem",
    height: "1.5rem",
    borderRadius: "0.25rem",
    fontSize: "11px",
    fontWeight: 600,
    lineHeight: 1,
    padding: "0 4px",
    transition: "background 0.15s",
    cursor: "pointer",
  };

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPageChange?.(page - 1)}
        style={{
          ...btnBase,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid var(--th-border-subtle)",
          color: page <= 1 ? "var(--th-text-muted)" : "var(--th-text-secondary)",
          opacity: page <= 1 ? 0.4 : 1,
        }}
      >
        ‹
      </button>

      {getPageNums().map((p, i) =>
        p === null ? (
          <span key={`e-${i}`} className="px-1 text-[11px]" style={{ color: "var(--th-text-muted)" }}>
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            onClick={() => onPageChange?.(p)}
            style={{
              ...btnBase,
              background: p === page ? "rgba(249,115,22,0.18)" : "rgba(255,255,255,0.04)",
              border: `1px solid ${p === page ? "rgba(249,115,22,0.4)" : "var(--th-border-subtle)"}`,
              color: p === page ? "#fb923c" : "var(--th-text-secondary)",
            }}
          >
            {p}
          </button>
        )
      )}

      <button
        type="button"
        disabled={page >= totalPages}
        onClick={() => onPageChange?.(page + 1)}
        style={{
          ...btnBase,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid var(--th-border-subtle)",
          color: page >= totalPages ? "var(--th-text-muted)" : "var(--th-text-secondary)",
          opacity: page >= totalPages ? 0.4 : 1,
        }}
      >
        ›
      </button>
    </div>
  );
}

function ActionIndicator({ entry }: { entry: ActiveActionEntry }) {
  const isRunning = entry.status === "running";
  const isQueued =
    entry.status === "queued" ||
    entry.status === "sent" ||
    entry.status === "acknowledged";
  const title = `${entry.action_type.replace(/_/g, " ")} — ${entry.status}`;
  if (isRunning)
    return (
      <span title={title}>
        <Loader2 className="h-2.5 w-2.5 flex-none animate-spin text-sky-400" />
      </span>
    );
  if (isQueued)
    return (
      <span
        className="h-1.5 w-1.5 flex-none rounded-full bg-amber-400/80"
        title={title}
      />
    );
  return null;
}

function ConfirmDeviceAction({
  type,
  device,
  onCancel,
  onConfirm,
}: {
  type: PendingAction;
  device: Device;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isDelete = type === "delete";
  const title =
    type === "archive"
      ? "Archive device"
      : type === "restore"
      ? "Restore device"
      : "Remove permanently";
  const message =
    type === "archive"
      ? "Device will be removed from the active fleet. History is preserved."
      : type === "restore"
      ? "Device will be returned to the active fleet."
      : "This action cannot be undone.";
  const actionLabel =
    type === "archive"
      ? "Archive"
      : type === "restore"
      ? "Restore"
      : "Remove permanently";

  return (
    <ConfirmationModal
      title={title}
      confirmLabel={actionLabel}
      destructive={isDelete || type === "archive"}
      onClose={onCancel}
      onConfirm={onConfirm}
    >
      <p className="font-medium text-slate-200">{device.hostname || device.rustdesk_id}</p>
      <p className="mt-3">{message}</p>
    </ConfirmationModal>
  );
}
