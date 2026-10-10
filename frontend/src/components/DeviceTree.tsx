import { memo, useEffect, useMemo, useState } from "react";
import { Building2, ChevronRight, LayoutGrid, Monitor, PackageX, RefreshCcw, Search, Server } from "lucide-react";
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
  const [clientQuery, setClientQuery] = useState("");

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
    const q = clientQuery.trim().toLowerCase();
    const matching = q ? sortedClients.filter((client) => client.name.toLowerCase().includes(q)) : sortedClients;
    if (showEmptyGroups) return matching;
    return matching.filter((client) => {
      const hasDevices = (treeCounts.byClient.get(client.id) ?? 0) > 0;
      const isActive = selectedKey === `client-${client.id}` || activeClientFolder?.clientId === client.id;
      return hasDevices || isActive;
    });
  }, [activeClientFolder, treeCounts, selectedKey, showEmptyGroups, sortedClients, clientQuery]);

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
    <aside className="premium-card th-explorer p-0" aria-label="Device explorer">
      <div className="th-panel-head">
        <h2>Explorer</h2>
        <button type="button" onClick={onRefreshCounts} className="th-icon-btn th-icon-btn-ghost !min-h-7 !min-w-7" title="Refresh counts" aria-label="Refresh counts">
          <RefreshCcw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="fleet-tree min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <ul className="space-y-0.5">
          <li>
            <TreeButton active={selectedKey === "all"} icon={LayoutGrid} label="All devices" count={allCount} onClick={() => onSelect("all")} />
          </li>
          <li>
            <TreeButton active={selectedKey === "unassigned"} icon={PackageX} label="No client" count={unassignedCount} onClick={() => onSelect("unassigned")} />
          </li>
        </ul>

        <div className="mt-4 flex items-center justify-between px-2.5">
          <p className="th-nav-section !mb-0 !px-0">Clients</p>
          <span className="text-[11px] tabular-nums" style={{ color: "var(--th-text-faint)" }}>{visibleClients.length}</span>
        </div>
        {sortedClients.length > 6 && (
          <label className="th-search mx-0.5 mt-2 !h-8">
            <Search className="h-3.5 w-3.5 flex-none" />
            <input value={clientQuery} onChange={(e) => setClientQuery(e.target.value)} placeholder="Filter clients" aria-label="Filter clients" />
          </label>
        )}

        <ul className="mt-1.5 space-y-0.5">
          {visibleClients.length === 0 && (
            <li className="px-2.5 py-3 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              {clientQuery ? "No clients match." : "No clients with devices."}
            </li>
          )}
          {visibleClients.map((client) => {
            const childFolders = CLIENT_FOLDERS.filter((folder) => {
              if (showEmptyGroups) return true;
              return folderCount(client.id, folder.id) > 0 || selectedKey === `client-${client.id}-${folder.id}`;
            });
            const expanded = expandedClients.has(client.id);
            return (
              <li key={client.id}>
                <TreeButton
                  active={selectedKey === `client-${client.id}`}
                  withinActive={activeClientFolder?.clientId === client.id}
                  expanded={expanded}
                  hasChildren={childFolders.length > 0}
                  icon={Building2}
                  label={client.name}
                  count={clientCount(client.id)}
                  hasMaintenance={clientHasMaintenance(client.id)}
                  onClick={() => toggleClient(client.id)}
                />
                {expanded && childFolders.length > 0 && (
                  <ul className="fleet-tree-child">
                    {childFolders.map((folder) => {
                      const platforms = showPlatformFolders ? platformChildren(client.id, folder.id) : [];
                      return (
                        <li key={folder.id}>
                          <TreeButton
                            active={selectedKey === `client-${client.id}-${folder.id}`}
                            child
                            icon={folder.id === "servers" ? Server : Monitor}
                            label={folder.label}
                            count={folderCount(client.id, folder.id)}
                            hasMaintenance={folderHasMaintenance(client.id, folder.id)}
                            onClick={() => onSelect(`client-${client.id}-${folder.id}`)}
                          />
                          {platforms.length > 0 && (
                            <ul className="fleet-tree-child">
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

      <label className="th-panel-foot flex cursor-pointer items-center justify-between gap-3">
        <span>Show empty clients</span>
        <input
          type="checkbox"
          role="switch"
          className="th-switch"
          checked={showEmptyGroups}
          onChange={(event) => setShowEmptyGroups(event.target.checked)}
        />
      </label>
    </aside>
  );
});

export default DeviceTree;

interface TreeButtonProps {
  active: boolean;
  /** A sub-folder of this item is selected. */
  withinActive?: boolean;
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

function TreeButton({ active, withinActive = false, child = false, icon: Icon, platformIcon, label, count, expanded = false, hasChildren = false, hasMaintenance = false, onClick }: TreeButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      aria-expanded={hasChildren ? expanded : undefined}
      className="th-tree-item"
      data-active={active}
      data-within={withinActive}
      data-child={child}
    >
      {!child && (
        <span className="th-tree-caret" aria-hidden="true">
          {hasChildren && <ChevronRight className={clsx("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")} />}
        </span>
      )}
      {platformIcon ? (
        <PlatformIcon platform={platformIcon} size={14} className="shrink-0" />
      ) : Icon ? (
        <Icon className="h-4 w-4 shrink-0" />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hasMaintenance && <span className="th-tree-maint" title="Has devices in maintenance" />}
      <span className="th-tree-count">{count}</span>
    </button>
  );
}
