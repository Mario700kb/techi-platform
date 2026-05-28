import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, AlertTriangle, ExternalLink, Loader2, MoreHorizontal, PlayCircle, RotateCcw, Search, ServerOff, Trash2, Wrench } from "lucide-react";
import { Device, DeviceFilters } from "../api/devices";
import { PatchStatus } from "../api/inventory";
import { ActionStatus, isActiveStatus, queueDeviceAction } from "../api/actions";
import { isValidRustDeskId, launchRustDesk } from "../services/rustdeskLaunch";
import { DeviceHealthSummary } from "../types/telemetry";
import { Badge, Button } from "./ui";
import ConfirmationModal from "./ConfirmationModal";
import { parseUTC, timeAgo } from "../utils/time";

export interface ActiveActionEntry {
  action_type: string;
  status: ActionStatus;
}

interface DevicesTableProps {
  devices: Device[];
  loading: boolean;
  error: string | null;
  filters: DeviceFilters;
  healthFilter: HealthFilter;
  searchQuery: string;
  onSearch: (value: string) => void;
  onFilterChange: (key: keyof DeviceFilters, value: string | boolean | undefined) => void;
  onHealthFilterChange: (value: HealthFilter) => void;
  onRefresh: () => void;
  onDeviceSelect?: (device: Device) => void;
  onDeviceDelete?: (device: Device) => void;
  onDeviceArchive?: (device: Device) => void;
  onDeviceRestore?: (device: Device) => void;
  healthMap?: Record<number, DeviceHealthSummary>;
  patchMap?: Record<number, PatchStatus>;
  activeActionMap?: Record<number, ActiveActionEntry>;
  canOperate?: boolean;
  canDelete?: boolean;
  currentUser?: string;
}

type PendingAction = "archive" | "restore" | "delete";
export type HealthFilter = "all" | DeviceHealthSummary["health_state"];

const compactBadgeClass = "!min-h-[1.35rem] !px-1.5 !py-0.5 !text-[10px] !leading-3";
const subtleBadgeClass = `border-white/10 bg-white/[0.025] text-slate-400 ${compactBadgeClass}`;
const FILTER_INPUT_CLS = "th-input rounded-lg border px-3 py-1.5 text-xs font-medium focus:border-techi-orange/50 focus:outline-none";
const ACTION_MENU_WIDTH = 192;
const ACTION_MENU_MAX_HEIGHT = 220;
const ACTION_MENU_GAP = 6;
const ACTION_MENU_MARGIN = 8;

const getStatusCell = (device: Device) => {
  const state = device.freshness_state ?? device.status;
  const isOnline = state === "online";
  const isStale = state === "stale";
  return (
    <span
      className="inline-flex items-center"
      title={device.freshness_state ? `Freshness: ${device.freshness_state}` : `Status: ${device.status}`}
    >
      <span
        className={`inline-block h-2 w-2 flex-none rounded-full ${
          isOnline
            ? "bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]"
            : isStale
            ? "bg-amber-300 shadow-[0_0_4px_rgba(251,191,36,0.5)]"
            : "bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.55)]"
        }`}
      />
    </span>
  );
};

const getRustDeskSyncBadge = (device: Device) => {
  if (device.rustdesk_conflict_detected || device.rustdesk_sync_state === "failed") {
    return <Badge variant="secondary" className={compactBadgeClass}>Sync issue</Badge>;
  }
  if (device.rustdesk_sync_state === "degraded") {
    return <Badge variant="ghost" className={`border-amber-400/30 bg-amber-400/10 text-amber-200 ${compactBadgeClass}`}>Degraded</Badge>;
  }
  if (device.rustdesk_manual_override) {
    return <Badge variant="neutral" className={compactBadgeClass}>Manual</Badge>;
  }
  if (device.rustdesk_sync_state === "synced") {
    return <Badge variant="ghost" className={compactBadgeClass}>Verified</Badge>;
  }
  return <Badge variant="neutral" className={compactBadgeClass}>Unknown</Badge>;
};

const getRustDeskRuntime = (device: Device) => {
  if (device.rustdesk_install_status === "not_installed") return "Not installed";
  if (device.rustdesk_status === "running") return "Running";
  if (device.rustdesk_status === "stopped" || device.rustdesk_status === "not_running") return "Stopped";
  return device.rustdesk_status || "Unknown";
};

const getAssignmentBadge = (device: Device) => {
  const source = device.resolved_assignment_source || device.assignment_source || "unassigned";
  if (source === "enrollment_token") {
    return (
      <Badge variant="ghost" className={subtleBadgeClass} title="Enrollment token assignment">
        token
      </Badge>
    );
  }
  if (source === "manual" || source === "legacy_manual") {
    return (
      <Badge variant="ghost" className={subtleBadgeClass} title="Manual assignment">
        manual
      </Badge>
    );
  }
  if (source === "trusted_domain") {
    return (
      <Badge variant="ghost" className={subtleBadgeClass} title="Domain assignment">
        domain
      </Badge>
    );
  }
  if (source === "auto_os" || source === "system_auto") {
    return (
      <Badge variant="ghost" className={subtleBadgeClass} title="Auto assigned from domain">
        auto
      </Badge>
    );
  }
  return (
    <Badge variant="ghost" className={subtleBadgeClass} title="Unassigned">
      unassigned
    </Badge>
  );
};

const formatLastSeen = (lastSeen?: string) => {
  if (!lastSeen) return "Never";
  const diffMs = Date.now() - parseUTC(lastSeen).getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  if (diffHours < 1) return "Just now";
  if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
};

const isSuggestedArchive = (device: Device) => {
  if (device.is_archived || device.freshness_state !== "offline" || !device.last_seen) return false;
  const diffDays = (Date.now() - parseUTC(device.last_seen).getTime()) / (1000 * 60 * 60 * 24);
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
      maintenance
    </Badge>
  );
};

const getDuplicateBadge = (device: Device) => {
  if (!device.duplicate_candidate) return null;
  const scoreLabel = device.duplicate_score != null
    ? ` ${Math.round(device.duplicate_score * 100)}%`
    : "";
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
      duplicate
    </Badge>
  );
};

const getUserSourceBadge = (device: Device) => {
  if (!device.user_source || device.user_source === "no_interactive_user" || device.user_source === "fallback") return null;
  const label = device.user_source === "rdp_session" ? "rdp" : "con";
  const cls = device.user_source === "rdp_session"
    ? `border-purple-400/25 bg-purple-400/[0.08] text-purple-300 ${compactBadgeClass}`
    : `border-sky-400/25 bg-sky-400/[0.08] text-sky-300 ${compactBadgeClass}`;
  const stateLabel = device.user_session_state && device.user_session_state !== "unknown"
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
  if (state === "up_to_date") {
    return <Badge variant="ghost" className={subtleBadgeClass}>patched</Badge>;
  }
  if (state === "reboot_required") {
    return <Badge variant="ghost" className={`border-red-400/20 bg-red-400/[0.06] text-red-300 ${compactBadgeClass}`}>reboot required</Badge>;
  }
  if (state === "updates_available") {
    const count = patch?.pending_updates ?? 0;
    return <Badge variant="ghost" className={`border-amber-400/20 bg-amber-400/[0.06] text-amber-300 ${compactBadgeClass}`}>{count > 0 ? `${count} updates` : "updates"}</Badge>;
  }
  return <Badge variant="ghost" className={subtleBadgeClass}>patch unknown</Badge>;
};

const getLifecycleSignals = (device: Device) => (
  <>
    {device.is_archived && (
      <Badge variant="neutral" className={compactBadgeClass} title={device.archived_at ? `Archived ${parseUTC(device.archived_at).toLocaleString()}` : "Archived device"}>
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
      <Badge variant="ghost" className={`border-amber-300/25 bg-amber-300/10 text-amber-100 ${compactBadgeClass}`} title="Offline for more than 30 days">
        archive suggested
      </Badge>
    )}
    {getMaintenanceBadge(device)}
    {getDuplicateBadge(device)}
  </>
);

const getCompactHealthBadge = (health?: DeviceHealthSummary) => {
  const score = health?.health_score;
  return (
    <span className="min-w-[18px] text-right text-[10px] font-semibold leading-4 text-slate-200 tabular-nums">
      {score != null ? score : "—"}
    </span>
  );
};

const DevicesTable = memo(function DevicesTable({
  devices,
  loading,
  error,
  filters,
  healthFilter,
  searchQuery,
  onSearch,
  onFilterChange,
  onHealthFilterChange,
  onRefresh,
  onDeviceSelect,
  onDeviceDelete,
  onDeviceArchive,
  onDeviceRestore,
  healthMap = {},
  patchMap = {},
  activeActionMap = {},
  canOperate = false,
  canDelete = false,
  currentUser,
}: DevicesTableProps) {
  const [openActionDeviceId, setOpenActionDeviceId] = useState<number | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const [pendingAction, setPendingAction] = useState<{ type: PendingAction; device: Device } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollPositionRef = useRef({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollLeft = scrollPositionRef.current.left;
    node.scrollTop = scrollPositionRef.current.top;
  }, [devices]);

  // Close portal menu when the user clicks outside both the trigger and the menu.
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

  const activeActionDevice = openActionDeviceId !== null
    ? devices.find((d) => d.id === openActionDeviceId) ?? null
    : null;

  const getMenuAnchor = (trigger: HTMLElement) => {
    const rect = trigger.getBoundingClientRect();
    const availableBelow = window.innerHeight - rect.bottom - ACTION_MENU_MARGIN;
    const opensUp = availableBelow < ACTION_MENU_MAX_HEIGHT && rect.top > availableBelow;
    const top = opensUp
      ? Math.max(ACTION_MENU_MARGIN, rect.top - ACTION_MENU_MAX_HEIGHT - ACTION_MENU_GAP)
      : Math.max(
          ACTION_MENU_MARGIN,
          Math.min(rect.bottom + ACTION_MENU_GAP, window.innerHeight - ACTION_MENU_MAX_HEIGHT - ACTION_MENU_MARGIN)
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
      {/* Shiriti i filtrave */}
      <div className="premium-card-soft p-2.5">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Devices catalog</h2>
            <p className="mt-0.5 text-xs text-slate-400">Full device roster for all managed clients.</p>
          </div>
          <Button size="sm" onClick={onRefresh}>Refresh list</Button>
        </div>

        <div className="mt-2.5 grid gap-1.5 lg:grid-cols-[1.6fr_1fr] xl:grid-cols-[2fr_1fr_1fr_1fr_1fr]">
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
          >
            <option value="all">All statuses</option>
            <option value="online">Online</option>
            <option value="stale">Stale</option>
            <option value="offline">Offline</option>
          </select>
          <select
            value={healthFilter}
            onChange={(e) => onHealthFilterChange(e.target.value as HealthFilter)}
            className={FILTER_INPUT_CLS}
          >
            <option value="all">All health</option>
            <option value="healthy">Healthy</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <select
            value={filters.lifecycle_state || "active"}
            onChange={(e) => onFilterChange("lifecycle_state", e.target.value)}
            className={FILTER_INPUT_CLS}
          >
            <option value="active">Active devices</option>
            <option value="archived">Archived devices</option>
            <option value="all">All devices</option>
          </select>
          <select
            value={filters.duplicate_candidates ? "duplicate" : filters.maintenance_state || "all"}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "duplicate") {
                onFilterChange("maintenance_state", undefined);
                onFilterChange("duplicate_candidates", true);
                return;
              }
              onFilterChange("duplicate_candidates", undefined);
              onFilterChange("maintenance_state", value === "all" ? undefined : value);
            }}
            className={FILTER_INPUT_CLS}
          >
            <option value="all">All signals</option>
            <option value="maintenance">In maintenance</option>
            <option value="normal">Normal only</option>
            <option value="duplicate">Duplicates only</option>
          </select>
        </div>
      </div>

      {/* Gjendjet */}
      {loading ? (
        <div className="premium-card-soft py-12 text-center">
          <p className="text-[15px] font-semibold text-slate-200">Loading devices...</p>
          <p className="mt-1 text-[13px] text-slate-500">Fetching inventory from backend.</p>
        </div>
      ) : error ? (
        <div className="premium-card-soft py-12 text-center">
          <p className="text-[15px] font-semibold text-white">Unable to load devices</p>
          <p className="mt-1 text-[13px] text-red-300">{error}</p>
          <Button onClick={onRefresh} size="sm" className="mt-4">Try again</Button>
        </div>
      ) : devices.length === 0 ? (
        <div className="premium-card-soft flex flex-col items-center gap-3 py-14 text-center">
          <ServerOff className="h-8 w-8 text-slate-600" />
          <div>
            <p className="text-[15px] font-semibold text-slate-200">No devices found</p>
            <p className="mt-1 text-[13px] text-slate-500">Adjust filters or search terms to reveal devices.</p>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-white/[0.1] bg-slate-950/80 th-table-row">
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
            <table className="min-w-[1120px] border-separate border-spacing-0 text-left">
              <thead className="sticky top-0 z-20">
                <tr className="th-table-head border-b border-white/[0.06]">
                  <th className="w-[46px] px-1.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">Status</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">Hostname</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">Assignment</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">Remote Support ID</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">Sync</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">User</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">Public IP</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">Local IP</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">Domain</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">OS</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">Last seen</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {devices.map((device) => (
                  <tr
                    key={device.id}
                    className="group cursor-pointer"
                    onClick={() => onDeviceSelect?.(device)}
                  >
                    <td className="w-[46px] px-1.5 py-1 align-middle">
                      <div className="flex items-center gap-1">
                        {getStatusCell(device)}
                        {getCompactHealthBadge(healthMap[device.id])}
                        {activeActionMap[device.id] && (
                          <ActionIndicator entry={activeActionMap[device.id]} />
                        )}
                      </div>
                    </td>
                    <td className="px-2.5 py-1 align-middle">
                      <div className="truncate text-[11px] font-semibold leading-4 text-white">{device.hostname || "Unknown"}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-0.5">
                        <span className="text-[9px] font-medium leading-3 text-slate-500">{device.device_type}</span>
                        {getPatchBadge(patchMap[device.id])}
                        {getLifecycleSignals(device)}
                      </div>
                    </td>
                    <td className="px-2.5 py-1 align-middle">
                      <div className="truncate text-[11px] font-semibold leading-4 text-slate-100">{device.client_name || "No client"}</div>
                      <div className="flex flex-wrap items-center gap-0.5">
                        <span className="text-[9px] font-medium leading-3 text-slate-500">{device.group_name || "No group"}</span>
                        {getAssignmentBadge(device)}
                      </div>
                    </td>
                    <td className="px-2.5 py-1 align-middle">
                      <div className="text-[11px] font-semibold leading-4 text-slate-100">{device.rustdesk_id}</div>
                      <div className="text-[9px] font-medium leading-3 text-slate-500">{getRustDeskRuntime(device)}</div>
                    </td>
                    <td className="px-2.5 py-1 align-middle">
                      {getRustDeskSyncBadge(device)}
                      {device.rustdesk_version && (
                        <div className="text-[9px] font-medium leading-3 text-slate-500">v{device.rustdesk_version}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-1 align-middle">
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] font-medium text-slate-200">{device.current_user || "—"}</span>
                        {getUserSourceBadge(device)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-1 align-middle text-[11px] font-medium text-slate-300">{device.public_ip || "—"}</td>
                    <td className="whitespace-nowrap px-2.5 py-1 align-middle text-[11px] font-medium text-slate-300">{device.local_ip || "—"}</td>
                    <td className="whitespace-nowrap px-2.5 py-1 align-middle text-[11px] font-medium text-slate-300">{device.domain || "—"}</td>
                    <td className="px-2.5 py-1 align-middle text-[11px] font-medium text-slate-300">{device.os_name || "—"}</td>
                    <td className="whitespace-nowrap px-2.5 py-1 align-middle text-[11px] font-semibold text-slate-300">{formatLastSeen(device.last_seen)}</td>
                    <td className="px-2.5 py-1 align-middle" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={!isValidRustDeskId(device.rustdesk_id) || device.rustdesk_conflict_detected}
                          className="th-btn th-btn-primary inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:border-white/[0.06] disabled:bg-transparent disabled:text-slate-600"
                          onClick={() => launchRustDesk(device.rustdesk_id)}
                          title={
                            device.rustdesk_conflict_detected
                              ? "TECHI Remote Support ID conflict detected"
                              : isValidRustDeskId(device.rustdesk_id)
                              ? "Open TECHI Remote Support"
                              : "TECHI Remote Support ID not resolved yet"
                          }
                        >
                          <ExternalLink className="h-2.5 w-2.5" />
                          Connect
                        </button>
                        {canOperate && (
                          <button
                            type="button"
                            data-action-trigger="true"
                            className="th-icon-btn !min-h-8 !min-w-8"
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
                ))}
              </tbody>
            </table>
          </div>

          <div className="th-table-head border-t border-white/[0.06] px-4 py-2.5 text-xs font-medium text-slate-500 sm:flex sm:items-center sm:justify-between">
            <span>{devices.length} device{devices.length !== 1 ? "s" : ""} shown</span>
            <span className="mt-1 sm:mt-0">Fleet operating normally</span>
          </div>
        </div>
      )}

      {/* Portal action menu — rendered in document.body to escape table scroll clipping */}
      {activeActionDevice && menuAnchor && createPortal(
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
              void queueDeviceAction(activeActionDevice.id, { action_type: "ping", created_by: currentUser ?? "unknown" });
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
              void queueDeviceAction(activeActionDevice.id, { action_type: "refresh_inventory", created_by: currentUser ?? "unknown" });
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

function ActionIndicator({ entry }: { entry: ActiveActionEntry }) {
  const isRunning = entry.status === "running";
  const isQueued = entry.status === "queued" || entry.status === "sent" || entry.status === "acknowledged";
  const title = `${entry.action_type.replace(/_/g, " ")} — ${entry.status}`;
  if (isRunning) {
    return (
      <span title={title}>
        <Loader2 className="h-2.5 w-2.5 flex-none animate-spin text-sky-400" />
      </span>
    );
  }
  if (isQueued) {
    return (
      <span
        className="h-2 w-2 flex-none rounded-full bg-amber-400/80"
        title={title}
      />
    );
  }
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
  const title = type === "archive" ? "Archive device" : type === "restore" ? "Restore device" : "Remove permanently";
  const message =
    type === "archive"
      ? "Device do hiqet nga fleet aktiv por historia ruhet."
      : type === "restore"
      ? "Device do rikthehet te fleet aktiv."
      : "Ky veprim nuk rikthehet.";
  const actionLabel = type === "archive" ? "Archive" : type === "restore" ? "Restore" : "Remove permanently";

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
