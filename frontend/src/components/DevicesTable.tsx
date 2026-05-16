import { memo, useLayoutEffect, useRef, useState } from "react";
import { Archive, AlertTriangle, ExternalLink, MoreHorizontal, PlayCircle, RotateCcw, Search, ServerOff, Trash2, Wrench } from "lucide-react";
import { Device, DeviceFilters } from "../api/devices";
import { PatchStatus } from "../api/inventory";
import { queueDeviceAction } from "../api/actions";
import { isValidRustDeskId, launchRustDesk } from "../services/rustdeskLaunch";
import { DeviceHealthSummary } from "../types/telemetry";
import { Badge, Button } from "./ui";

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
  canOperate?: boolean;
  canDelete?: boolean;
}

type PendingAction = "archive" | "restore" | "delete";
export type HealthFilter = "all" | DeviceHealthSummary["health_state"];

const compactBadgeClass = "!px-1 !py-0 !text-[8px] !leading-3";
const subtleBadgeClass = `border-white/10 bg-white/[0.025] text-slate-400 ${compactBadgeClass}`;

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
  const source = device.assignment_source || "system_auto_unassigned";
  if (source === "enrollment_token") {
    return (
      <Badge variant="ghost" className={subtleBadgeClass} title="Enrollment token assignment">
        token
      </Badge>
    );
  }
  if (source === "manual") {
    return (
      <Badge variant="ghost" className={subtleBadgeClass} title="Manual assignment">
        manual
      </Badge>
    );
  }
  if (source === "system_auto") {
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
  const date = new Date(lastSeen);
  const diffMs = Date.now() - date.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  if (diffHours < 1) return "Just now";
  if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
};

const isSuggestedArchive = (device: Device) => {
  if (device.is_archived || device.freshness_state !== "offline" || !device.last_seen) return false;
  const diffDays = (Date.now() - new Date(device.last_seen).getTime()) / (1000 * 60 * 60 * 24);
  return diffDays > 30;
};

const getMaintenanceBadge = (device: Device) => {
  if (!device.is_in_maintenance) return null;
  const title = device.maintenance_ends_at
    ? `In maintenance until ${new Date(device.maintenance_ends_at).toLocaleString()}`
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
      <Badge variant="neutral" className={compactBadgeClass} title={device.archived_at ? `Archived ${new Date(device.archived_at).toLocaleString()}` : "Archived device"}>
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
  canOperate = false,
  canDelete = false,
}: DevicesTableProps) {
  const [openActionDeviceId, setOpenActionDeviceId] = useState<number | null>(null);
  const [pendingAction, setPendingAction] = useState<{ type: PendingAction; device: Device } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollPositionRef = useRef({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollLeft = scrollPositionRef.current.left;
    node.scrollTop = scrollPositionRef.current.top;
  }, [devices]);

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
              className="w-full rounded-lg border border-white/[0.1] bg-slate-900/70 py-1.5 pl-9 pr-3 text-xs font-medium text-white placeholder-slate-500 focus:border-techi-orange/50 focus:outline-none"
            />
          </div>
          <select
            value={filters.freshness_state || "all"}
            onChange={(e) => onFilterChange("freshness_state", e.target.value)}
            className="rounded-lg border border-white/[0.1] bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-white focus:border-techi-orange/50 focus:outline-none"
          >
            <option value="all">All statuses</option>
            <option value="online">Online</option>
            <option value="stale">Stale</option>
            <option value="offline">Offline</option>
          </select>
          <select
            value={healthFilter}
            onChange={(e) => onHealthFilterChange(e.target.value as HealthFilter)}
            className="rounded-lg border border-white/[0.1] bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-white focus:border-techi-orange/50 focus:outline-none"
          >
            <option value="all">All health</option>
            <option value="healthy">Healthy</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <select
            value={filters.lifecycle_state || "active"}
            onChange={(e) => onFilterChange("lifecycle_state", e.target.value)}
            className="rounded-lg border border-white/[0.1] bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-white focus:border-techi-orange/50 focus:outline-none"
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
            className="rounded-lg border border-white/[0.1] bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-white focus:border-techi-orange/50 focus:outline-none"
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
        <div className="overflow-hidden rounded-lg border border-white/[0.1] bg-slate-950/80">
          <div
            ref={scrollRef}
            className="overflow-x-auto"
            onScroll={(event) => {
              scrollPositionRef.current = {
                left: event.currentTarget.scrollLeft,
                top: event.currentTarget.scrollTop,
              };
            }}
          >
            <table className="min-w-full border-separate border-spacing-0 text-left text-[11px]">
              <thead className="sticky top-0 z-20">
                <tr className="border-b border-white/[0.06] bg-slate-950/90">
                  <th className="w-[46px] px-1.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">Status</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">Hostname</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">Assignment</th>
                  <th className="px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-slate-300">RustDesk ID</th>
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
                    <td className="whitespace-nowrap px-2.5 py-1 align-middle text-[11px] font-medium text-slate-200">{device.current_user || "—"}</td>
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
                          className="inline-flex items-center gap-1 rounded-md border border-techi-orange/25 bg-techi-orange/10 px-1.5 py-0.5 text-[9px] font-semibold leading-4 text-orange-200 transition hover:bg-techi-orange/20 hover:text-white disabled:cursor-not-allowed disabled:border-white/[0.06] disabled:bg-transparent disabled:text-slate-600"
                          onClick={() => launchRustDesk(device.rustdesk_id)}
                          title={
                            device.rustdesk_conflict_detected
                              ? "RustDesk ID conflict detected"
                              : isValidRustDeskId(device.rustdesk_id)
                              ? "Open native RustDesk"
                              : "RustDesk ID not resolved yet"
                          }
                        >
                          <ExternalLink className="h-2.5 w-2.5" />
                          Connect
                        </button>
	                        {canOperate && (
	                          <div className="relative inline-block">
	                            <button
	                              type="button"
	                              className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-slate-300 transition hover:bg-white/[0.08] hover:text-white"
	                              onClick={() => setOpenActionDeviceId((value) => (value === device.id ? null : device.id))}
	                              title="More actions"
	                            >
	                              <MoreHorizontal className="h-3 w-3" />
	                            </button>
	                            {openActionDeviceId === device.id && (
	                              <div className="absolute right-0 top-8 z-30 w-48 rounded-lg border border-white/10 bg-slate-950 p-1 shadow-2xl">
	                                <button
	                                  type="button"
	                                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-semibold text-sky-100 transition hover:bg-sky-500/10"
	                                  onClick={() => {
	                                    setOpenActionDeviceId(null);
	                                    void queueDeviceAction(device.id, { action_type: "ping", created_by: "admin" });
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
	                                    void queueDeviceAction(device.id, { action_type: "refresh_inventory", created_by: "admin" });
	                                  }}
	                                >
	                                  <RotateCcw className="h-3.5 w-3.5" />
	                                  Refresh inventory
	                                </button>
	                                {!device.is_archived ? (
	                                  <button
	                                    type="button"
	                                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-semibold text-amber-100 transition hover:bg-amber-500/10"
	                                    onClick={() => {
	                                      setOpenActionDeviceId(null);
	                                      setPendingAction({ type: "archive", device });
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
	                                      setPendingAction({ type: "restore", device });
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
	                                      setPendingAction({ type: "delete", device });
	                                    }}
	                                  >
	                                    <Trash2 className="h-3.5 w-3.5" />
	                                    Remove permanently
	                                  </button>
	                                )}
	                              </div>
	                            )}
	                          </div>
	                        )}
	                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="border-t border-white/[0.06] bg-slate-950/60 px-4 py-2.5 text-xs font-medium text-slate-500 sm:flex sm:items-center sm:justify-between">
            <span>{devices.length} device{devices.length !== 1 ? "s" : ""} shown</span>
            <span className="mt-1 sm:mt-0">Fleet operating normally</span>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className={`w-full max-w-md rounded-xl border p-5 shadow-2xl ${isDelete ? "border-red-400/35 bg-red-950/40" : "border-white/10 bg-slate-950"}`}>
        <p className={`text-sm font-semibold ${isDelete ? "text-red-100" : "text-white"}`}>{title}</p>
        <p className="mt-2 text-sm font-medium text-slate-300">{device.hostname || device.rustdesk_id}</p>
        <p className={`mt-3 text-sm ${isDelete ? "text-red-100" : "text-slate-300"}`}>{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border border-white/10 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-white/[0.06]">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-md px-3 py-2 text-xs font-semibold text-white ${isDelete ? "bg-red-600 hover:bg-red-500" : type === "restore" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-amber-600 hover:bg-amber-500"}`}
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
