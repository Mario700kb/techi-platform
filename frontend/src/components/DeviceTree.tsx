import { Server, Monitor, Box, LayoutGrid } from "lucide-react";
import clsx from "clsx";
import { Device } from "../api/devices";

interface DeviceTreeProps {
  selectedKey: string;
  onSelect: (key: string) => void;
  devices: Device[];
}

const treeData = [
  {
    key: "all",
    label: "All Devices",
    icon: LayoutGrid,
    children: [],
  },
  {
    key: "unassigned",
    label: "Unassigned",
    icon: Box,
    children: [],
  },
  {
    key: "adp",
    label: "ADPascucci",
    icon: Server,
    children: [
      { key: "adp-servers", label: "Servers", icon: Server },
      { key: "adp-clients", label: "Clients", icon: Monitor },
    ],
  },
  {
    key: "top",
    label: "TopExpress",
    icon: Server,
    children: [
      { key: "top-servers", label: "Servers", icon: Server },
      { key: "top-clients", label: "Clients", icon: Monitor },
    ],
  },
];

function createCounts(devices: Device[]) {
  const all = devices.length;
  const unassigned = devices.filter((item) => item.device_type === "unassigned").length;
  const adpServers = devices.filter((item) => item.client_id === 1 && item.device_type === "server").length;
  const adpClients = devices.filter((item) => item.client_id === 1 && item.device_type === "client").length;
  const topServers = devices.filter((item) => item.client_id === 2 && item.device_type === "server").length;
  const topClients = devices.filter((item) => item.client_id === 2 && item.device_type === "client").length;

  return {
    all,
    unassigned,
    adpServers,
    adpClients,
    topServers,
    topClients,
  };
}

export default function DeviceTree({ selectedKey, onSelect, devices }: DeviceTreeProps) {
  const counts = createCounts(devices);

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-5 shadow-soft">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-techi-orange">Device explorer</p>
            <h3 className="mt-2 text-lg font-semibold text-white">Managed tree</h3>
          </div>
          <div className="rounded-2xl bg-white/5 px-3 py-1 text-xs text-slate-200">Live</div>
        </div>
        <p className="mt-4 text-sm text-slate-400">Browse devices by client, group, and assignment state.</p>
      </div>

      <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-4 shadow-soft">
        <ul className="space-y-3">
          {treeData.map((node) => {
            const isParent = node.children.length > 0;
            const expanded = node.key === "adp" || node.key === "top";
            const Icon = node.icon;
            const count =
              node.key === "all"
                ? counts.all
                : node.key === "unassigned"
                ? counts.unassigned
                : node.key === "adp"
                ? counts.adpServers + counts.adpClients
                : node.key === "top"
                ? counts.topServers + counts.topClients
                : 0;

            return (
              <li key={node.key} className="space-y-2">
                <button
                  type="button"
                  onClick={() => onSelect(node.key)}
                  className={clsx(
                    "flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition",
                    selectedKey === node.key
                      ? "bg-techi-orange text-slate-950"
                      : "bg-slate-900/70 text-slate-300 hover:bg-white/5 hover:text-white"
                  )}
                >
                  <span className="flex items-center gap-3">
                    <Icon className="h-4 w-4" />
                    <span className="font-medium">{node.label}</span>
                  </span>
                  <span className="text-sm text-slate-400">{count}</span>
                </button>

                {isParent && (
                  <ul className="space-y-2 pl-6">
                    {node.children.map((child) => {
                      const ChildIcon = child.icon;
                      const childCount =
                        child.key === "adp-servers"
                          ? counts.adpServers
                          : child.key === "adp-clients"
                          ? counts.adpClients
                          : child.key === "top-servers"
                          ? counts.topServers
                          : child.key === "top-clients"
                          ? counts.topClients
                          : 0;
                      return (
                        <li key={child.key}>
                          <button
                            type="button"
                            onClick={() => onSelect(child.key)}
                            className={clsx(
                              "flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition",
                              selectedKey === child.key
                                ? "bg-techi-pink/90 text-slate-950"
                                : "bg-slate-900/60 text-slate-300 hover:bg-white/5 hover:text-white"
                            )}
                          >
                            <span className="flex items-center gap-3">
                              <ChildIcon className="h-4 w-4" />
                              {child.label}
                            </span>
                            <span className="text-sm text-slate-400">{childCount}</span>
                          </button>
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
    </div>
  );
}
