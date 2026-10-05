import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Archive, AlertTriangle, ArrowUpDown, ExternalLink, Loader2, MoreHorizontal, PlayCircle, RotateCcw, Search, ServerOff, SlidersHorizontal, Star, Trash2, Wrench, X } from "lucide-react";
import { MobileSheet } from "./mobile/MobileSheet";
import { clearDeviceMaintenance, Device, DeviceFilters, enterDeviceMaintenance } from "../api/devices";
import { Client } from "../api/clients";
import { FilterSheet } from "./FilterSheet";
import { PatchStatus } from "../api/inventory";
import { ActionStatus, isActiveStatus, queueDeviceAction } from "../api/actions";
import { getConnectUrl } from "../api/remoteSupport";
import { deviceDisplayName, deviceHostnameSubtitle } from "../utils/deviceLabel";
import { isValidRustDeskId, buildRustDeskFallbackUrlFromTechiUrl, launchConnect } from "../services/rustdeskLaunch";
import { DeviceHealthSummary } from "../types/telemetry";
import { Badge, Button } from "./ui";
import ConfirmationModal from "./ConfirmationModal";
import { parseUTC } from "../utils/time";
import { DeviceMobileCard } from "./DeviceMobileCard";
import PlatformIcon from "./PlatformIcon";
import VersionBadge from "./VersionBadge";
import { compareVersions } from "../utils/version";
import { usePlatformFeatures } from "../hooks/usePlatformFeatures";
import ConnectMenu from "./ConnectMenu";
import { CONNECT_REFRESH_EVENT, ConnectRowStatus, getConnectStatuses } from "../api/connect";
import { detectOperatorOS } from "../utils/operatorOs";

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
  clients?: Client[];
  clientGroups?: Record<string, Record<string, number>>;
  unassignedCount?: number;
  onMobileLoadMore?: () => void;
  mobileHasMore?: boolean;
  mobileLoadingMore?: boolean;
  activePackageVersion?: string | null;
  activePackageSha256?: string | null;
  activeConnectorVersions?: Record<string, string>;
  activeAgentVersions?: Record<string, string>;
  agentsOutdated?: number;
  // Connect ▸ Embedded Terminal from a Catalog row opens the device's
  // drawer directly on its Terminal tab (the terminal lives there).
  onOpenDeviceTerminal?: (device: Device) => void;
}

export type QuickFilter =
  | "all" | "online" | "stale" | "offline" | "servers" | "workstations"
  | "needs_updates" | "reboot_required" | "warnings" | "critical"
  | "healthy" | "maintenance" | "needs_attention" | "low_health" | "rustdesk_issues" | "favorites"
  | "needs_agent_update";

const QUICK_FILTERS: { id: QuickFilter; label: string }[] = [
  { id: "all",               label: "All" },
  { id: "online",            label: "Online" },
  { id: "stale",             label: "Stale" },
  { id: "offline",           label: "Offline" },
  { id: "servers",           label: "Servers" },
  { id: "workstations",      label: "Workstations" },
  { id: "needs_updates",     label: "Needs Updates" },
  { id: "reboot_required",   label: "Reboot Required" },
  { id: "warnings",          label: "Warnings" },
  { id: "critical",          label: "Critical" },
  { id: "healthy",           label: "Healthy" },
  { id: "maintenance",       label: "Maintenance" },
  { id: "needs_attention",   label: "Needs Attention" },
  { id: "low_health",        label: "Low Health" },
  { id: "rustdesk_issues",   label: "RustDesk Issues" },
  { id: "needs_agent_update", label: "Needs Agent Update" },
  { id: "favorites",         label: "★ Favorites" },
];

type PendingAction = "archive" | "restore" | "delete";
export type HealthFilter = "all" | DeviceHealthSummary["health_state"];

function isAgentOutdated(device: Device, activeVersion?: string | null, activeSha256?: string | null) {
  if (!activeVersion) return false;
  if (!device.agent_version || device.agent_version !== activeVersion) return true;
  if (activeSha256) return (device.agent_sha256 ?? "").toLowerCase() !== activeSha256.toLowerCase();
  return false;
}

function agentVersionTitle(device: Device, activeVersion?: string | null, activeSha256?: string | null) {
  if (!activeVersion) return undefined;
  const active = activeSha256 ? `${activeVersion} | ${activeSha256.slice(0, 8)}` : activeVersion;
  const current = device.agent_sha256
    ? `${device.agent_version ?? "unknown"} | ${device.agent_sha256.slice(0, 8)}`
    : (device.agent_version ?? "unknown");
  return `Installed: ${current} | Active: ${active}`;
}

// Version Service (Device List side): Windows rows resolve to the SAME
// activePackageVersion/Sha256 as before — isAgentOutdated/agentVersionTitle
// above are untouched, so Windows badges are byte-identical. Non-Windows
// rows (MikroTik, future connectors) resolve against their OWN platform's
// latest_connector_version instead — never the Windows fleet's version.
// Agent platforms whose build is architecture-specific (Linux) resolve against
// active_agent_versions, keyed "<platform>:<uname -m>" by the backend so the
// arch->package mapping lives in exactly one place (version_service.py). A
// Linux row previously fell straight through to the connector lookup, which
// Linux never populates, so it resolved to null and the badge stayed grey no
// matter how current the agent was (device 729 on 2.1.21, 2026-08-05).
function resolveActiveVersion(
  device: Device,
  activePackageVersion?: string | null,
  activeConnectorVersions?: Record<string, string>,
  activeAgentVersions?: Record<string, string>,
) {
  const platform = (device.platform || "windows").toLowerCase();
  if (platform === "windows") return activePackageVersion;
  const architecture = (device.architecture || "").trim().toLowerCase();
  if (architecture) {
    const byArchitecture = activeAgentVersions?.[`${platform}:${architecture}`];
    if (byArchitecture) return byArchitecture;
  }
  return activeConnectorVersions?.[platform] ?? null;
}

// Is THIS device behind the latest build for ITS platform?
//
// The AGENT UPDATE tile and the Needs Agent Update filter used to measure every
// device against the Windows package version, so a MikroTik connector on 1.0.0
// and a Linux agent on 2.1.21 both counted as outdated against Windows' 2.1.20
// — the counts were inflated by the whole non-Windows fleet (reported
// 2026-08-05). Windows keeps the original two-state check exactly.
//
// A platform with no known latest version is never called outdated: a device we
// cannot measure is not a stale one.
function isDeviceAgentOutdated(
  device: Device,
  activePackageVersion?: string | null,
  activePackageSha256?: string | null,
  activeConnectorVersions?: Record<string, string>,
  activeAgentVersions?: Record<string, string>,
) {
  const platform = (device.platform || "windows").toLowerCase();
  if (platform === "windows") return isAgentOutdated(device, activePackageVersion, activePackageSha256);
  const active = resolveActiveVersion(device, activePackageVersion, activeConnectorVersions, activeAgentVersions);
  if (!active) return false;
  return compareVersions(device.agent_version, active) === "outdated";
}

// Production bug fix (Device Catalog Connect button): this row action used
// to be RustDesk-only (`isValidRustDeskId` + no conflict) regardless of
// platform, so every non-Windows device — which never has a rustdesk_id —
// showed a permanently grey Connect button with no explanation, even though
// those devices have real Connect Framework methods (SSH/Winbox/WebFig/
// Terminal) available in the Drawer. Platforms whose Connect Framework
// entry declares at least one capability=None (native, always-present)
// method never need a reported capability to be connectable; Linux (and any
// future capability-gated platform) needs at least one reported capability.
// This is a structural/cheap check — NOT a live credential-aware status
// (that would need one API call per row across a ~700-device table); the
// accurate, credential-aware ConnectMenu is what opens when the operator
// gets to the Drawer.
const PLATFORMS_WITH_ALWAYS_PRESENT_NATIVE_METHOD = new Set([
  "mikrotik", "synology", "qnap", "vmware", "proxmox", "hyperv",
]);

export function hasStructuralConnectMethod(device: Device): boolean {
  const platform = (device.platform || "windows").toLowerCase();
  if (platform === "windows") return false; // Windows uses the RustDesk-specific check instead.
  if (PLATFORMS_WITH_ALWAYS_PRESENT_NATIVE_METHOD.has(platform)) return true;
  return Object.keys(device.capabilities || {}).length > 0;
}

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
            ? "bg-[var(--th-status-online)] shadow-[0_0_5px_color-mix(in_srgb,var(--th-status-online)_70%,transparent)]"
            : isStale
            ? "bg-[var(--th-status-warning)] shadow-[0_0_4px_color-mix(in_srgb,var(--th-status-warning)_60%,transparent)]"
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
    return { label: "RS stopped", color: "var(--th-accent)", bg: "color-mix(in srgb, var(--th-accent) 12%, transparent)", border: "color-mix(in srgb, var(--th-accent) 25%, transparent)" };
  }

  // Site outage: ≥2 peers from same client offline near same time
  if (device.client_id && device.last_seen) {
    const t = parseUTC(device.last_seen).getTime();
    const nearbyPeers = clientSummary?.inactiveLastSeen.filter(
      (lastSeen) => lastSeen !== t && Math.abs(lastSeen - t) < 10 * 60 * 1000
    ).length ?? 0;
    if (nearbyPeers >= 2)
      return { label: "Site?", color: "var(--th-status-critical)", bg: "color-mix(in srgb, var(--th-status-critical) 12%, transparent)", border: "color-mix(in srgb, var(--th-status-critical) 30%, transparent)" };
  }

  // Single device offline (no other offline from same client)
  if (freshness === "offline" && device.client_id) {
    if ((clientSummary?.offlineCount ?? 0) <= 1)
      return { label: "Power?", color: "var(--th-status-offline)", bg: "color-mix(in srgb, var(--th-status-offline) 8%, transparent)", border: "color-mix(in srgb, var(--th-status-offline) 20%, transparent)" };
  }

  // Has IP → network issue
  if (device.public_ip || device.local_ip)
    return { label: "Network", color: "var(--th-status-info)", bg: "color-mix(in srgb, var(--th-status-info) 10%, transparent)", border: "color-mix(in srgb, var(--th-status-info) 22%, transparent)" };

  // Stale only
  if (freshness === "stale")
    return { label: "Stale", color: "var(--th-status-warning)", bg: "color-mix(in srgb, var(--th-status-warning) 10%, transparent)", border: "color-mix(in srgb, var(--th-status-warning) 22%, transparent)" };

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
          color: "var(--th-status-agent)",
          background: "color-mix(in srgb, var(--th-status-agent) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--th-status-agent) 22%, transparent)",
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
          color: "var(--th-status-info)",
          background: "color-mix(in srgb, var(--th-status-info) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--th-status-info) 20%, transparent)",
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
  clients,
  clientGroups,
  unassignedCount,
  onMobileLoadMore,
  mobileHasMore = false,
  mobileLoadingMore = false,
  activePackageVersion,
  activePackageSha256,
  activeConnectorVersions,
  activeAgentVersions,
  agentsOutdated = 0,
  onOpenDeviceTerminal,
}: DevicesTableProps) {
  const navigate = useNavigate();
  // Platform Expansion: show the platform icon only when Linux is enabled, so
  // with the flag off the catalog is visually identical to today.
  const platformFeatures = usePlatformFeatures();
  const showPlatformIcon = platformFeatures.FEATURE_LINUX;
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [openActionDeviceId, setOpenActionDeviceId] = useState<number | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const [pendingAction, setPendingAction] = useState<{ type: PendingAction; device: Device } | null>(null);
  type SortKey = "hostname" | "client_name" | "last_seen" | "health";
  const [sortKey, setSortKey] = useState<SortKey>("hostname");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [agentVersionFilter, setAgentVersionFilter] = useState<string>("all");
  // Mobile UI 2.0 (MOBILE-DESIGN-SPEC.md — Devices/Sort): sort sheet, mobile-only.
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const SORT_OPTIONS: { key: SortKey; label: string }[] = [
    { key: "hostname", label: "Name" },
    { key: "last_seen", label: "Last seen" },
    { key: "client_name", label: "Client" },
    { key: "health", label: "Health" },
  ];

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
      if (isDeviceAgentOutdated(d, activePackageVersion, activePackageSha256, activeConnectorVersions, activeAgentVersions)) counts.needs_agent_update++;
      if (favorites.has(d.id)) counts.favorites++;
    }
    return counts;
  }, [devices, patchMap, healthMap, alertsMap, favorites, activePackageVersion, activePackageSha256, activeConnectorVersions, activeAgentVersions]);

  // Distinct agent versions present in the current device list, newest first
  const agentVersionOptions = useMemo(() => {
    const versions = new Set<string>();
    for (const d of devices) {
      if (d.agent_version) versions.add(d.agent_version);
    }
    return Array.from(versions).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  }, [devices]);

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
        case "needs_agent_update": return (
          isDeviceAgentOutdated(d, activePackageVersion, activePackageSha256, activeConnectorVersions, activeAgentVersions)
        );
        case "favorites":       return favorites.has(d.id);
        default:                return true;
      }
    });
    const versionFiltered = agentVersionFilter === "all" ? filtered : filtered.filter(d =>
      agentVersionFilter === "unknown" ? !d.agent_version : d.agent_version === agentVersionFilter
    );
    return [...versionFiltered].sort((a, b) => {
      let cmp: number;
      if (sortKey === "hostname") {
        cmp = deviceDisplayName(a).localeCompare(deviceDisplayName(b));
      } else if (sortKey === "client_name") {
        cmp = (a.client_name ?? "").localeCompare(b.client_name ?? "");
      } else if (sortKey === "health") {
        cmp = (healthMap[a.id]?.health_score ?? 100) - (healthMap[b.id]?.health_score ?? 100);
      } else {
        cmp = (a.last_seen ?? "").localeCompare(b.last_seen ?? "");
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [devices, quickFilter, agentVersionFilter, patchMap, healthMap, alertsMap, favorites, activePackageVersion, activePackageSha256, activeConnectorVersions, activeAgentVersions, sortKey, sortDir]);

  // Approved V3 Connect mockup — the Catalog Connect button carries a real
  // per-row state (Ready / Credential required / Unavailable) for every
  // non-Windows row, fetched in ONE batched /connect-status call for the
  // visible rows (never per-row N+1). Refreshed on CONNECT_REFRESH_EVENT so
  // adding a credential / changing a default updates the buttons immediately.
  const [connectStatusMap, setConnectStatusMap] = useState<Record<number, ConnectRowStatus>>({});
  const nonWindowsIdsKey = useMemo(
    () => displayDevices
      .filter((d) => d.platform && d.platform.toLowerCase() !== "windows")
      .map((d) => d.id)
      .join(","),
    [displayDevices],
  );
  useEffect(() => {
    if (!platformFeatures.FEATURE_PLATFORM_CORE || !nonWindowsIdsKey) {
      setConnectStatusMap({});
      return;
    }
    let active = true;
    const ids = nonWindowsIdsKey.split(",").map(Number);
    const fetchStatuses = () => {
      getConnectStatuses(ids, detectOperatorOS())
        .then((rows) => {
          if (!active) return;
          const map: Record<number, ConnectRowStatus> = {};
          rows.forEach((r) => { map[r.device_id] = r; });
          setConnectStatusMap(map);
        })
        .catch(() => { /* row buttons fall back to the structural check */ });
    };
    fetchStatuses();
    window.addEventListener(CONNECT_REFRESH_EVENT, fetchStatuses);
    return () => {
      active = false;
      window.removeEventListener(CONNECT_REFRESH_EVENT, fetchStatuses);
    };
  }, [nonWindowsIdsKey, platformFeatures.FEATURE_PLATFORM_CORE]);

  // Mobile UI 2.0 (MOBILE-DESIGN-SPEC.md — Devices/"chips aktive"): every
  // applied filter — quick filter, client, and client subgroup — surfaces as
  // a dismissible chip so the active filter state is never hidden.
  const activeChips = useMemo(() => {
    const chips: { key: string; label: string; onClear: () => void }[] = [];
    if (quickFilter !== "all") {
      chips.push({
        key: "quick",
        label: QUICK_FILTERS.find((f) => f.id === quickFilter)?.label ?? quickFilter,
        onClear: () => onQuickFilterChange("all"),
      });
    }
    if (filters.client_id === -1) {
      chips.push({
        key: "client",
        label: "No Client",
        onClear: () => {
          onFilterChange("client_id", undefined);
          onFilterChange("device_type", undefined);
        },
      });
    } else if (filters.client_id) {
      const clientName = clients?.find((c) => c.id === filters.client_id)?.name;
      if (clientName) {
        chips.push({
          key: "client",
          label: clientName,
          onClear: () => {
            onFilterChange("client_id", undefined);
            onFilterChange("device_type", undefined);
          },
        });
      }
    }
    if (filters.device_type === "server" || filters.device_type === "client") {
      chips.push({
        key: "devtype",
        label: filters.device_type === "server" ? "Servers" : "Client PC",
        onClear: () => onFilterChange("device_type", undefined),
      });
    }
    return chips;
  }, [quickFilter, filters.client_id, filters.device_type, clients, onQuickFilterChange, onFilterChange]);

  const clearAllMobileFilters = () => {
    onQuickFilterChange("all");
    onFilterChange("client_id", undefined);
    onFilterChange("device_type", undefined);
  };

  // Mobile UI 2.0 (MOBILE-DESIGN-SPEC.md — Devices/"Infinite scroll"): the
  // sentinel below the list triggers onMobileLoadMore automatically.
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!mobileHasMore || !onMobileLoadMore) return;
    const el = loadMoreSentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !mobileLoadingMore) onMobileLoadMore();
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [mobileHasMore, mobileLoadingMore, onMobileLoadMore, displayDevices.length]);

  const offlineSummaryByClient = useMemo(() => {
    const summaries = new Map<number, ClientOfflineSummary>();
    for (const device of devices) {
      if (!device.client_id) continue;
      const freshness = device.freshness_state ?? device.status;
      const summary = summaries.get(device.client_id) ?? { offlineCount: 0, inactiveLastSeen: [] };
      if (freshness === "offline") summary.offlineCount += 1;
      if ((freshness === "offline" || freshness === "stale") && device.last_seen) {
        summary.inactiveLastSeen.push(parseUTC(device.last_seen).getTime());
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
      <div className="hidden md:grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
        {([
          {
            id: "needs_updates" as QuickFilter,
            label: "Updates",
            count: pillCounts.needs_updates,
            color: "var(--th-status-warning)", bg: "color-mix(in srgb, var(--th-status-warning) 10%, transparent)", border: "color-mix(in srgb, var(--th-status-warning) 25%, transparent)",
          },
          {
            id: "reboot_required" as QuickFilter,
            label: "Reboot",
            count: pillCounts.reboot_required,
            color: "var(--th-status-critical)", bg: "color-mix(in srgb, var(--th-status-critical) 10%, transparent)", border: "color-mix(in srgb, var(--th-status-critical) 25%, transparent)",
          },
          {
            id: "offline" as QuickFilter,
            label: "Offline >24h",
            count: devices.filter(d => {
              if (d.freshness_state !== "offline" || !d.last_seen) return false;
              return (Date.now() - new Date(d.last_seen).getTime()) > 86_400_000;
            }).length,
            color: "var(--th-status-offline)", bg: "color-mix(in srgb, var(--th-status-offline) 8%, transparent)", border: "color-mix(in srgb, var(--th-status-offline) 20%, transparent)",
          },
          {
            id: "maintenance" as QuickFilter,
            label: "Maintenance",
            count: pillCounts.maintenance,
            color: "var(--th-status-maint)", bg: "color-mix(in srgb, var(--th-status-maint) 10%, transparent)", border: "color-mix(in srgb, var(--th-status-maint) 25%, transparent)",
          },
          {
            id: "rustdesk_issues" as QuickFilter,
            label: "RS Issues",
            count: pillCounts.rustdesk_issues,
            color: "var(--th-accent)", bg: "color-mix(in srgb, var(--th-accent) 10%, transparent)", border: "color-mix(in srgb, var(--th-accent) 25%, transparent)",
          },
          {
            id: "low_health" as QuickFilter,
            label: "Health <60",
            count: pillCounts.low_health,
            color: "var(--th-status-critical)", bg: "color-mix(in srgb, var(--th-status-critical) 10%, transparent)", border: "color-mix(in srgb, var(--th-status-critical) 25%, transparent)",
          },
          {
            id: "needs_agent_update" as QuickFilter,
            label: "Agent Update",
            count: agentsOutdated || pillCounts.needs_agent_update,
            color: "var(--th-status-agent)", bg: "color-mix(in srgb, var(--th-status-agent) 10%, transparent)", border: "color-mix(in srgb, var(--th-status-agent) 25%, transparent)",
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
        style={{ background: "color-mix(in srgb, var(--th-accent) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--th-accent) 25%, transparent)" }}
      >
        <span className="text-sm font-semibold" style={{ color: "var(--th-accent)" }}>
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
                background: btn.destructive ? "color-mix(in srgb, var(--th-status-critical) 12%, transparent)" : "color-mix(in srgb, var(--th-text-primary) 5%, transparent)",
                border: `1px solid ${btn.destructive ? "color-mix(in srgb, var(--th-status-critical) 30%, transparent)" : "color-mix(in srgb, var(--th-text-primary) 12%, transparent)"}`,
                color: btn.destructive ? "var(--th-status-critical)" : "var(--th-text-secondary)",
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
            style={{ background: "color-mix(in srgb, var(--th-status-maint) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--th-status-maint) 25%, transparent)", color: "var(--th-status-maint)" }}
          >
            Enter Maintenance
          </button>
          <button
            type="button"
            disabled={bulkBusy}
            onClick={() => { setPendingBulkAction({ action: "maintenance_exit", destructive: false }); setBulkConfirmOpen(true); }}
            className="rounded-md px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-40"
            style={{ background: "color-mix(in srgb, var(--th-text-primary) 4%, transparent)", border: "1px solid color-mix(in srgb, var(--th-text-primary) 10%, transparent)", color: "var(--th-text-secondary)" }}
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
        className="hidden md:block rounded-xl p-3"
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
                    ? hasAlert ? "color-mix(in srgb, var(--th-status-critical) 18%, transparent)"
                    : hasWarn  ? "color-mix(in srgb, var(--th-status-warning) 15%, transparent)"
                    : "color-mix(in srgb, var(--th-accent) 18%, transparent)"
                    : "color-mix(in srgb, var(--th-text-primary) 4%, transparent)",
                  border: `1px solid ${active
                    ? hasAlert ? "color-mix(in srgb, var(--th-status-critical) 40%, transparent)"
                    : hasWarn  ? "color-mix(in srgb, var(--th-status-warning) 35%, transparent)"
                    : "color-mix(in srgb, var(--th-accent) 35%, transparent)"
                    : "color-mix(in srgb, var(--th-text-primary) 8%, transparent)"}`,
                  color: active
                    ? hasAlert ? "var(--th-status-critical)"
                    : hasWarn  ? "var(--th-status-warning)"
                    : "var(--th-accent)"
                    : count === 0 ? "var(--th-text-muted)" : "var(--th-text-secondary)",
                  opacity: count === 0 && f.id !== "all" ? 0.45 : 1,
                }}
              >
                {f.label}
                {f.id !== "all" && (
                  <span className="rounded-full px-1 text-[9px] font-bold tabular-nums"
                    style={{ background: "color-mix(in srgb, var(--th-text-primary) 8%, transparent)" }}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-2 grid gap-1.5 lg:grid-cols-[1.6fr_1fr] xl:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search name, hostname, user, domain or IP..."
              className={`${FILTER_INPUT_CLS} w-full py-1.5 pl-9 pr-3`}
            />
          </div>
          <select
            value={filters.freshness_state || "all"}
            onChange={(e) => onFilterChange("freshness_state", e.target.value)}
            className={FILTER_INPUT_CLS}
            id="filter-device-status"
            name="filter-device-status"
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
            id="filter-health"
            name="filter-health"
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
            id="filter-lifecycle-state"
            name="filter-lifecycle-state"
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
            id="filter-maintenance-state"
            name="filter-maintenance-state"
            aria-label="Filter by maintenance state"
          >
            <option value="all">All signals</option>
            <option value="maintenance">In maintenance</option>
            <option value="normal">Normal only</option>
            <option value="duplicate">Duplicates only</option>
          </select>
          <select
            value={agentVersionFilter}
            onChange={(e) => setAgentVersionFilter(e.target.value)}
            className={FILTER_INPUT_CLS}
            id="filter-agent-version"
            name="filter-agent-version"
            aria-label="Filter by agent version"
          >
            <option value="all">All versions</option>
            {agentVersionOptions.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
            <option value="unknown">Unknown</option>
          </select>
        </div>
      </div>

      {/* ── Mobile (< 768px): sticky header ALWAYS visible + own state
          handling (Mobile UI 2.0 — fixes the empty-search dead-end where
          Search/Filters used to disappear entirely; MOBILE-DESIGN-SPEC.md
          — Devices/Empty States). ── */}
      <div
        className="md:hidden overflow-hidden rounded-xl"
        style={{ border: "1px solid var(--th-border-card)", background: "var(--th-bg-card)" }}
      >
        <div
          className="sticky top-0 z-10"
          style={{ background: "var(--th-bg-card)", borderBottom: "1px solid var(--th-border-subtle)" }}
        >
          <div className="flex items-center gap-2 p-3">
            <div className="relative flex-1">
              <Search
                className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
                style={{ color: "var(--th-text-muted)" }}
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="Search devices..."
                enterKeyHint="search"
                className="w-full rounded-lg border py-2.5 pl-9 pr-3 text-[13px] font-medium focus:outline-none"
                style={{
                  background: "var(--th-chip-bg)",
                  borderColor: "var(--th-border-subtle)",
                  color: "var(--th-text-primary)",
                }}
              />
            </div>
            <button
              type="button"
              onClick={() => setFilterSheetOpen(true)}
              aria-label="Filters"
              className="flex h-11 w-11 flex-none items-center justify-center rounded-lg"
              style={{ border: "1px solid var(--th-border-subtle)", color: "var(--th-text-secondary)", background: "var(--th-chip-bg)" }}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setSortSheetOpen(true)}
              aria-label="Sort"
              className="flex h-11 w-11 flex-none items-center justify-center rounded-lg"
              style={{ border: "1px solid var(--th-border-subtle)", color: "var(--th-text-secondary)", background: "var(--th-chip-bg)" }}
            >
              <ArrowUpDown className="h-4 w-4" />
            </button>
          </div>
          {activeChips.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto px-3 pb-2.5" style={{ scrollbarWidth: "none" }}>
              {activeChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={chip.onClear}
                  className="inline-flex flex-none items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-bold"
                  style={{ background: "var(--th-accent-glow)", border: "1px solid var(--th-accent-border)", color: "var(--th-accent)" }}
                >
                  {chip.label}
                  <X className="h-3 w-3" />
                </button>
              ))}
            </div>
          )}
        </div>

        {loading ? (
          <div className="overflow-hidden">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 border-b px-4 py-3 animate-pulse"
                style={{ borderColor: "var(--th-border-subtle)", opacity: 1 - i * 0.12 }}
              >
                <div className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: "var(--th-ring-track)" }} />
                <div className="h-3 w-32 rounded" style={{ background: "var(--th-ring-track)" }} />
                <div className="ml-auto h-3 w-16 rounded" style={{ background: "var(--th-ring-track)" }} />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <p className="text-[15px] font-bold" style={{ color: "var(--th-text-primary)" }}>Unable to load devices</p>
            <p className="text-[13px]" style={{ color: "var(--th-status-critical)" }}>{error}</p>
            <Button onClick={onRefresh} size="sm">Try again</Button>
          </div>
        ) : displayDevices.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
            <ServerOff className="h-8 w-8" style={{ color: "var(--th-text-faint)" }} />
            {searchQuery ? (
              <>
                <div>
                  <p className="text-[15px] font-bold" style={{ color: "var(--th-text-primary)" }}>
                    No results for "{searchQuery}"
                  </p>
                  <p className="mt-1 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                    Searched across name, hostname, user, domain and IP.
                  </p>
                </div>
                <button type="button" onClick={() => onSearch("")} className="rounded-lg px-4 py-2 text-[12.5px] font-bold" style={{ background: "var(--th-accent-glow)", border: "1px solid var(--th-accent-border)", color: "var(--th-accent)" }}>
                  Clear search
                </button>
              </>
            ) : activeChips.length > 0 ? (
              <>
                <div>
                  <p className="text-[15px] font-bold" style={{ color: "var(--th-text-primary)" }}>No devices match these filters</p>
                  <p className="mt-1 text-[13px]" style={{ color: "var(--th-text-muted)" }}>Adjust or clear filters to see more devices.</p>
                </div>
                <button type="button" onClick={clearAllMobileFilters} className="rounded-lg px-4 py-2 text-[12.5px] font-bold" style={{ background: "var(--th-accent-glow)", border: "1px solid var(--th-accent-border)", color: "var(--th-accent)" }}>
                  Clear filters
                </button>
              </>
            ) : (
              <div>
                <p className="text-[15px] font-bold" style={{ color: "var(--th-text-primary)" }}>No devices found</p>
                <p className="mt-1 text-[13px]" style={{ color: "var(--th-text-muted)" }}>Adjust filters or search terms to reveal devices.</p>
              </div>
            )}
          </div>
        ) : (
          <>
            {displayDevices.map((device) => {
              const isWindowsDevice = !device.platform || device.platform.toLowerCase() === "windows";
              const canConnect = isWindowsDevice
                ? isValidRustDeskId(device.rustdesk_id) && !device.rustdesk_conflict_detected
                : hasStructuralConnectMethod(device);
              return (
                <DeviceMobileCard
                  key={device.id}
                  device={device}
                  health={healthMap[device.id]}
                  patch={patchMap[device.id]}
                  activeAction={activeActionMap[device.id]}
                  alerts={alertsMap[device.id]}
                  offlineSummary={
                    device.client_id ? offlineSummaryByClient.get(device.client_id) : undefined
                  }
                  canConnect={canConnect}
                  isFavorite={favorites.has(device.id)}
                  activePackageVersion={activePackageVersion}
                  activePackageSha256={activePackageSha256}
                  agentOutdated={isDeviceAgentOutdated(device, activePackageVersion, activePackageSha256, activeConnectorVersions, activeAgentVersions)}
                  onSelect={() => navigate(`/devices/${device.id}`)}
                  onToggleFavorite={onToggleFavorite ? () => onToggleFavorite(device.id) : undefined}
                  onConnect={
                    isWindowsDevice
                      ? async () => {
                          try {
                            const res = await getConnectUrl(device.id);
                            launchConnect(
                              res.connect_url,
                              buildRustDeskFallbackUrlFromTechiUrl(res.connect_url),
                              () => showBulkToast("Opening with RustDesk instead", true)
                            );
                          } catch (err) {
                            showBulkToast(err instanceof Error ? err.message : "Connect failed", false);
                          }
                        }
                      : async () => navigate(`/devices/${device.id}`)
                  }
                  connectTitle={
                    isWindowsDevice
                      ? undefined
                      : canConnect
                      ? "Open device to connect (SSH/Winbox/WebFig/Terminal)"
                      : "No Connect method available for this device yet"
                  }
                />
              );
            })}

            {mobileHasMore && (
              <div ref={loadMoreSentinelRef} className="flex items-center justify-center p-4">
                {mobileLoadingMore && <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--th-accent)" }} />}
              </div>
            )}
          </>
        )}
      </div>

      <MobileSheet open={sortSheetOpen} onClose={() => setSortSheetOpen(false)} title="Sort devices">
        <div className="flex flex-col gap-1">
          {SORT_OPTIONS.map((opt) => {
            const active = sortKey === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => { handleSort(opt.key); setSortSheetOpen(false); }}
                className="flex min-h-[48px] items-center justify-between rounded-lg px-3 text-[13.5px] font-bold"
                style={{ color: active ? "var(--th-accent)" : "var(--th-text-primary)", background: active ? "var(--th-accent-glow)" : "transparent" }}
              >
                {opt.label}
                {active && <span aria-hidden="true">{sortDir === "asc" ? "↑" : "↓"}</span>}
              </button>
            );
          })}
        </div>
      </MobileSheet>

      {/* ── Desktop (≥ 768px) — unchanged states/table/footer, now scoped
          to desktop only since Mobile has its own block above ── */}
      {loading ? (
        <div className="hidden md:block premium-card-soft overflow-hidden">
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
        <div className="hidden md:block premium-card-soft py-12 text-center">
          <p className="text-[15px] font-semibold text-white">Unable to load devices</p>
          <p className="mt-1 text-[13px] text-red-300">{error}</p>
          <Button onClick={onRefresh} size="sm" className="mt-4">
            Try again
          </Button>
        </div>
      ) : devices.length === 0 ? (
        <div className="hidden md:block premium-card-soft flex flex-col items-center gap-3 py-14 text-center">
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
          className="hidden md:block overflow-hidden rounded-xl"
          style={{ border: "1px solid var(--th-border-card)", background: "var(--th-bg-card)" }}
        >
          <div className="hidden md:block">
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
                <tr style={{ background: "var(--th-bg-table-head, color-mix(in srgb, var(--th-text-primary) 2.5%, transparent))", borderBottom: "1px solid var(--th-border-subtle)" }}>
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
                    { label: "Agent",                          sortable: null },
                    { label: "Last Seen",                      sortable: "last_seen" as SortKey },
                    { label: "Actions",                        sortable: null },
                  ].map(({ label, w, sortable }) => (
                    <th
                      key={label}
                      className={`px-2.5 py-2 text-left text-[9px] font-semibold uppercase tracking-[0.1em] ${w ?? ""} ${sortable ? "cursor-pointer select-none hover:text-slate-200" : ""}`}
                      style={{ color: sortable && sortKey === sortable ? "var(--th-text-primary)" : "var(--th-text-muted)", borderBottom: "1px solid var(--th-border-subtle)" }}
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
                  const isWindowsDevice = !device.platform || device.platform.toLowerCase() === "windows";
                  const canConnect = isWindowsDevice
                    ? isValidRustDeskId(device.rustdesk_id) && !device.rustdesk_conflict_detected
                    : hasStructuralConnectMethod(device);
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
                        background: rowIdx % 2 === 0 ? "transparent" : "color-mix(in srgb, var(--th-text-primary) 0.8%, transparent)",
                        borderBottom: "1px solid var(--th-border-subtle)",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--th-text-primary) 2.8%, transparent)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = rowIdx % 2 === 0 ? "transparent" : "color-mix(in srgb, var(--th-text-primary) 0.8%, transparent)")}
                      onClick={() => onDeviceSelect?.(device)}
                    >
                      {/* ── Checkbox ── */}
                      <td className="w-[36px] px-2 py-1.5 align-middle" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(device.id)}
                          onChange={() => toggleOne(device.id)}
                          id={`select-device-${device.id}`}
                          name="select-device"
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
                        {(() => {
                          const label = deviceDisplayName(device);
                          const hostname = deviceHostnameSubtitle(device);
                          return (
                            <>
                              {showPlatformIcon ? (
                                <div
                                  className="flex max-w-[180px] items-center gap-1.5 text-[12px] font-bold leading-[1.3]"
                                  style={{ color: "var(--th-text-primary)" }}
                                  title={label}
                                >
                                  <PlatformIcon platform={device.platform} size={13} className="shrink-0" />
                                  <span className="truncate">{label}</span>
                                </div>
                              ) : (
                                <div
                                  className="max-w-[180px] truncate text-[12px] font-bold leading-[1.3]"
                                  style={{ color: "var(--th-text-primary)" }}
                                  title={label}
                                >
                                  {label}
                                </div>
                              )}
                              {hostname && (
                                <div className="max-w-[180px] truncate font-mono text-[10px] leading-4" style={{ color: "var(--th-text-muted)" }} title={device.hostname}>
                                  {hostname}
                                </div>
                              )}
                            </>
                          );
                        })()}
                        <div className="mt-0.5 flex flex-wrap items-center gap-0.5">
                          {getDeviceTypeBadge(device)}
                          {getPatchBadge(patchMap[device.id])}
                          {getLifecycleSignals(device)}
                          {devAlerts?.critical ? (
                            <span className="inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-bold tabular-nums"
                              style={{ color: "var(--th-status-critical)", background: "color-mix(in srgb, var(--th-status-critical) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--th-status-critical) 22%, transparent)" }}>
                              <span className="h-1.5 w-1.5 rounded-full bg-[var(--th-status-critical)]" style={{ boxShadow: "0 0 3px color-mix(in srgb, var(--th-status-critical) 70%, transparent)" }} />
                              {devAlerts.critical}
                            </span>
                          ) : null}
                          {devAlerts?.warning ? (
                            <span className="inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-bold tabular-nums"
                              style={{ color: "var(--th-status-warning)", background: "color-mix(in srgb, var(--th-status-warning) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--th-status-warning) 22%, transparent)" }}>
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
                              style={{ color: "var(--th-status-critical)", background: "color-mix(in srgb, var(--th-status-critical) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--th-status-critical) 22%, transparent)" }}
                              title={`Health score: ${healthScore}`}>
                              H:{healthScore}
                            </span>
                          )}
                          {rsIssue && !offlineBadge && (
                            <span className="inline-flex items-center rounded px-1.5 py-px text-[9px] font-semibold"
                              style={{ color: "var(--th-accent)", background: "color-mix(in srgb, var(--th-accent) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--th-accent) 22%, transparent)" }}
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

                      {/* ── Agent version ── */}
                      <td className="whitespace-nowrap px-2.5 py-1.5 align-middle">
                        {(() => {
                          const platform = (device.platform || "windows").toLowerCase();
                          if (platform === "windows") {
                            // Byte-identical to the prior inline JSX: same 2-state
                            // boolean, same colors, no "ahead" state.
                            return (
                              <VersionBadge
                                version={device.agent_version}
                                status={isAgentOutdated(device, activePackageVersion, activePackageSha256) ? "outdated" : "current"}
                                title={agentVersionTitle(device, activePackageVersion, activePackageSha256)}
                              />
                            );
                          }
                          const active = resolveActiveVersion(device, activePackageVersion, activeConnectorVersions, activeAgentVersions);
                          return (
                            <VersionBadge
                              version={device.agent_version}
                              status={compareVersions(device.agent_version, active)}
                              title={active ? `Latest: ${active}` : undefined}
                            />
                          );
                        })()}
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
                              style={{ color: favorites.has(device.id) ? "var(--th-status-warning)" : "var(--th-text-muted)" }}
                            >
                              <Star className={`h-3 w-3 ${favorites.has(device.id) ? "fill-current" : ""}`} />
                            </button>
                          )}
                          {/* Connect (approved V3 Connect mockup). Windows keeps its
                              existing dedicated RustDesk flow, byte-identical — main
                              click opens directly, single option, exactly as before
                              (and as annotated in the mockup: "Opens directly —
                              single option"). Non-Windows rows render the split
                              Connect button: main click launches the operator's saved
                              default Ready method (or opens the categorized method
                              menu once when no default is saved); the ▾ arrow always
                              opens the menu. NEVER the Drawer. Button state comes
                              from the batched /connect-status feed. Flag-off keeps
                              the old open-the-device behavior (no Connect Framework
                              endpoints exist then). */}
                          {isWindowsDevice || !platformFeatures.FEATURE_PLATFORM_CORE ? (
                            <button
                              type="button"
                              disabled={!canConnect}
                              onClick={
                                isWindowsDevice
                                  ? async () => {
                                      try {
                                        const res = await getConnectUrl(device.id);
                                        launchConnect(
                                          res.connect_url,
                                          buildRustDeskFallbackUrlFromTechiUrl(res.connect_url),
                                          () => showBulkToast("Opening with RustDesk instead", true)
                                        );
                                      } catch (err) {
                                        showBulkToast(err instanceof Error ? err.message : "Connect failed", false);
                                      }
                                    }
                                  : () => onDeviceSelect?.(device)
                              }
                              title={
                                isWindowsDevice
                                  ? device.rustdesk_conflict_detected
                                    ? "Remote Support ID conflict"
                                    : canConnect
                                    ? "Open TECHI Remote Support"
                                    : "Remote ID not resolved yet"
                                  : canConnect
                                  ? "Open device to connect (SSH/Winbox/WebFig/Terminal)"
                                  : "No Connect method available for this device yet"
                              }
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-all"
                              style={{
                                background: canConnect
                                  ? "color-mix(in srgb, var(--th-accent) 15%, transparent)"
                                  : "color-mix(in srgb, var(--th-text-primary) 3%, transparent)",
                                border: `1px solid ${
                                  canConnect
                                    ? "color-mix(in srgb, var(--th-accent) 30%, transparent)"
                                    : "var(--th-border-subtle)"
                                }`,
                                color: canConnect ? "var(--th-accent)" : "var(--th-text-muted)",
                                cursor: canConnect ? "pointer" : "not-allowed",
                                opacity: canConnect ? 1 : 0.45,
                              }}
                            >
                              <ExternalLink className="h-3 w-3" />
                              Connect
                            </button>
                          ) : (
                            <ConnectMenu
                              variant="row"
                              lazyLoad
                              deviceId={device.id}
                              hostname={device.hostname}
                              initialState={connectStatusMap[device.id]?.state ?? (canConnect ? null : "unavailable")}
                              initialStateReason={connectStatusMap[device.id]?.reason ?? (canConnect ? null : "No Connect method available for this device yet")}
                              onOpenTerminal={onOpenDeviceTerminal ? () => onOpenDeviceTerminal(device) : undefined}
                            />
                          )}

                          {canOperate && (
                            <button
                              type="button"
                              data-action-trigger="true"
                              className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors"
                              style={{
                                border: "1px solid var(--th-border-subtle)",
                                background: "color-mix(in srgb, var(--th-text-primary) 3%, transparent)",
                                color: "var(--th-text-muted)",
                              }}
                              onMouseEnter={(e) => {
                                (e.currentTarget as HTMLElement).style.background =
                                  "color-mix(in srgb, var(--th-text-primary) 7%, transparent)";
                                (e.currentTarget as HTMLElement).style.color =
                                  "var(--th-text-secondary)";
                              }}
                              onMouseLeave={(e) => {
                                (e.currentTarget as HTMLElement).style.background =
                                  "color-mix(in srgb, var(--th-text-primary) 3%, transparent)";
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
          </div>{/* end hidden md:block */}

          {/* Footer — hidden on mobile (Load More replaces pagination) */}
          <div
            className="hidden md:flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5"
            style={{
              borderTop: "1px solid var(--th-border-subtle)",
              background: "var(--th-bg-table-head, color-mix(in srgb, var(--th-text-primary) 2%, transparent))",
            }}
          >
            {/* Left: count + page size + loading */}
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[11px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                {total > 0
                  ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total} devices`
                  : `${displayDevices.length} devices`}
                {selectedIds.size > 0 && (
                  <span className="ml-2 font-semibold" style={{ color: "var(--th-accent)" }}>
                    · {selectedIds.size} selected
                  </span>
                )}
              </span>
              {total > 0 && (
                <select
                  value={limit}
                  onChange={(e) => onLimitChange?.(Number(e.target.value))}
                  id="rows-per-page"
                  name="rows-per-page"
                  aria-label="Rows per page"
                  className="rounded border px-2 py-0.5 text-[11px] font-medium focus:outline-none"
                  style={{
                    borderColor: "var(--th-border-subtle)",
                    background: "var(--th-bg-input)",
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
                  style={{ boxShadow: "0 0 4px color-mix(in srgb, var(--th-status-online) 50%, transparent)" }}
                />
                Fleet active
              </span>
            )}
          </div>
        </div>
      )}

      {/* Mobile filter sheet */}
      <FilterSheet
        open={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        quickFilter={quickFilter}
        onQuickFilterChange={onQuickFilterChange}
        clients={clients}
        clientGroups={clientGroups}
        unassignedCount={unassignedCount}
        filters={filters}
        onFilterChange={onFilterChange}
      />

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
            background: bulkToast.ok ? "color-mix(in srgb, var(--th-status-online) 15%, transparent)" : "color-mix(in srgb, var(--th-status-critical) 15%, transparent)",
            border: `1px solid ${bulkToast.ok ? "color-mix(in srgb, var(--th-status-online) 30%, transparent)" : "color-mix(in srgb, var(--th-status-critical) 30%, transparent)"}`,
            color: bulkToast.ok ? "var(--th-status-online)" : "var(--th-status-critical)",
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
                          background: bulkMaintMinutes === opt.mins ? "color-mix(in srgb, var(--th-status-maint) 15%, transparent)" : "color-mix(in srgb, var(--th-text-primary) 4%, transparent)",
                          border: `1px solid ${bulkMaintMinutes === opt.mins ? "color-mix(in srgb, var(--th-status-maint) 35%, transparent)" : "color-mix(in srgb, var(--th-text-primary) 10%, transparent)"}`,
                          color: bulkMaintMinutes === opt.mins ? "var(--th-status-maint)" : "var(--th-text-secondary)",
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
                  style={{ background: "color-mix(in srgb, var(--th-text-primary) 4%, transparent)", border: "1px solid var(--th-border-subtle)", color: "var(--th-text-muted)" }}>
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
                    background: pendingBulkAction.destructive ? "color-mix(in srgb, var(--th-status-critical) 15%, transparent)" : "color-mix(in srgb, var(--th-accent) 15%, transparent)",
                    border: `1px solid ${pendingBulkAction.destructive ? "color-mix(in srgb, var(--th-status-critical) 35%, transparent)" : "color-mix(in srgb, var(--th-accent) 35%, transparent)"}`,
                    color: pendingBulkAction.destructive ? "var(--th-status-critical)" : "var(--th-accent)",
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
          background: "color-mix(in srgb, var(--th-text-primary) 4%, transparent)",
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
              background: p === page ? "color-mix(in srgb, var(--th-accent) 18%, transparent)" : "color-mix(in srgb, var(--th-text-primary) 4%, transparent)",
              border: `1px solid ${p === page ? "color-mix(in srgb, var(--th-accent) 40%, transparent)" : "var(--th-border-subtle)"}`,
              color: p === page ? "var(--th-accent)" : "var(--th-text-secondary)",
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
          background: "color-mix(in srgb, var(--th-text-primary) 4%, transparent)",
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
