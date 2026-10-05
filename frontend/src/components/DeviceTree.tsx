import { memo, useEffect, useMemo, useState } from "react";
import { ChevronRight, RefreshCcw, Server, Monitor, Box, LayoutGrid } from "lucide-react";
import clsx from "clsx";
import { Client, DeviceGroup } from "../api/clients";
import { Device } from "../api/devices";
import PlatformIcon from "./PlatformIcon";

// Platform label for a sub-folder key (Platform Expansion). Extending to a new
// platform is one entry here — the tree needs no other change.
const PLATFORM_LABELS: Record<string, string> = {
  windows: "Windows",
  linux: "Linux",
  mikrotik: "MikroTik",
  synology: "Synology",
  qnap: "QNAP",
  vmware: "VMware",
  hyperv: "Hyper-V",
  proxmox: "Proxmox",
};

const SHOW_EMPTY_STORAGE_KEY = "techi.deviceTree.showEmptyGroups";
const CLIENT_FOLDERS = [
  { id: "servers", label: "Servers", smartFolder: "windows_server" },
  { id: "clientpc", label: "Client PC", smartFolder: "windows_workstation" },
  // Platform-class categories (Phase 7). Shown only when they have devices
  // (folderCount > 0) → with all platform flags off they never appear, so the
  // tree is identical to today. Placement is automatic (backend classifies).
  { id: "network", label: "Network", smartFolder: "" },
  { id: "storage", label: "Storage", smartFolder: "" },
  { id: "hypervisors", label: "Hypervisors", smartFolder: "" },
  // Devices in a custom (non-standard) group. Shown only when non-empty, like
  // the platform-class folders — with today's fleet (0 custom groups) it never
  // appears. Category comes from the Unified Classification Engine.
  { id: "other", label: "Other", smartFolder: "" },
] as const;

const readShowEmptyGroups = () => {
  try {
    return window.localStorage.getItem(SHOW_EMPTY_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
};

interface TreeCounts {
  total: number;
  unassigned: number;
  byClient: Map<number, number>;
  byClientCategory: Map<number, Map<string, number>>;
  byClientCategoryPlatform?: Map<number, Map<string, Map<string, number>>>;
}

interface DeviceTreeProps {
  selectedKey: string;
  onSelect: (key: string) => void;
  devices: Device[];
  clients: Client[];
  groups: DeviceGroup[];
  treeCounts: TreeCounts;
  showPlatformFolders?: boolean;
  onRefreshCounts: () => void;
}

const DeviceTree = memo(function DeviceTree({ selectedKey, onSelect, devices, clients, groups, treeCounts, showPlatformFolders = false, onRefreshCounts }: DeviceTreeProps) {
  void groups;
  const activeClientFolder = useMemo(() => {
    const match = selectedKey.match(/^client-(\d+)-(servers|clientpc|network|storage|hypervisors|other)$/);
    if (!match) return null;
    return { clientId: Number(match[1]), folderId: match[2] };
  }, [selectedKey]);
  const [expandedClients, setExpandedClients] = useState<Set<number>>(new Set());
  const [showEmptyGroups, setShowEmptyGroups] = useState(readShowEmptyGroups);

  // Use stable treeCounts for all top-level counts — not recalculated on heartbeat
  const allCount = treeCounts.total;
  const unassignedCount = treeCounts.unassigned;
  const clientCount = (clientId: number) => treeCounts.byClient.get(clientId) ?? 0;

  const treeIndex = useMemo(() => {
    const maintenanceClients = new Set<number>();
    const maintenanceFolders = new Set<string>();
    for (const device of devices) {
      const clientId = device.resolved_client_id ?? device.client_id ?? null;
      if (clientId === null) continue;
      const category = device.resolved_device_category ?? "unassigned";
      const key = `${clientId}:${category}`;
      if (device.is_in_maintenance) {
        maintenanceClients.add(clientId);
        maintenanceFolders.add(key);
      }
    }
    return { maintenanceClients, maintenanceFolders };
  }, [devices]);
  const folderCount = (clientId: number, folderId: string) =>
    treeCounts.byClientCategory.get(clientId)?.get(folderId) ?? 0;
  // Platform sub-folders: [platform, count] under a client's category, sorted
  // with windows first. Empty unless FEATURE_LINUX is on (backend returns {}).
  const platformChildren = (clientId: number, folderId: string): Array<[string, number]> => {
    const plats = treeCounts.byClientCategoryPlatform?.get(clientId)?.get(folderId);
    if (!plats) return [];
    return [...plats.entries()].sort(([a], [b]) =>
      a === "windows" ? -1 : b === "windows" ? 1 : a.localeCompare(b),
    );
  };
  const clientHasMaintenance = (clientId: number) => treeIndex.maintenanceClients.has(clientId);
  const folderHasMaintenance = (clientId: number, folderId: string) => treeIndex.maintenanceFolders.has(`${clientId}:${folderId}`);
  const sortedClients = useMemo(
    () => [...clients].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [clients]
  );
  const visibleClients = useMemo(() => {
    if (showEmptyGroups) return sortedClients;
    return sortedClients.filter((client) => {
      const hasDevices = (treeCounts.byClient.get(client.id) ?? 0) > 0;
      const isActive = selectedKey === `client-${client.id}` || activeClientFolder?.clientId === client.id;
      return hasDevices || isActive;
    });
  }, [activeClientFolder, treeCounts, selectedKey, showEmptyGroups, sortedClients]);

  useEffect(() => {
    window.localStorage.setItem(SHOW_EMPTY_STORAGE_KEY, String(showEmptyGroups));
  }, [showEmptyGroups]);

  const toggleClient = (clientId: number) => {
    setExpandedClients((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
    onSelect(`client-${clientId}`);
  };

  return (
    <div className="premium-card overflow-hidden">
      <div className="border-b border-white/[0.06] px-4 py-3">
        <p className="premium-kicker">Device Explorer</p>
        <div className="mt-1 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Fleet tree</h3>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onRefreshCounts}
              className="rounded p-0.5 text-slate-500 hover:text-slate-300 transition-colors"
              title="Refresh tree counts"
            >
              <RefreshCcw className="h-3 w-3" />
            </button>
            <span className="rounded-full border border-emerald-400/25 bg-emerald-400/[0.07] px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
              Live
            </span>
          </div>
        </div>
      </div>

      <div className="fleet-tree p-2.5">
        <ul className="space-y-1">
          <li>
            <TreeButton
              active={selectedKey === "all"}
              icon={LayoutGrid}
              label="All Devices"
              count={allCount}
              onClick={() => onSelect("all")}
            />
          </li>
          <li>
            <TreeButton
              active={selectedKey === "unassigned"}
              icon={Box}
              label="No Client"
              count={unassignedCount}
              onClick={() => onSelect("unassigned")}
            />
          </li>
          {visibleClients.map((client) => {
            const childFolders = CLIENT_FOLDERS.filter((folder) => {
              if (showEmptyGroups) return true;
              return folderCount(client.id, folder.id) > 0 || selectedKey === `client-${client.id}-${folder.id}`;
            });
            const expanded = expandedClients.has(client.id);
            return (
              <li key={client.id}>
                <TreeButton
                  active={selectedKey === `client-${client.id}` || activeClientFolder?.clientId === client.id}
                  expanded={expanded}
                  hasChildren={childFolders.length > 0}
                  icon={Server}
                  label={client.name}
                  count={clientCount(client.id)}
                  hasMaintenance={clientHasMaintenance(client.id)}
                  onClick={() => toggleClient(client.id)}
                />
                {expanded && childFolders.length > 0 && (
                  <ul className="fleet-tree-child mt-1 space-y-1 border-l pl-4" style={{ borderColor: "var(--th-border-subtle)" }}>
                    {childFolders.map((folder) => {
                      const platforms = showPlatformFolders ? platformChildren(client.id, folder.id) : [];
                      return (
                        <li key={folder.id}>
                          <TreeButton
                            active={selectedKey === `client-${client.id}-${folder.id}`}
                            child
                            icon={Monitor}
                            label={folder.label}
                            count={folderCount(client.id, folder.id)}
                            hasMaintenance={folderHasMaintenance(client.id, folder.id)}
                            onClick={() => onSelect(`client-${client.id}-${folder.id}`)}
                          />
                          {platforms.length > 0 && (
                            <ul className="mt-1 space-y-1 border-l pl-4" style={{ borderColor: "var(--th-border-subtle)" }}>
                              {platforms.map(([platform, count]) => {
                                const key = `client-${client.id}-${folder.id}-${platform}`;
                                return (
                                  <li key={platform}>
                                    <TreeButton
                                      active={selectedKey === key}
                                      child
                                      platformIcon={platform}
                                      label={PLATFORM_LABELS[platform] ?? platform}
                                      count={count}
                                      onClick={() => onSelect(key)}
                                    />
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="border-t border-white/[0.05] px-4 py-2.5">
        <label className="flex cursor-pointer items-center justify-between gap-3 text-[12px] font-semibold text-slate-400">
          <span>Show empty groups</span>
          <input
            type="checkbox"
            checked={showEmptyGroups}
            onChange={(event) => setShowEmptyGroups(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-white/15 bg-slate-950 accent-orange-500"
          />
        </label>
        <p className="mt-2 text-[11px] text-slate-600">Browse by client · device type</p>
      </div>
    </div>
  );
});

export default DeviceTree;

interface TreeButtonProps {
  active: boolean;
  child?: boolean;
  icon?: typeof LayoutGrid;
  platformIcon?: string;
  label: string;
  count: number;
  expanded?: boolean;
  hasChildren?: boolean;
  hasMaintenance?: boolean;
  onClick: () => void;
}

function TreeButton({ active, child = false, icon: Icon, platformIcon, label, count, expanded = false, hasChildren = false, hasMaintenance = false, onClick }: TreeButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={clsx(
        "flex w-full items-center rounded-md text-left transition-all duration-120",
        child ? "px-2.5 py-1.5" : "px-2.5 py-1.5",
        active
          ? "bg-[var(--th-sidebar-nav-active-bg)] text-[var(--th-accent-bright)] shadow-[var(--th-sidebar-nav-active-shadow)]"
          : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {hasChildren && (
          <ChevronRight className={clsx("h-3.5 w-3.5 shrink-0 transition-transform", expanded ? "rotate-90 text-slate-300" : "text-slate-600")} />
        )}
        {platformIcon ? (
          <PlatformIcon platform={platformIcon} size={14} className="shrink-0" />
        ) : Icon ? (
          <Icon className={clsx(child ? "h-3.5 w-3.5" : "h-4 w-4", "shrink-0", active ? "text-techi-orange" : "text-slate-600")} />
        ) : null}
        <span className={clsx("truncate font-semibold", active ? "text-white" : "")}>{label}</span>
        <span className="fleet-tree-count rounded-full px-1.5 text-[11px] font-bold tabular-nums">{count}</span>
        {hasMaintenance && (
          <span className="h-1.5 w-1.5 flex-none rounded-full bg-teal-400 shadow-[0_0_4px_color-mix(in_srgb,var(--th-status-maint)_60%,transparent)]" title="Has devices in maintenance" />
        )}
      </span>
    </button>
  );
}
