import { memo, useEffect, useMemo, useState } from "react";
import { ChevronRight, Server, Monitor, Box, LayoutGrid } from "lucide-react";
import clsx from "clsx";
import { Client, DeviceGroup } from "../api/clients";
import { Device } from "../api/devices";

const SHOW_EMPTY_STORAGE_KEY = "techi.deviceTree.showEmptyGroups";
const CLIENT_FOLDERS = [
  { id: "servers", label: "Servers", smartFolder: "windows_server" },
  { id: "clientpc", label: "Client PC", smartFolder: "windows_workstation" },
] as const;

const readShowEmptyGroups = () => {
  try {
    return window.localStorage.getItem(SHOW_EMPTY_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
};

interface DeviceTreeProps {
  selectedKey: string;
  onSelect: (key: string) => void;
  devices: Device[];
  clients: Client[];
  groups: DeviceGroup[];
}

const DeviceTree = memo(function DeviceTree({ selectedKey, onSelect, devices, clients, groups }: DeviceTreeProps) {
  void groups;
  const activeClientFolder = useMemo(() => {
    const match = selectedKey.match(/^client-(\d+)-(servers|clientpc)$/);
    if (!match) return null;
    return { clientId: Number(match[1]), folderId: match[2] };
  }, [selectedKey]);
  const [expandedClients, setExpandedClients] = useState<Set<number>>(new Set());
  const [showEmptyGroups, setShowEmptyGroups] = useState(readShowEmptyGroups);
  const allCount = devices.length;
  const resolvedClientId = (device: Device) => device.resolved_client_id ?? device.client_id ?? null;
  const resolvedCategory = (device: Device) => device.resolved_device_category ?? "unassigned";
  const unassignedCount = devices.filter((d) => !resolvedClientId(d)).length;
  const clientCount = (clientId: number) => devices.filter((d) => resolvedClientId(d) === clientId).length;
  const folderCount = (clientId: number, folderId: string) => devices.filter((device) => {
    if (resolvedClientId(device) !== clientId) return false;
    return resolvedCategory(device) === folderId;
  }).length;
  const clientHasMaintenance = (clientId: number) => devices.some((d) => resolvedClientId(d) === clientId && d.is_in_maintenance);
  const folderHasMaintenance = (clientId: number, folderId: string) => devices.some((device) => {
    if (resolvedClientId(device) !== clientId || !device.is_in_maintenance) return false;
    return resolvedCategory(device) === folderId;
  });
  const sortedClients = useMemo(
    () => [...clients].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [clients]
  );
  const visibleClients = useMemo(() => {
    if (showEmptyGroups) return sortedClients;
    return sortedClients.filter((client) => {
      const hasDevices = clientCount(client.id) > 0;
      const isActive = selectedKey === `client-${client.id}` || activeClientFolder?.clientId === client.id;
      return hasDevices || isActive;
    });
  }, [activeClientFolder, devices, selectedKey, showEmptyGroups, sortedClients]);

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
          <span className="rounded-full border border-emerald-400/25 bg-emerald-400/[0.07] px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
            Live
          </span>
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
                    {childFolders.map((folder) => (
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
                      </li>
                    ))}
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
  icon: typeof LayoutGrid;
  label: string;
  count: number;
  expanded?: boolean;
  hasChildren?: boolean;
  hasMaintenance?: boolean;
  onClick: () => void;
}

function TreeButton({ active, child = false, icon: Icon, label, count, expanded = false, hasChildren = false, hasMaintenance = false, onClick }: TreeButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={clsx(
        "flex w-full items-center rounded-md text-left transition-all duration-120",
        child ? "px-2.5 py-1.5" : "px-2.5 py-1.5",
        active
          ? "bg-[#3A1A14] text-[#FF6B47] shadow-[inset_2px_0_0_#E85A3C,inset_0_0_0_1px_rgba(232,90,60,0.18)]"
          : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {hasChildren && (
          <ChevronRight className={clsx("h-3.5 w-3.5 shrink-0 transition-transform", expanded ? "rotate-90 text-slate-300" : "text-slate-600")} />
        )}
        <Icon className={clsx(child ? "h-3.5 w-3.5" : "h-4 w-4", "shrink-0", active ? "text-techi-orange" : "text-slate-600")} />
        <span className={clsx("truncate font-semibold", active ? "text-white" : "")}>{label}</span>
        <span className="fleet-tree-count rounded-full px-1.5 text-[11px] font-bold tabular-nums">{count}</span>
        {hasMaintenance && (
          <span className="h-1.5 w-1.5 flex-none rounded-full bg-sky-400 shadow-[0_0_4px_rgba(56,189,248,0.6)]" title="Has devices in maintenance" />
        )}
      </span>
    </button>
  );
}
