import { memo, useEffect, useMemo, useState } from "react";
import { ChevronRight, Server, Monitor, Box, LayoutGrid } from "lucide-react";
import clsx from "clsx";
import { Client, DeviceGroup } from "../api/clients";
import { Device } from "../api/devices";

const SHOW_EMPTY_STORAGE_KEY = "techi.deviceTree.showEmptyGroups";
const GROUP_ORDER = ["servers", "workstations", "mac devices", "linux devices", "network devices"];

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
  const activeGroupClientId = useMemo(() => {
    if (!selectedKey.startsWith("group-")) return null;
    const groupId = Number(selectedKey.replace("group-", ""));
    return groups.find((group) => group.id === groupId)?.client_id ?? null;
  }, [groups, selectedKey]);
  const [expandedClients, setExpandedClients] = useState<Set<number>>(new Set());
  const [showEmptyGroups, setShowEmptyGroups] = useState(readShowEmptyGroups);
  const allCount = devices.length;
  const unassignedCount = devices.filter((d) => !d.client_id).length;
  const clientCount = (clientId: number) => devices.filter((d) => d.client_id === clientId).length;
  const groupCount = (groupId: number) => devices.filter((d) => d.group_id === groupId).length;
  const clientHasMaintenance = (clientId: number) => devices.some((d) => d.client_id === clientId && d.is_in_maintenance);
  const groupHasMaintenance = (groupId: number) => devices.some((d) => d.group_id === groupId && d.is_in_maintenance);
  const sortedClients = useMemo(
    () => [...clients].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [clients]
  );
  const sortedGroups = useMemo(() => {
    const rank = (name: string) => {
      const index = GROUP_ORDER.indexOf(name.trim().toLowerCase());
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    return [...groups].sort((a, b) => {
      const rankDelta = rank(a.name) - rank(b.name);
      if (rankDelta !== 0) return rankDelta;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }, [groups]);
  const visibleClients = useMemo(() => {
    if (showEmptyGroups) return sortedClients;
    return sortedClients.filter((client) => {
      const hasDevices = clientCount(client.id) > 0;
      const hasVisibleGroups = sortedGroups.some((group) => group.client_id === client.id && groupCount(group.id) > 0);
      const isActive = selectedKey === `client-${client.id}` || activeGroupClientId === client.id;
      return hasDevices || hasVisibleGroups || isActive;
    });
  }, [activeGroupClientId, devices, selectedKey, showEmptyGroups, sortedClients, sortedGroups]);

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

      <div className="p-2">
        <ul className="space-y-0.5">
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
            const childGroups = sortedGroups.filter((group) => {
              if (group.client_id !== client.id) return false;
              if (showEmptyGroups) return true;
              return groupCount(group.id) > 0 || selectedKey === `group-${group.id}`;
            });
            const expanded = expandedClients.has(client.id);
            return (
              <li key={client.id}>
                <TreeButton
                  active={selectedKey === `client-${client.id}` || activeGroupClientId === client.id}
                  expanded={expanded}
                  hasChildren={childGroups.length > 0}
                  icon={Server}
                  label={client.name}
                  count={clientCount(client.id)}
                  hasMaintenance={clientHasMaintenance(client.id)}
                  onClick={() => toggleClient(client.id)}
                />
                {expanded && childGroups.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5 pl-5">
                    {childGroups.map((group) => (
                      <li key={group.id}>
                        <TreeButton
                          active={selectedKey === `group-${group.id}`}
                          child
                          icon={Monitor}
                          label={group.name}
                          count={groupCount(group.id)}
                          hasMaintenance={groupHasMaintenance(group.id)}
                          onClick={() => onSelect(`group-${group.id}`)}
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
        <label className="flex cursor-pointer items-center justify-between gap-3 text-[11px] font-medium text-slate-400">
          <span>Show empty groups</span>
          <input
            type="checkbox"
            checked={showEmptyGroups}
            onChange={(event) => setShowEmptyGroups(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-white/15 bg-slate-950 accent-orange-500"
          />
        </label>
        <p className="mt-2 text-[10px] text-slate-600">Browse by client · group · type</p>
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
      className={clsx(
        "flex w-full items-center rounded-md text-left text-xs transition-all duration-120",
        child ? "px-2 py-1.5" : "px-2 py-1.5",
        active
          ? "bg-techi-orange/[0.11] text-white shadow-[inset_2px_0_0_#ff553f]"
          : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
      )}
    >
      <span className="flex min-w-0 items-center gap-1">
        {hasChildren && (
          <ChevronRight className={clsx("h-3 w-3 shrink-0 transition-transform", expanded ? "rotate-90 text-slate-300" : "text-slate-600")} />
        )}
        <Icon className={clsx(child ? "h-3 w-3" : "h-3.5 w-3.5", "shrink-0", active ? "text-techi-orange" : "text-slate-600")} />
        <span className={clsx("truncate font-medium", active ? "text-white" : "")}>{label}</span>
        <span className={clsx("rounded-full px-1 text-[10px] tabular-nums", active ? "bg-white/10 text-slate-300" : "bg-white/[0.04] text-slate-600")}>{count}</span>
        {hasMaintenance && (
          <span className="h-1.5 w-1.5 flex-none rounded-full bg-sky-400 shadow-[0_0_4px_rgba(56,189,248,0.6)]" title="Has devices in maintenance" />
        )}
      </span>
    </button>
  );
}
