import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTabIndicator } from "../hooks/useTabIndicator";
import { useNow } from "../hooks/useNow";
import { DeviceStatusChip } from "./DeviceStatusChip";
import { deviceFreshness, onServerClock, presenceView } from "../utils/devicePresence";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  Archive,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Copy,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  PlayCircle,
  RotateCcw,
  Search,
  ServerOff,
  SlidersHorizontal,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { MobileSheet } from "./mobile/MobileSheet";
import {
  clearDeviceMaintenance,
  Device,
  DeviceFilters,
  DeviceQuickCounts,
  DeviceSortKey,
  enterDeviceMaintenance,
  TRASH_RETENTION_DAYS,
} from "../api/devices";
import { Client } from "../api/clients";
import { FilterSheet } from "./FilterSheet";
import { PatchStatus } from "../api/inventory";
import { ActionType, queueDeviceAction } from "../api/actions";
import { getConnectUrl } from "../api/remoteSupport";
import { deviceDisplayName, deviceHostnameSubtitle } from "../utils/deviceLabel";
import { isValidRustDeskId, buildRustDeskFallbackUrlFromTechiUrl, launchConnect } from "../services/rustdeskLaunch";
import { DeviceHealthSummary } from "../types/telemetry";
import { Button, ConnectButton, EmptyState, Select, TablePagination } from "./ui";
import ConfirmationModal from "./ConfirmationModal";
import { ApiError } from "../api/client";
import BulkAgentUpdatePlan, { useSelfUpdatePreview } from "./BulkAgentUpdatePlan";
import { sendBulkCommand } from "../api/agentCommands";
import { parseUTC, tiranaInputToUtcIso, utcToTiranaInput } from "../utils/time";
import { formatCount } from "../utils/number";
import { hasStructuralConnectMethod, TERMS, TONE } from "../utils/deviceStatus";
import {
  ActionIndicator,
  ActiveActionEntry,
  AgentVersionSources,
  BadgeView,
  ClientOfflineSummary,
  agentVersionView,
  deviceTypeLabel,
  duplicateBadge,
  healthTone,
  lifecycleBadges,
  maintenanceBadge,
  offlineReasonBadge,
  patchBadge,
  remoteSupportIssue,
  userSourceBadge,
} from "../utils/deviceBadges";
import { DeviceMobileCard } from "./DeviceMobileCard";
import { toggled } from "../utils/sets";
import PlatformIcon from "./PlatformIcon";
import SiteLine from "./SiteLine";
import VersionBadge from "./VersionBadge";
import { usePlatformFeatures } from "../hooks/usePlatformFeatures";
import ConnectMenu from "./ConnectMenu";
import { CONNECT_REFRESH_EVENT, ConnectRowStatus, getConnectStatuses } from "../api/connect";
import { detectOperatorOS } from "../utils/operatorOs";
import { useNewKeys } from "../hooks/useLiveChange";
import { cancelDevicePrefetch, prefetchDeviceOnHover } from "../utils/devicePrefetch";

export type { ActiveActionEntry };

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
  /** Move to the trash; rejects with the API error so the dialog can show it. */
  onDeviceDelete?: (device: Device, reason: string, mfaCode: string) => Promise<void>;
  /** Delete a device in the trash for good. */
  onDevicePurge?: (device: Device, mfaCode: string) => Promise<void>;
  onDeviceArchive?: (device: Device) => void;
  onDeviceRestore?: (device: Device) => void;
  healthMap?: Record<number, DeviceHealthSummary>;
  patchMap?: Record<number, PatchStatus>;
  activeActionMap?: Record<number, ActiveActionEntry>;
  alertsMap?: Record<number, { critical: number; warning: number }>;
  canOperate?: boolean;
  /** Admin and owner: "Update agent" in the bulk bar. */
  canUpdateAgents?: boolean;
  canDelete?: boolean;
  currentUser?: string;
  onBulkComplete?: () => void;
  favorites?: Set<number>;
  onToggleFavorite?: (deviceId: number) => void;
  quickFilter: QuickFilter;
  onQuickFilterChange: (filter: QuickFilter) => void;
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
  // Connect ▸ Embedded Terminal from a Catalog row opens the device's
  // drawer directly on its Terminal tab (the terminal lives there).
  onOpenDeviceTerminal?: (device: Device) => void;
  toolbarExtra?: React.ReactNode;
  /** Server-side counts for every tab and quick filter over the current
   *  selection; computed with the same conditions as the list. */
  quickCounts?: DeviceQuickCounts["counts"];
  /** Devices per agent version in the current selection ("unknown" = none). */
  agentVersionCounts?: Record<string, number>;
  sortKey: DeviceSortKey;
  sortDir: "asc" | "desc";
  onSortChange: (key: DeviceSortKey) => void;
  agentVersionFilter: string;
  onAgentVersionFilterChange: (value: string) => void;
}

export type QuickFilter =
  | "all"
  | "online"
  | "stale"
  | "offline"
  | "servers"
  | "workstations"
  | "needs_updates"
  | "reboot_required"
  | "warnings"
  | "critical"
  | "healthy"
  | "maintenance"
  | "needs_attention"
  | "low_health"
  | "rustdesk_issues"
  | "favorites"
  | "needs_agent_update";

const STATUS_TABS: {
  id: "all" | "online" | "stale" | "offline" | "critical" | "warnings";
  label: string;
  tone?: string;
}[] = [
  { id: "all", label: "All" },
  { id: "online", label: "Online", tone: "var(--th-status-online)" },
  { id: "stale", label: "Stale", tone: "var(--th-status-stale)" },
  { id: "offline", label: "Offline", tone: "var(--th-status-offline)" },
  { id: "critical", label: "Critical", tone: "var(--th-status-critical)" },
  { id: "warnings", label: "Warnings", tone: "var(--th-status-warning)" },
];
const STATUS_TAB_IDS = new Set<QuickFilter>(STATUS_TABS.map((t) => t.id));

const QUICK_FILTERS: { id: QuickFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "online", label: "Online" },
  { id: "stale", label: "Stale" },
  { id: "offline", label: "Offline" },
  { id: "servers", label: "Servers" },
  { id: "workstations", label: TERMS.clientPcs },
  { id: "needs_updates", label: "Needs updates" },
  { id: "reboot_required", label: "Reboot required" },
  { id: "warnings", label: "Warnings" },
  { id: "critical", label: "Critical" },
  { id: "healthy", label: "Healthy" },
  { id: "maintenance", label: "Maintenance" },
  { id: "needs_attention", label: "Needs attention" },
  { id: "low_health", label: "Low health" },
  { id: "rustdesk_issues", label: "Remote Support issues" },
  { id: "needs_agent_update", label: "Agent update" },
  { id: "favorites", label: "Favorites" },
];

type PendingAction = "archive" | "restore" | "delete" | "purge";

// ─── Visual constants ────────────────────────────────────────────────────────

const ACTION_MENU_WIDTH = 240;
const ACTION_MENU_MAX_HEIGHT = 340;
const ACTION_MENU_GAP = 6;
const ACTION_MENU_MARGIN = 8;

// ─── Cell helpers ────────────────────────────────────────────────────────────

function CompactBadge({ view }: { view: BadgeView }) {
  return (
    <span
      className="th-tag"
      data-neutral={view.tone === TONE.neutral || undefined}
      style={{ "--chip-tone": view.tone } as React.CSSProperties}
      title={view.title}
    >
      {view.label}
    </span>
  );
}

const ROW_TAG_LIMIT = 2;

// Sized to their content; the free width goes to the text columns.
const FIT_COLUMNS = new Set(["Health", "IP address", "Agent", "Actions"]);

// One line under the device name, so every row has the same height: the most
// urgent tags first, the rest folded into "+N" with their names in its tooltip.
function RowTags({ device, patch, remote }: { device: Device; patch: BadgeView | null; remote: BadgeView | null }) {
  const tags = [
    maintenanceBadge(device),
    patch && patch.tone !== TONE.neutral ? patch : null,
    remote,
    duplicateBadge(device),
    ...lifecycleBadges(device),
    patch && patch.tone === TONE.neutral ? patch : null,
  ].filter((tag): tag is BadgeView => tag !== null);
  const hidden = tags.slice(ROW_TAG_LIMIT);
  return (
    <>
      {tags.slice(0, ROW_TAG_LIMIT).map((tag) => (
        <CompactBadge key={tag.label} view={tag} />
      ))}
      {hidden.length > 0 && (
        <CompactBadge
          view={{
            label: `+${hidden.length}`,
            tone: TONE.neutral,
            title: hidden.map((tag) => tag.title ?? tag.label).join("\n"),
          }}
        />
      )}
    </>
  );
}

/** Minutes from now until the next midnight in Tirana. */
function minutesUntilTiranaMidnight(): number {
  const today = utcToTiranaInput(new Date().toISOString()).slice(0, 10);
  const [y, m, d] = today.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return Math.round((new Date(tiranaInputToUtcIso(`${tomorrow}T00:00`)).getTime() - Date.now()) / 60000);
}

type BulkActionType =
  | "restart_device"
  | "restart_agent"
  | "update_agent"
  | "sync_rustdesk"
  | "reinstall_rustdesk"
  | "maintenance_enter"
  | "maintenance_exit";

const devicesPhrase = (n: number) => `${formatCount(n)} ${n === 1 ? "device" : "devices"}`;

const BULK_ACTIONS: Record<
  BulkActionType,
  {
    button: string;
    confirm: string;
    destructive: boolean;
    title: (devices: string) => string;
    description: string;
    done: (devices: string) => string;
  }
> = {
  restart_device: {
    button: "Restart",
    confirm: "Restart",
    destructive: true,
    title: (n) => `Restart ${n}?`,
    description:
      "Each device restarts as soon as its agent picks up the request. Signed-in users may lose unsaved work.",
    done: (n) => `Restart requested for ${n}`,
  },
  restart_agent: {
    button: "Restart agent",
    confirm: "Restart agent",
    destructive: true,
    title: (n) => `Restart the agent on ${n}?`,
    description: "The devices drop out of monitoring for a few seconds while the agent restarts.",
    done: (n) => `Agent restart requested for ${n}`,
  },
  update_agent: {
    button: "Update agent",
    confirm: "Update",
    destructive: false,
    title: (n) => `Update the agent on ${n}?`,
    description: "",
    done: (n) => `Agent update started on ${n}`,
  },
  sync_rustdesk: {
    button: `Sync ${TERMS.remoteSupport}`,
    confirm: "Sync",
    destructive: false,
    title: (n) => `Sync ${TERMS.remoteSupport} on ${n}?`,
    description: `Each device reports its current ${TERMS.remoteSupport} ID and state again.`,
    done: (n) => `${TERMS.remoteSupport} sync requested for ${n}`,
  },
  reinstall_rustdesk: {
    button: `Reinstall ${TERMS.remoteSupport}`,
    confirm: "Reinstall",
    destructive: true,
    title: (n) => `Reinstall ${TERMS.remoteSupport} on ${n}?`,
    description: `Active ${TERMS.remoteSupport} sessions on these devices end while it reinstalls.`,
    done: (n) => `${TERMS.remoteSupport} reinstall requested for ${n}`,
  },
  maintenance_enter: {
    button: "Start maintenance",
    confirm: "Start maintenance",
    destructive: false,
    title: (n) => `Put ${n} in maintenance?`,
    description: "Alerts are paused for these devices until maintenance ends.",
    done: (n) => `${n.charAt(0).toUpperCase()}${n.slice(1)} put in maintenance`,
  },
  maintenance_exit: {
    button: "End maintenance",
    confirm: "End maintenance",
    destructive: false,
    title: (n) => `End maintenance on ${n}?`,
    description: "Alerts resume for these devices straight away.",
    done: (n) => `Maintenance ended on ${n}`,
  },
};

type MaintenanceDuration = "1h" | "4h" | "8h" | "tomorrow" | "indefinite";

const MAINTENANCE_DURATIONS: { id: MaintenanceDuration; label: string; minutes: () => number | null }[] = [
  { id: "1h", label: "1 hour", minutes: () => 60 },
  { id: "4h", label: "4 hours", minutes: () => 240 },
  { id: "8h", label: "8 hours", minutes: () => 480 },
  { id: "tomorrow", label: "Until midnight", minutes: minutesUntilTiranaMidnight },
  { id: "indefinite", label: "No end time", minutes: () => null },
];

const BULK_BAR_ACTIONS: BulkActionType[] = [
  "restart_device",
  "restart_agent",
  "update_agent",
  "sync_rustdesk",
  "reinstall_rustdesk",
  "maintenance_enter",
  "maintenance_exit",
];

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
  onDevicePurge,
  onDeviceArchive,
  onDeviceRestore,
  healthMap = {},
  patchMap = {},
  activeActionMap = {},
  alertsMap = {},
  canOperate = false,
  canUpdateAgents = false,
  canDelete = false,
  currentUser,
  onBulkComplete,
  favorites = new Set<number>(),
  onToggleFavorite,
  quickFilter,
  onQuickFilterChange,
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
  onOpenDeviceTerminal,
  toolbarExtra,
  quickCounts,
  agentVersionCounts,
  sortKey,
  sortDir,
  onSortChange,
  agentVersionFilter,
  onAgentVersionFilterChange,
}: DevicesTableProps) {
  // Rows age on the shared clock: a device turns stale or offline on time.
  const now = useNow();
  const navigate = useNavigate();
  // Platform Expansion: show the platform icon only when Linux is enabled, so
  // with the flag off the catalog is visually identical to today.
  const platformFeatures = usePlatformFeatures();
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [openActionDeviceId, setOpenActionDeviceId] = useState<number | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const [pendingAction, setPendingAction] = useState<{ type: PendingAction; device: Device } | null>(null);
  type SortKey = DeviceSortKey;
  // Mobile UI 2.0 (MOBILE-DESIGN-SPEC.md — Devices/Sort): sort sheet, mobile-only.
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const SORT_OPTIONS: { key: SortKey; label: string }[] = [
    { key: "hostname", label: "Name" },
    { key: "last_seen", label: "Last seen" },
    { key: "client_name", label: "Client" },
    { key: "health", label: "Health" },
  ];

  const handleSort = onSortChange;

  const applyQuickFilter = (f: QuickFilter) => {
    onQuickFilterChange(f === quickFilter ? "all" : f);
  };
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [pendingBulkAction, setPendingBulkAction] = useState<BulkActionType | null>(null);
  const [bulkMaintDuration, setBulkMaintDuration] = useState<MaintenanceDuration>("1h");
  const [bulkToast, setBulkToast] = useState<{ message: string; ok: boolean } | null>(null);
  const bulkToastTimer = useRef<number | undefined>();
  const showBulkToast = (message: string, ok: boolean) => {
    setBulkToast({ message, ok });
    window.clearTimeout(bulkToastTimer.current);
    bulkToastTimer.current = window.setTimeout(() => setBulkToast(null), 4000);
  };
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const agentSources = useMemo<AgentVersionSources>(
    () => ({ activePackageVersion, activePackageSha256, activeConnectorVersions, activeAgentVersions }),
    [activePackageVersion, activePackageSha256, activeConnectorVersions, activeAgentVersions],
  );
  const scrollPositionRef = useRef({ left: 0, top: 0 });
  // The last non-empty quick-filter row, so it can close smoothly when the
  // counts drop to zero instead of vanishing mid-animation.
  const lastQuickFilters = useRef<{ id: QuickFilter; label: string; count: number }[]>([]);

  const pillCounts = useMemo(() => {
    const counts = Object.fromEntries(QUICK_FILTERS.map(({ id }) => [id, 0])) as Record<QuickFilter, number>;
    if (!quickCounts) return counts;
    for (const id of Object.keys(counts) as QuickFilter[]) {
      counts[id] = quickCounts[id as keyof typeof quickCounts] ?? 0;
    }
    counts.all = quickCounts.all;
    return counts;
  }, [quickCounts]);

  // Agent versions present in the whole selection, newest first.
  const agentVersionOptions = useMemo(
    () =>
      Object.keys(agentVersionCounts ?? {})
        .filter((v) => v !== "unknown")
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
    [agentVersionCounts],
  );

  // Filtering and sorting run on the server over the whole selection; the
  // rows arrive already in order.
  const displayDevices = devices;
  const newDevices = useNewKeys(displayDevices.map((device) => device.id));

  // Realtime heartbeats replace the rows constantly; keep the selection and
  // drop only rows that are no longer shown, so a bulk action never reaches a
  // device the operator cannot see.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(displayDevices.map((d) => d.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [displayDevices]);

  // Approved V3 Connect mockup — the Catalog Connect button carries a real
  // per-row state (Ready / Credential required / Unavailable) for every
  // non-Windows row, fetched in ONE batched /connect-status call for the
  // visible rows (never per-row N+1). Refreshed on CONNECT_REFRESH_EVENT so
  // adding a credential / changing a default updates the buttons immediately.
  const [connectStatusMap, setConnectStatusMap] = useState<Record<number, ConnectRowStatus>>({});
  const nonWindowsIdsKey = useMemo(
    () =>
      displayDevices
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
          rows.forEach((r) => {
            map[r.device_id] = r;
          });
          setConnectStatusMap(map);
        })
        .catch(() => {
          /* row buttons fall back to the structural check */
        });
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
        label: TERMS.noClient,
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
        label: filters.device_type === "server" ? TERMS.servers : TERMS.clientPcs,
        onClear: () => onFilterChange("device_type", undefined),
      });
    }
    return chips;
  }, [quickFilter, filters.client_id, filters.device_type, clients, onQuickFilterChange, onFilterChange]);

  // Status is chosen with the chips above the list; the rest of the
  // filters show as removable chips under them.
  const mobileRefinements = activeChips.filter(
    (chip) => !(chip.key === "quick" && STATUS_TABS.some((tab) => tab.id === quickFilter)),
  );

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
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [mobileHasMore, mobileLoadingMore, onMobileLoadMore, displayDevices.length]);

  const offlineSummaryByClient = useMemo(() => {
    const summaries = new Map<number, ClientOfflineSummary>();
    for (const device of devices) {
      if (!device.client_id) continue;
      const freshness = deviceFreshness(device, onServerClock(now));
      const summary = summaries.get(device.client_id) ?? { offlineCount: 0, inactiveLastSeen: [] };
      if (freshness === "offline") summary.offlineCount += 1;
      if ((freshness === "offline" || freshness === "stale") && device.last_seen) {
        summary.inactiveLastSeen.push(parseUTC(device.last_seen).getTime());
      }
      summaries.set(device.client_id, summary);
    }
    return summaries;
  }, [devices, now]);

  const allSelected = displayDevices.length > 0 && displayDevices.every((d) => selectedIds.has(d.id));
  const someSelected = !allSelected && displayDevices.some((d) => selectedIds.has(d.id));
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(displayDevices.map((d) => d.id)));
  const toggleOne = (id: number) => setSelectedIds((prev) => toggled(prev, id));

  // The sticky Actions column only needs a divider while the table actually
  // scrolls sideways and content is passing underneath it.
  const [hasOverflow, setHasOverflow] = useState(false);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const measure = () => setHasOverflow(node.scrollWidth - node.clientWidth - node.scrollLeft > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", measure);
    };
  }, [devices.length]);

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
      ? (displayDevices.find((d) => d.id === openActionDeviceId) ??
        devices.find((d) => d.id === openActionDeviceId) ??
        null)
      : null;

  const getMenuAnchor = (trigger: HTMLElement) => {
    const rect = trigger.getBoundingClientRect();
    const availableBelow = window.innerHeight - rect.bottom - ACTION_MENU_MARGIN;
    const opensUp = availableBelow < ACTION_MENU_MAX_HEIGHT && rect.top > availableBelow;
    const top = opensUp
      ? Math.max(ACTION_MENU_MARGIN, rect.top - ACTION_MENU_MAX_HEIGHT - ACTION_MENU_GAP)
      : Math.max(
          ACTION_MENU_MARGIN,
          Math.min(rect.bottom + ACTION_MENU_GAP, window.innerHeight - ACTION_MENU_MAX_HEIGHT - ACTION_MENU_MARGIN),
        );
    const preferredLeft = rect.right - ACTION_MENU_WIDTH;
    const left = Math.min(
      Math.max(ACTION_MENU_MARGIN, preferredLeft),
      window.innerWidth - ACTION_MENU_WIDTH - ACTION_MENU_MARGIN,
    );
    return { top, left };
  };

  const confirmAction = () => {
    if (!pendingAction) return;
    if (pendingAction.type === "archive") onDeviceArchive?.(pendingAction.device);
    if (pendingAction.type === "restore") onDeviceRestore?.(pendingAction.device);
    setPendingAction(null);
  };

  const updateIds = useMemo(
    () => (pendingBulkAction === "update_agent" ? [...selectedIds].sort((a, b) => a - b) : null),
    [pendingBulkAction, selectedIds],
  );
  const updatePlan = useSelfUpdatePreview(updateIds);

  const runAgentUpdate = async () => {
    const ids = updatePlan.data?.update.map((u) => u.device_id) ?? [];
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      const result = await sendBulkCommand({
        command_type: "self_update",
        target: "devices",
        device_ids: ids,
        payload: {},
        // The API takes 10–600 s; for self_update it raises the window to 900 s itself.
        timeout_seconds: 600,
      });
      const skipped = (result.skipped?.length ?? 0) + (updatePlan.data?.skipped.length ?? 0);
      const parts = [BULK_ACTIONS.update_agent.done(devicesPhrase(result.device_count))];
      if (result.pushed) parts.push(`${formatCount(result.pushed)} at once`);
      if (skipped) parts.push(`${formatCount(skipped)} left out`);
      showBulkToast(parts.join(" · "), true);
      setSelectedIds(new Set());
      onBulkComplete?.();
    } catch (err) {
      showBulkToast(err instanceof Error ? err.message : "Agent update failed", false);
    } finally {
      setBulkBusy(false);
      setPendingBulkAction(null);
    }
  };

  const runBulkAction = async (action: BulkActionType) => {
    if (action === "update_agent") return runAgentUpdate();
    const selectedDevices = devices.filter((d) => selectedIds.has(d.id));
    const durationMinutes = MAINTENANCE_DURATIONS.find((opt) => opt.id === bulkMaintDuration)?.minutes() ?? null;
    setBulkBusy(true);
    let ok = 0;
    let fail = 0;
    try {
      for (const d of selectedDevices) {
        try {
          if (action === "maintenance_enter") {
            await enterDeviceMaintenance(d.id, {
              duration_minutes: durationMinutes,
              started_by: currentUser ?? "operator",
            });
          } else if (action === "maintenance_exit") {
            await clearDeviceMaintenance(d.id);
          } else {
            await queueDeviceAction(d.id, { action_type: action as ActionType, created_by: currentUser ?? "operator" });
          }
          ok++;
        } catch {
          fail++;
        }
      }
      const failed = fail ? ` · ${devicesPhrase(fail)} failed` : "";
      showBulkToast(
        ok ? `${BULK_ACTIONS[action].done(devicesPhrase(ok))}${failed}` : `${devicesPhrase(fail)} failed`,
        fail === 0,
      );
      setSelectedIds(new Set());
      onBulkComplete?.();
    } finally {
      setBulkBusy(false);
      setPendingBulkAction(null);
    }
  };

  const statusTabsRef = useTabIndicator<HTMLDivElement>(quickFilter);

  return (
    <div className="space-y-2.5 xl:flex xl:h-full xl:min-h-0 xl:flex-col xl:gap-2.5 xl:space-y-0">
      {/* ── Bulk Action Bar ── */}
      {selectedIds.size > 0 && canOperate && (
        <div
          className="th-bulk-bar flex flex-wrap items-center gap-2 rounded-xl px-4 py-3"
          style={{
            background: "color-mix(in srgb, var(--th-accent) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--th-accent) 25%, transparent)",
          }}
          role="region"
          aria-label="Bulk actions"
        >
          <span className="text-sm font-semibold" style={{ color: "var(--th-accent)" }}>
            {devicesPhrase(selectedIds.size)} selected
          </span>
          <div className="ml-2 flex flex-wrap gap-1.5">
            {BULK_BAR_ACTIONS.filter((action) => action !== "update_agent" || canUpdateAgents).map((action) => (
              <Button
                key={action}
                size="sm"
                variant={BULK_ACTIONS[action].destructive ? "danger" : "secondary"}
                disabled={bulkBusy}
                onClick={() => setPendingBulkAction(action)}
              >
                {BULK_ACTIONS[action].button}
              </Button>
            ))}
          </div>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelectedIds(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      <div
        className="hidden md:block rounded-xl"
        style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
      >
        {/* Status tabs — fleet-wide counts for the current explorer scope */}
        <div
          className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-4 pt-2"
          style={{ borderBottom: "1px solid var(--th-border-subtle)" }}
        >
          <div ref={statusTabsRef} role="tablist" aria-label="Device status" className="th-tabs">
            {STATUS_TABS.map(({ id, label, tone }) => {
              const count = pillCounts[id];
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={quickFilter === id}
                  onClick={() => applyQuickFilter(quickFilter === id && id !== "all" ? "all" : id)}
                  className="th-tab"
                  style={{ "--tab-tone": tone } as React.CSSProperties}
                >
                  {tone && <span className="th-tab-dot" aria-hidden="true" />}
                  {label}
                  <span className="th-tab-count">{count}</span>
                </button>
              );
            })}
          </div>
          <div className="pb-2">{toolbarExtra}</div>
        </div>

        {/* Search + refinements */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <label className="th-search min-w-[240px] flex-1">
            <Search className="h-4 w-4 flex-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search name, hostname, user, domain or IP…"
              aria-label="Search devices"
            />
          </label>
          <Select
            id="filter-lifecycle-state"
            aria-label="Filter by lifecycle state"
            className="w-[176px]"
            value={(filters.lifecycle_state || "active") as string}
            onChange={(v) => onFilterChange("lifecycle_state", v)}
            options={[
              { value: "active", label: "Active devices", hint: "Excludes archived devices" },
              { value: "archived", label: "Archived devices", hint: "Retired, kept for history" },
              { value: "all", label: "All devices", hint: "Active and archived" },
              { value: "trash", label: "Trash", hint: "Deleted, restorable for 30 days" },
            ]}
          />
          <Select
            id="filter-maintenance-state"
            aria-label="Filter by maintenance state"
            className="w-[176px]"
            value={filters.duplicate_candidates ? "duplicate" : filters.maintenance_state || "all"}
            onChange={(value) => {
              if (value === "duplicate") {
                onFilterChange("maintenance_state", undefined);
                onFilterChange("duplicate_candidates", true);
                return;
              }
              onFilterChange("duplicate_candidates", undefined);
              onFilterChange("maintenance_state", value === "all" ? undefined : value);
            }}
            options={[
              { value: "all", label: "All signals" },
              { value: "maintenance", label: "In maintenance", hint: "Alerts paused for these devices" },
              { value: "normal", label: "Normal only", hint: "Not in maintenance" },
              { value: "duplicate", label: "Duplicates only", hint: "Possible duplicate enrollments" },
            ]}
          />
          <Select
            id="filter-agent-version"
            aria-label="Filter by agent version"
            className="w-[160px]"
            value={agentVersionFilter}
            onChange={onAgentVersionFilterChange}
            options={[
              { value: "all", label: "All versions" },
              ...agentVersionOptions.map((v) => ({ value: v, label: `Agent ${v}` })),
              { value: "unknown", label: "Unknown version" },
            ]}
          />
        </div>

        {/* Secondary quick filters — only the ones that currently match devices.
            The row opens and closes smoothly (no jump of the table below it),
            chips come in one after another, and a changed count fades in. */}
        {(() => {
          const extras = QUICK_FILTERS.filter((f) => !STATUS_TAB_IDS.has(f.id))
            .map((f) => ({
              ...f,
              count: pillCounts[f.id],
            }))
            .filter((f) => f.count > 0 || quickFilter === f.id);
          if (extras.length > 0) lastQuickFilters.current = extras;
          const shown = extras.length > 0 ? extras : lastQuickFilters.current;
          return (
            <div
              className="th-quick-filters"
              data-open={extras.length > 0}
              aria-hidden={extras.length === 0 || undefined}
            >
              <div>
                {shown.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
                    <span className="th-quick-filters-label mr-1 text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                      Quick filters
                    </span>
                    {shown.map((f, index) => (
                      <button
                        key={f.id}
                        type="button"
                        aria-pressed={quickFilter === f.id}
                        onClick={() => applyQuickFilter(quickFilter === f.id ? "all" : f.id)}
                        className="th-filter-chip"
                        tabIndex={extras.length === 0 ? -1 : undefined}
                        style={{ "--i": index + 1 } as React.CSSProperties}
                      >
                        {f.label}
                        <span
                          key={f.count}
                          className="th-filter-chip-count tabular-nums"
                          style={{ color: "var(--th-text-faint)" }}
                        >
                          {f.count}
                        </span>
                        {quickFilter === f.id && <X className="h-3 w-3" aria-label="Clear filter" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      {/* ── Mobile (< 768px): the toolbar stays visible in every state, so
          an empty search is never a dead end (MOBILE-DESIGN-SPEC.md —
          Devices/Empty States). ── */}
      <div className="th-onb md:hidden">
        <div className="th-mdev-toolbar">
          <div className="flex items-center gap-2">
            <label className="th-search h-10 flex-1">
              <Search className="h-4 w-4 flex-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="Search devices…"
                aria-label="Search devices"
                enterKeyHint="search"
              />
            </label>
            <button
              type="button"
              onClick={() => setFilterSheetOpen(true)}
              aria-label="Filters"
              className="th-mdev-tool"
              data-active={mobileRefinements.length > 0 || undefined}
            >
              <SlidersHorizontal className="h-4 w-4" />
              {mobileRefinements.length > 0 && <i aria-hidden="true" />}
            </button>
            <button type="button" onClick={() => setSortSheetOpen(true)} aria-label="Sort" className="th-mdev-tool">
              <ArrowUpDown className="h-4 w-4" />
            </button>
          </div>
          <div className="th-mdev-chips" role="tablist" aria-label="Status">
            {STATUS_TABS.map(({ id, label, tone }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={quickFilter === id}
                onClick={() => applyQuickFilter(quickFilter === id && id !== "all" ? "all" : id)}
                className="th-mdev-chip"
                style={{ "--chip-tone": tone } as React.CSSProperties}
              >
                {tone && <i aria-hidden="true" />}
                {label}
                <span className="tabular-nums">{formatCount(pillCounts[id])}</span>
              </button>
            ))}
          </div>
          {mobileRefinements.length > 0 && (
            <div className="th-mdev-chips">
              {mobileRefinements.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={chip.onClear}
                  className="th-mdev-chip"
                  data-active="true"
                  aria-label={`Clear ${chip.label}`}
                >
                  {chip.label}
                  <X className="h-3 w-3" />
                </button>
              ))}
            </div>
          )}
        </div>

        {!loading && !error && displayDevices.length > 0 && (
          <p className="th-mdev-count tabular-nums">
            {formatCount(total ?? displayDevices.length)} device{(total ?? displayDevices.length) === 1 ? "" : "s"}
          </p>
        )}

        {loading ? (
          <div className="th-mdev-list mt-3" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="th-onb-card th-mdev-card" style={{ opacity: 1 - i * 0.12 }}>
                <div className="th-alerts-skeleton !m-0 !h-4 !w-40" />
                <div className="th-alerts-skeleton !m-0 !mt-2 !h-3 !w-56" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="th-onb-card mt-3">
            <EmptyState
              className="py-10"
              icon={<ServerOff className="h-5 w-5" />}
              title="Unable to load devices"
              description={error}
              action={
                <Button variant="secondary" onClick={onRefresh} size="sm">
                  Try again
                </Button>
              }
            />
          </div>
        ) : displayDevices.length === 0 ? (
          <div className="th-onb-card mt-3">
            {searchQuery ? (
              <EmptyState
                className="py-10"
                icon={<Search className="h-5 w-5" />}
                title={`No results for "${searchQuery}"`}
                description="Searched across name, hostname, user, domain and IP."
                action={
                  <Button size="sm" variant="secondary" onClick={() => onSearch("")}>
                    Clear search
                  </Button>
                }
              />
            ) : activeChips.length > 0 ? (
              <EmptyState
                className="py-10"
                icon={<SlidersHorizontal className="h-5 w-5" />}
                title="No devices match these filters"
                description="Adjust or clear filters to see more devices."
                action={
                  <Button size="sm" variant="secondary" onClick={clearAllMobileFilters}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                className="py-10"
                icon={<ServerOff className="h-5 w-5" />}
                title="No devices found"
                description="Adjust filters or search terms to reveal devices."
              />
            )}
          </div>
        ) : (
          <div className="th-mdev-list">
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
                  offlineSummary={device.client_id ? offlineSummaryByClient.get(device.client_id) : undefined}
                  canConnect={canConnect}
                  isFavorite={favorites.has(device.id)}
                  agentVersion={agentVersionView(device, agentSources)}
                  onSelect={() => navigate(`/devices/${device.id}`)}
                  onToggleFavorite={onToggleFavorite ? () => onToggleFavorite(device.id) : undefined}
                  onConnect={
                    isWindowsDevice
                      ? async () => {
                          try {
                            const res = await getConnectUrl(device.id);
                            launchConnect(res.connect_url, buildRustDeskFallbackUrlFromTechiUrl(res.connect_url), () =>
                              showBulkToast(`Opening the ${TERMS.remoteSupport} app instead`, true),
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
                {mobileLoadingMore && (
                  <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--th-accent)" }} />
                )}
              </div>
            )}
          </div>
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
                onClick={() => {
                  handleSort(opt.key);
                  setSortSheetOpen(false);
                }}
                aria-pressed={active}
                className="th-msheet-option"
              >
                <span>{opt.label}</span>
                {active && (
                  <span className="flex items-center gap-1 text-[12px]">
                    {sortDir === "asc" ? "Ascending" : "Descending"}
                    {sortDir === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </MobileSheet>

      {/* ── Desktop (≥ 768px) — unchanged states/table/footer, now scoped
          to desktop only since Mobile has its own block above ── */}
      {loading ? (
        // The same shimmer rows as Alerts, Operators and the client profile,
        // in the table's own card.
        <div
          className="hidden md:block overflow-hidden rounded-xl"
          style={{ border: "1px solid var(--th-border-card)", background: "var(--th-bg-card)" }}
          aria-busy="true"
          aria-label="Loading devices"
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.09 }} />
          ))}
        </div>
      ) : error ? (
        <div className="hidden md:block premium-card-soft">
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title="Unable to load devices"
            description={error}
            action={
              <Button variant="secondary" size="sm" onClick={onRefresh}>
                Try again
              </Button>
            }
          />
        </div>
      ) : displayDevices.length === 0 ? (
        <div className="hidden md:block premium-card-soft">
          {searchQuery ? (
            <EmptyState
              icon={<ServerOff className="h-5 w-5" />}
              title={`No results for "${searchQuery}"`}
              description="Searched across name, hostname, user, domain and IP."
              action={
                <Button variant="secondary" size="sm" onClick={() => onSearch("")}>
                  Clear search
                </Button>
              }
            />
          ) : quickFilter !== "all" ? (
            <EmptyState
              icon={<ServerOff className="h-5 w-5" />}
              title="No devices match this filter"
              description="No device in this selection matches the filter."
              action={
                <Button variant="secondary" size="sm" onClick={() => onQuickFilterChange("all")}>
                  Show all devices
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<ServerOff className="h-5 w-5" />}
              title="No devices found"
              description="Adjust filters or search terms to reveal devices."
            />
          )}
        </div>
      ) : (
        <div
          className="hidden md:block overflow-hidden rounded-xl xl:flex xl:min-h-0 xl:flex-1 xl:flex-col"
          style={{ border: "1px solid var(--th-border-card)", background: "var(--th-bg-card)" }}
        >
          <div className="hidden md:block xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
            <div
              ref={scrollRef}
              className="th-table-scroll overflow-x-auto xl:min-h-0 xl:flex-1 xl:overflow-auto"
              data-overflow={hasOverflow}
              data-loading={tableLoading || undefined}
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
              <table className="min-w-[880px] w-full border-separate border-spacing-0 text-left">
                {/* ── Header ── */}
                <thead>
                  <tr
                    style={{
                      background:
                        "var(--th-bg-table-head, color-mix(in srgb, var(--th-text-primary) 2.5%, transparent))",
                      borderBottom: "1px solid var(--th-border-subtle)",
                    }}
                  >
                    {canOperate && (
                      <th className="w-[36px] px-2 py-2" style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected;
                          }}
                          onChange={toggleAll}
                          className="h-3.5 w-3.5 cursor-pointer rounded accent-orange-500"
                          title="Select all on this page"
                          aria-label="Select all devices on this page"
                        />
                      </th>
                    )}
                    {[
                      { label: "Device", sortable: "hostname" as SortKey },
                      { label: "Status", sortable: "last_seen" as SortKey },
                      { label: "Health", sortable: null },
                      { label: "Client / location", sortable: "client_name" as SortKey },
                      { label: "User / domain", sortable: null },
                      { label: "IP address", sortable: null },
                      { label: "Agent", sortable: null },
                      { label: "Actions", sortable: null },
                    ].map(({ label, sortable }) => (
                      <th
                        key={label}
                        className={`whitespace-nowrap px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.1em] ${sortable ? "cursor-pointer select-none hover:text-slate-200" : ""} ${FIT_COLUMNS.has(label) ? "w-px" : ""} ${label === "Actions" ? "th-sticky-end" : ""}`}
                        style={{
                          color: sortable && sortKey === sortable ? "var(--th-text-primary)" : "var(--th-text-muted)",
                          borderBottom: "1px solid var(--th-border-subtle)",
                        }}
                        onClick={sortable ? () => handleSort(sortable) : undefined}
                      >
                        <span className="inline-flex items-center gap-1">
                          {label}
                          {sortable && sortKey === sortable && (
                            <span className="text-[11px] opacity-70">{sortDir === "asc" ? "▲" : "▼"}</span>
                          )}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>

                {/* ── Rows ── */}
                <tbody>
                  {displayDevices.map((device, rowIndex) => {
                    const isWindowsDevice = !device.platform || device.platform.toLowerCase() === "windows";
                    const canConnect = isWindowsDevice
                      ? isValidRustDeskId(device.rustdesk_id) && !device.rustdesk_conflict_detected
                      : hasStructuralConnectMethod(device);
                    const devAlerts = alertsMap[device.id];
                    const offlineBadge = offlineReasonBadge(
                      device,
                      device.client_id ? offlineSummaryByClient.get(device.client_id) : undefined,
                    );
                    const health = healthMap[device.id];
                    const healthScore = health?.health_score;
                    const rsIssue = remoteSupportIssue(device);
                    const patchView = patchBadge(patchMap[device.id]);
                    const userSource = userSourceBadge(device);
                    const agentVersion = agentVersionView(device, agentSources);

                    return (
                      <tr
                        key={device.id}
                        className="th-device-row group cursor-pointer"
                        data-new={newDevices.has(device.id) || undefined}
                        style={{ "--row": Math.min(rowIndex, 12) } as React.CSSProperties}
                        data-selected={selectedIds.has(device.id)}
                        onClick={() => onDeviceSelect?.(device)}
                        onPointerEnter={(event) => prefetchDeviceOnHover(device.id, event.pointerType)}
                        onPointerLeave={cancelDevicePrefetch}
                      >
                        {canOperate && (
                          <td className="w-[36px] px-2 py-1.5 align-middle" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(device.id)}
                              onChange={() => toggleOne(device.id)}
                              id={`select-device-${device.id}`}
                              name="select-device"
                              aria-label={`Select ${deviceDisplayName(device)}`}
                              className="h-3.5 w-3.5 cursor-pointer rounded accent-orange-500"
                            />
                          </td>
                        )}

                        {/* ── Hostname ── */}
                        <td className="th-device-cell px-2.5 py-1.5 align-middle">
                          {(() => {
                            const label = deviceDisplayName(device);
                            const hostname = deviceHostnameSubtitle(device);
                            const typeLabel = deviceTypeLabel(device);
                            // A group named after the device type already says it in Client / location,
                            // unless that column shows the device's site instead.
                            const showType =
                              !!device.location_name ||
                              typeLabel.toLowerCase() !== (device.group_name ?? "").trim().toLowerCase();
                            return (
                              <>
                                <div
                                  className="flex h-[18px] items-center gap-1.5 text-[13px] font-semibold"
                                  style={{ color: "var(--th-text-primary)" }}
                                  title={[label, hostname, device.os_name].filter(Boolean).join(" · ")}
                                >
                                  <PlatformIcon platform={device.platform} size={13} className="shrink-0 opacity-70" />
                                  <span className="truncate">{label}</span>
                                  {hostname && (
                                    <span
                                      className="min-w-[48px] truncate font-mono text-[11px] font-normal"
                                      style={{ color: "var(--th-text-muted)" }}
                                    >
                                      {hostname}
                                    </span>
                                  )}
                                </div>
                                <div
                                  className="mt-0.5 flex h-4 items-center gap-1 overflow-hidden pl-[21px] text-[12px]"
                                  style={{ color: "var(--th-text-muted)" }}
                                >
                                  {showType && <span className="mr-0.5 min-w-0 truncate">{typeLabel}</span>}
                                  <RowTags device={device} patch={patchView} remote={rsIssue} />
                                </div>
                              </>
                            );
                          })()}
                        </td>

                        {/* ── Status ── */}
                        <td className="whitespace-nowrap px-2.5 py-1.5 align-middle">
                          {/* A fixed width: the column neither jumps as a row's words
                              change nor grows the table; a long reason ends in "…"
                              and reads in full on hover. */}
                          <DeviceStatusChip device={device} layout="stacked" hint={offlineBadge} className="w-[136px]">
                            {activeActionMap[device.id] && <ActionIndicator entry={activeActionMap[device.id]} />}
                          </DeviceStatusChip>
                        </td>

                        {/* ── Health ── */}
                        <td className="whitespace-nowrap px-2.5 py-1.5 align-middle">
                          <div className="flex items-center gap-2">
                            <span
                              className="th-score"
                              data-tone={healthTone(health)}
                              title={healthScore == null ? "No health score yet" : `Health score ${healthScore} of 100`}
                            >
                              {healthScore ?? "—"}
                            </span>
                            {(devAlerts?.critical ?? 0) + (devAlerts?.warning ?? 0) > 0 && (
                              <span
                                className="th-alert-count"
                                data-tone={devAlerts?.critical ? "critical" : "warning"}
                                title={`${devAlerts?.critical ?? 0} critical · ${devAlerts?.warning ?? 0} warning open alerts`}
                              >
                                <AlertTriangle className="h-3 w-3" />
                                {(devAlerts?.critical ?? 0) + (devAlerts?.warning ?? 0)}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* ── Client / Location ── */}
                        <td className="px-2.5 py-1.5 align-middle">
                          <div
                            className="max-w-[160px] truncate text-[12px] font-semibold leading-[1.3]"
                            style={{ color: "var(--th-text-primary)" }}
                            title={device.client_name || TERMS.noClient}
                          >
                            {device.client_name || (
                              <span style={{ color: "var(--th-text-muted)" }}>{TERMS.noClient}</span>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1">
                            {device.location_name ? (
                              // The client's site, where it has sites; the group otherwise.
                              <SiteLine
                                device={device}
                                className="max-w-[180px] text-[12px] text-[var(--th-text-muted)]"
                              />
                            ) : (
                              <span
                                className="max-w-[160px] truncate text-[12px]"
                                style={{ color: "var(--th-text-muted)" }}
                                title={device.group_name || TERMS.noGroup}
                              >
                                {device.group_name || TERMS.noGroup}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* ── User ── */}
                        <td className="whitespace-nowrap px-2.5 py-1.5 align-middle">
                          <div className="flex items-center gap-1">
                            <span
                              className="max-w-[140px] truncate text-[12px] font-medium"
                              style={{ color: "var(--th-text-secondary)" }}
                              title={device.current_user || undefined}
                            >
                              {device.current_user || "—"}
                            </span>
                            {userSource && <CompactBadge view={userSource} />}
                          </div>
                          <div
                            className="max-w-[160px] truncate text-[11px]"
                            style={{ color: "var(--th-text-muted)" }}
                            title={device.domain || undefined}
                          >
                            {device.domain || "—"}
                          </div>
                        </td>

                        {/* ── IP (public + local stacked) ── */}
                        <td className="whitespace-nowrap px-2.5 py-1.5 align-middle">
                          <div className="font-mono text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                            {device.public_ip || "—"}
                          </div>
                          {device.local_ip && (
                            <div className="font-mono text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                              {device.local_ip}
                            </div>
                          )}
                        </td>

                        {/* ── Agent version ── */}
                        <td className="whitespace-nowrap px-2.5 py-1.5 align-middle">
                          <VersionBadge
                            version={device.agent_version}
                            status={agentVersion.status}
                            title={agentVersion.title}
                          />
                        </td>

                        {/* ── Actions ── */}
                        <td className="th-sticky-end px-2.5 py-1.5 align-middle" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-1.5">
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
                              <ConnectButton
                                size="sm"
                                onClick={
                                  isWindowsDevice
                                    ? async () => {
                                        try {
                                          const res = await getConnectUrl(device.id);
                                          launchConnect(
                                            res.connect_url,
                                            buildRustDeskFallbackUrlFromTechiUrl(res.connect_url),
                                            () => showBulkToast(`Opening the ${TERMS.remoteSupport} app instead`, true),
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
                                        : `${TERMS.remoteSupportId} not resolved yet`
                                    : canConnect
                                      ? "Open device to connect (SSH/Winbox/WebFig/Terminal)"
                                      : "No Connect method available for this device yet"
                                }
                                disabled={!canConnect}
                              />
                            ) : (
                              <ConnectMenu
                                variant="row"
                                lazyLoad
                                deviceId={device.id}
                                hostname={device.hostname}
                                initialState={connectStatusMap[device.id]?.state ?? (canConnect ? null : "unavailable")}
                                initialStateReason={
                                  connectStatusMap[device.id]?.reason ??
                                  (canConnect ? null : "No Connect method available for this device yet")
                                }
                                onOpenTerminal={onOpenDeviceTerminal ? () => onOpenDeviceTerminal(device) : undefined}
                              />
                            )}

                            {/* Star / favourite: after Connect, so Connect starts under the column heading */}
                            {onToggleFavorite && (
                              <button
                                type="button"
                                onClick={() => onToggleFavorite(device.id)}
                                title={favorites.has(device.id) ? "Remove from favorites" : "Add to favorites"}
                                aria-label={favorites.has(device.id) ? "Remove from favorites" : "Add to favorites"}
                                className={`flex h-7 w-7 items-center justify-center rounded-md transition-opacity hover:bg-[var(--th-sidebar-nav-hover)] ${favorites.has(device.id) ? "" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"}`}
                                style={{
                                  color: favorites.has(device.id) ? "var(--th-status-warning)" : "var(--th-text-muted)",
                                }}
                              >
                                <Star className={`h-3.5 w-3.5 ${favorites.has(device.id) ? "fill-current" : ""}`} />
                              </button>
                            )}
                            {canOperate && (
                              <button
                                type="button"
                                data-action-trigger="true"
                                className="th-icon-btn th-icon-btn-ghost !min-h-7 !min-w-7 h-7 w-7"
                                data-active={openActionDeviceId === device.id}
                                aria-label={`More actions for ${deviceDisplayName(device)}`}
                                aria-haspopup="menu"
                                aria-expanded={openActionDeviceId === device.id}
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
                                <MoreHorizontal className="h-3.5 w-3.5" />
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
          </div>
          {/* end hidden md:block */}

          {/* Footer — hidden on mobile (Load More replaces pagination) */}
          <div className="hidden md:block">
            <TablePagination
              page={page}
              pageSize={limit}
              total={total}
              itemLabel="devices"
              loading={tableLoading}
              extra={selectedIds.size > 0 ? `${selectedIds.size} selected` : undefined}
              onPageChange={(next) => onPageChange?.(next)}
              onPageSizeChange={onLimitChange}
            />
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
            role="menu"
            aria-label={`Actions for ${deviceDisplayName(activeActionDevice)}`}
            style={{
              position: "fixed",
              top: menuAnchor.top,
              left: menuAnchor.left,
              width: ACTION_MENU_WIDTH,
              maxHeight: ACTION_MENU_MAX_HEIGHT,
            }}
            className="th-menu !z-[10000] overflow-y-auto"
          >
            {(() => {
              const device = activeActionDevice;
              const presence = presenceView(device);
              const close = () => {
                setOpenActionDeviceId(null);
                setMenuAnchor(null);
              };
              const queue = (action_type: "ping" | "refresh_inventory", label: string) => {
                close();
                queueDeviceAction(device.id, { action_type, created_by: currentUser ?? "unknown" })
                  .then(() => showBulkToast(`${label} queued for ${deviceDisplayName(device)}`, true))
                  .catch((err) => showBulkToast(err instanceof Error ? err.message : `${label} failed`, false));
              };
              return (
                <>
                  <div className="flex items-center gap-2.5 px-3 py-2.5">
                    <span className="th-status-dot" data-state={presence.state} aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                        {deviceDisplayName(device)}
                      </p>
                      <p className="truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                        {presence.label} · {device.client_name || TERMS.noClient}
                      </p>
                    </div>
                  </div>
                  <div className="th-menu-group">
                    <button
                      type="button"
                      role="menuitem"
                      className="th-menu-item"
                      onClick={() => {
                        close();
                        onDeviceSelect?.(device);
                      }}
                    >
                      <ExternalLink className="h-4 w-4" /> Open details
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="th-menu-item"
                      onClick={() => queue("ping", "Ping")}
                    >
                      <PlayCircle className="h-4 w-4" /> Ping device
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="th-menu-item"
                      onClick={() => queue("refresh_inventory", "Inventory refresh")}
                    >
                      <RotateCcw className="h-4 w-4" /> Refresh inventory
                    </button>
                    {isValidRustDeskId(device.rustdesk_id) && (
                      <button
                        type="button"
                        role="menuitem"
                        className="th-menu-item"
                        onClick={() => {
                          close();
                          navigator.clipboard
                            .writeText(String(device.rustdesk_id))
                            .then(() => showBulkToast(`Remote Support ID ${device.rustdesk_id} copied`, true))
                            .catch(() => showBulkToast("Could not copy to clipboard", false));
                        }}
                      >
                        <Copy className="h-4 w-4" /> Copy Remote Support ID
                      </button>
                    )}
                  </div>
                  <div className="th-menu-group">
                    {!device.is_archived ? (
                      <button
                        type="button"
                        role="menuitem"
                        className="th-menu-item"
                        onClick={() => {
                          close();
                          setPendingAction({ type: "archive", device });
                        }}
                      >
                        <Archive className="h-4 w-4" /> Archive device
                      </button>
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        className="th-menu-item"
                        onClick={() => {
                          close();
                          setPendingAction({ type: "restore", device });
                        }}
                      >
                        <RotateCcw className="h-4 w-4" /> Restore device
                      </button>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        role="menuitem"
                        className="th-menu-item th-menu-item-danger"
                        onClick={() => {
                          close();
                          setPendingAction({ type: device.deleted_at ? "purge" : "delete", device });
                        }}
                      >
                        <Trash2 className="h-4 w-4" /> {device.deleted_at ? "Delete permanently" : "Delete device"}
                      </button>
                    )}
                  </div>
                </>
              );
            })()}
          </div>,
          document.body,
        )}

      {/* ── Bulk toast ── */}
      {bulkToast && (
        <div
          className="th-toast fixed right-4 top-4 z-[99999] rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg"
          style={{
            background: bulkToast.ok
              ? "color-mix(in srgb, var(--th-status-online) 15%, transparent)"
              : "color-mix(in srgb, var(--th-status-critical) 15%, transparent)",
            border: `1px solid ${bulkToast.ok ? "color-mix(in srgb, var(--th-status-online) 30%, transparent)" : "color-mix(in srgb, var(--th-status-critical) 30%, transparent)"}`,
            color: bulkToast.ok ? "var(--th-status-online)" : "var(--th-status-critical)",
          }}
        >
          {bulkToast.message}
        </div>
      )}

      {pendingBulkAction && (
        <ConfirmationModal
          title={BULK_ACTIONS[pendingBulkAction].title(devicesPhrase(selectedIds.size))}
          confirmLabel={
            pendingBulkAction === "update_agent" && updatePlan.data?.update.length
              ? `Update ${devicesPhrase(updatePlan.data.update.length)}`
              : BULK_ACTIONS[pendingBulkAction].confirm
          }
          destructive={BULK_ACTIONS[pendingBulkAction].destructive}
          loading={bulkBusy}
          confirmDisabled={
            pendingBulkAction === "update_agent" && (updatePlan.loading || !updatePlan.data?.update.length)
          }
          onClose={() => setPendingBulkAction(null)}
          onConfirm={() => void runBulkAction(pendingBulkAction)}
        >
          {pendingBulkAction === "update_agent" ? (
            <BulkAgentUpdatePlan preview={updatePlan.data} loading={updatePlan.loading} error={updatePlan.error} />
          ) : (
            <p>{BULK_ACTIONS[pendingBulkAction].description}</p>
          )}
          {pendingBulkAction === "maintenance_enter" && (
            <fieldset className="mt-4">
              <legend className="mb-2 text-[13px] font-semibold" style={{ color: "var(--th-text-secondary)" }}>
                Duration
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {MAINTENANCE_DURATIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={bulkMaintDuration === opt.id}
                    onClick={() => setBulkMaintDuration(opt.id)}
                    className="th-filter-chip"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
        </ConfirmationModal>
      )}

      {pendingAction && (pendingAction.type === "delete" || pendingAction.type === "purge") ? (
        <DeleteDeviceDialog
          purge={pendingAction.type === "purge"}
          device={pendingAction.device}
          onCancel={() => setPendingAction(null)}
          onSubmit={async (reason, code) => {
            if (pendingAction.type === "purge") await onDevicePurge?.(pendingAction.device, code);
            else await onDeviceDelete?.(pendingAction.device, reason, code);
            setPendingAction(null);
          }}
        />
      ) : (
        pendingAction && (
          <ConfirmDeviceAction
            type={pendingAction.type === "archive" ? "archive" : "restore"}
            device={pendingAction.device}
            onCancel={() => setPendingAction(null)}
            onConfirm={confirmAction}
          />
        )
      )}
    </div>
  );
});

export default DevicesTable;

// ─── Sub-components ───────────────────────────────────────────────────────────

function ConfirmDeviceAction({
  type,
  device,
  onCancel,
  onConfirm,
}: {
  type: "archive" | "restore";
  device: Device;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const title = type === "archive" ? "Archive device" : "Restore device";
  const message =
    type === "archive"
      ? "Device will be removed from the active fleet and its agent refused. History is preserved."
      : device.deleted_at
        ? "Device will leave the trash and return to the active fleet; its agent is accepted again."
        : "Device will be returned to the active fleet; its agent is accepted again.";
  const actionLabel = type === "archive" ? "Archive" : "Restore";

  return (
    <ConfirmationModal
      title={title}
      confirmLabel={actionLabel}
      destructive={type === "archive"}
      onClose={onCancel}
      onConfirm={onConfirm}
    >
      <p className="font-medium" style={{ color: "var(--th-text-primary)" }}>
        {deviceDisplayName(device)}
      </p>
      <p className="mt-3">{message}</p>
    </ConfirmationModal>
  );
}

function deleteErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === "mfa_not_enabled") {
    return "Two-factor is off for your account. Turn it on in Settings → Security, then try again.";
  }
  if (err instanceof ApiError && err.code === "mfa_invalid") {
    return "Wrong or expired code. Enter the current code from your app.";
  }
  return err instanceof Error && err.message ? err.message : "Could not delete the device.";
}

/** Delete (to the trash) or delete permanently: a reason for the first, and
 * a current two-factor code for both, asked every time. */
function DeleteDeviceDialog({
  purge,
  device,
  onCancel,
  onSubmit,
}: {
  purge: boolean;
  device: Device;
  onCancel: () => void;
  onSubmit: (reason: string, code: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = code.length === 6 && (purge || reason.trim().length >= 3);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim(), code);
    } catch (err) {
      setError(deleteErrorMessage(err));
      setCode("");
      setBusy(false);
    }
  };

  return (
    <ConfirmationModal
      title={purge ? "Delete permanently" : "Delete device"}
      confirmLabel={purge ? "Delete permanently" : "Move to trash"}
      destructive
      loading={busy}
      confirmDisabled={!ready}
      onClose={onCancel}
      onConfirm={() => void submit()}
    >
      <p className="font-medium" style={{ color: "var(--th-text-primary)" }}>
        {deviceDisplayName(device)}
      </p>
      <p className="mt-3">
        {purge
          ? "The device and all its history are removed now. This cannot be undone. Its agent stays refused."
          : `The device leaves every list and its agent is refused, so it does not come back while the agent is still installed. It can be restored from Trash for ${TRASH_RETENTION_DAYS} days.`}
      </p>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!purge && (
          <label className="block">
            <span className="premium-kicker mb-1.5 block">Reason</span>
            <input
              className="th-input h-10 w-full rounded-lg border px-3 text-[14px]"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. PC sold, duplicate of KLEIVID-PC"
            />
          </label>
        )}
        <label className="block">
          <span className="premium-kicker mb-1.5 block">Two-factor code</span>
          <input
            className="th-input h-11 w-full rounded-lg border px-3 text-center font-mono text-[20px] tracking-[0.5em]"
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="Two-factor code"
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
          />
        </label>
        {error && (
          <p role="alert" className="th-drawer-callout text-[13px]" data-tone="critical">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </ConfirmationModal>
  );
}
