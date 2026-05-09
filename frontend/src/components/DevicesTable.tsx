import { Search, Server, Monitor, Wifi, WifiOff, ExternalLink } from "lucide-react";
import { Device, DeviceFilters } from "../api/devices";
import { Badge, Button } from "./ui";

interface DevicesTableProps {
  devices: Device[];
  loading: boolean;
  error: string | null;
  filters: DeviceFilters;
  searchQuery: string;
  onSearch: (value: string) => void;
  onFilterChange: (key: keyof DeviceFilters, value: string) => void;
  onRefresh: () => void;
}

const getStatusDot = (status: string) => {
  const isOnline = status === "online";
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span
        className={`inline-flex h-2.5 w-2.5 rounded-full ${
          isOnline ? "bg-emerald-400" : "bg-slate-500"
        }`}
      />
      <span className={isOnline ? "text-emerald-300" : "text-slate-400"}>{status}</span>
    </span>
  );
};

const getTypeLabel = (deviceType: string) => {
  if (deviceType === "server") return <Badge variant="secondary">Server</Badge>;
  if (deviceType === "client") return <Badge variant="ghost">Client</Badge>;
  return <Badge variant="neutral">Unassigned</Badge>;
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

export default function DevicesTable({
  devices,
  loading,
  error,
  filters,
  searchQuery,
  onSearch,
  onFilterChange,
  onRefresh,
}: DevicesTableProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-white">Devices catalog</h2>
            <p className="mt-2 text-sm text-slate-400">Manage the full device roster for your clients in one view.</p>
          </div>
          <Button onClick={onRefresh}>Refresh list</Button>
        </div>

        <div className="mt-6 grid gap-3 lg:grid-cols-[1.6fr_1fr] xl:grid-cols-[2fr_1fr_1fr]">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Search hostname, user, domain or IP..."
              className="w-full rounded-2xl border border-white/10 bg-slate-900/60 py-3 pl-11 pr-4 text-white placeholder-slate-500 focus:border-techi-orange focus:outline-none"
            />
          </div>

          <select
            value={filters.status || "all"}
            onChange={(event) => onFilterChange("status", event.target.value)}
            className="rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3 text-white focus:border-techi-orange focus:outline-none"
          >
            <option value="all">All statuses</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
          </select>

          <select
            value={filters.device_type || "all"}
            onChange={(event) => onFilterChange("device_type", event.target.value)}
            className="rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3 text-white focus:border-techi-orange focus:outline-none"
          >
            <option value="all">All device types</option>
            <option value="server">Server</option>
            <option value="client">Client</option>
            <option value="unassigned">Unassigned</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-12 text-center shadow-soft">
          <p className="text-xl font-semibold text-white">Loading devices...</p>
          <p className="mt-2 text-sm text-slate-500">Fetching the latest device inventory from the backend.</p>
        </div>
      ) : error ? (
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-12 text-center shadow-soft">
          <p className="text-xl font-semibold text-white">Unable to load devices</p>
          <p className="mt-2 text-sm text-red-400">{error}</p>
          <Button onClick={onRefresh} className="mt-4">Try again</Button>
        </div>
      ) : devices.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-white/10 bg-slate-950/80 p-16 text-center shadow-soft">
          <p className="text-3xl text-slate-200">No devices found</p>
          <p className="mt-3 text-sm text-slate-500">Try changing the filters or search terms to reveal devices.</p>
        </div>
      ) : (
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 shadow-soft overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-left">
              <thead className="bg-slate-950/90 text-slate-400">
                <tr>
                  <th className="px-6 py-4 text-sm font-semibold">Status</th>
                  <th className="px-6 py-4 text-sm font-semibold">Hostname</th>
                  <th className="px-6 py-4 text-sm font-semibold">RustDesk ID</th>
                  <th className="px-6 py-4 text-sm font-semibold">Current user</th>
                  <th className="px-6 py-4 text-sm font-semibold">Public IP</th>
                  <th className="px-6 py-4 text-sm font-semibold">Local IP</th>
                  <th className="px-6 py-4 text-sm font-semibold">Domain</th>
                  <th className="px-6 py-4 text-sm font-semibold">OS</th>
                  <th className="px-6 py-4 text-sm font-semibold">Last seen</th>
                  <th className="px-6 py-4 text-sm font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {devices.map((device) => (
                  <tr key={device.id} className="group hover:bg-white/5">
                    <td className="px-6 py-4 align-top">{getStatusDot(device.status)}</td>
                    <td className="px-6 py-4 align-top">
                      <div className="font-medium text-white">{device.hostname || "Unknown"}</div>
                      <div className="text-xs text-slate-500">{device.device_type}</div>
                    </td>
                    <td className="px-6 py-4 align-top text-slate-300">{device.rustdesk_id}</td>
                    <td className="px-6 py-4 align-top text-slate-300">{device.current_user || "—"}</td>
                    <td className="px-6 py-4 align-top text-slate-300">{device.public_ip || "—"}</td>
                    <td className="px-6 py-4 align-top text-slate-300">{device.local_ip || "—"}</td>
                    <td className="px-6 py-4 align-top text-slate-300">{device.domain || "—"}</td>
                    <td className="px-6 py-4 align-top text-slate-300">{device.os_name || "—"}</td>
                    <td className="px-6 py-4 align-top text-slate-300">{formatLastSeen(device.last_seen)}</td>
                    <td className="px-6 py-4 align-top">
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 rounded-2xl bg-techi-pink px-3 py-2 text-xs font-semibold uppercase tracking-[0.15em] text-white transition hover:bg-techi-orange"
                        onClick={() => window.open(`rustdesk://${device.rustdesk_id}`, "_blank")}
                      >
                        <ExternalLink className="h-3 w-3" />
                        Connect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="border-t border-white/10 bg-slate-950/80 p-4 text-sm text-slate-400 sm:flex sm:items-center sm:justify-between">
            <div>Showing {devices.length} devices</div>
            <div className="mt-2 flex items-center gap-3 sm:mt-0">
              <Badge variant="ghost">Page 1 of 1</Badge>
              <Badge variant="secondary">Pagination placeholder</Badge>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
