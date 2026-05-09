import { useEffect, useState } from "react";
import { Search, Monitor, Server, User, Wifi, WifiOff, ExternalLink } from "lucide-react";
import { getDevices, Device, DeviceFilters } from "../api/devices";
import { Button } from "../components/ui";

export default function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<DeviceFilters>({});
  const [searchQuery, setSearchQuery] = useState("");

  const loadDevices = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getDevices({ ...filters, search: searchQuery || undefined });
      setDevices(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load devices");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDevices();
  }, [filters, searchQuery]);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
  };

  const handleFilterChange = (key: keyof DeviceFilters, value: string) => {
    setFilters(prev => ({
      ...prev,
      [key]: value === "all" ? undefined : value
    }));
  };

  const getStatusIcon = (status: string) => {
    return status === "online" ? (
      <Wifi className="h-4 w-4 text-green-400" />
    ) : (
      <WifiOff className="h-4 w-4 text-gray-400" />
    );
  };

  const getDeviceTypeIcon = (type: string) => {
    return type === "server" ? (
      <Server className="h-4 w-4 text-blue-400" />
    ) : (
      <Monitor className="h-4 w-4 text-purple-400" />
    );
  };

  const formatLastSeen = (lastSeen?: string) => {
    if (!lastSeen) return "Never";
    const date = new Date(lastSeen);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
    return `${Math.floor(diffHours / 24)}d ago`;
  };

  if (loading) {
    return (
      <section className="space-y-6">
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
          <h2 className="text-2xl font-semibold text-white">Devices</h2>
          <p className="mt-3 text-slate-400">Loading devices...</p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="space-y-6">
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
          <h2 className="text-2xl font-semibold text-white">Devices</h2>
          <p className="mt-3 text-red-400">Error: {error}</p>
          <Button onClick={loadDevices} className="mt-4">
            Try Again
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold text-white">Devices</h2>
            <p className="mt-2 text-slate-400">
              {devices.length} device{devices.length !== 1 ? "s" : ""} found
            </p>
          </div>
          <Button onClick={loadDevices}>
            Refresh
          </Button>
        </div>

        {/* Filters and Search */}
        <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search by hostname, user, or IP..."
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              className="w-full rounded-2xl border border-white/10 bg-slate-900/50 py-2 pl-10 pr-4 text-white placeholder-slate-400 focus:border-techi-orange focus:outline-none"
            />
          </div>

          <div className="flex gap-2">
            <select
              value={filters.status || "all"}
              onChange={(e) => handleFilterChange("status", e.target.value)}
              className="rounded-2xl border border-white/10 bg-slate-900/50 px-3 py-2 text-white focus:border-techi-orange focus:outline-none"
            >
              <option value="all">All Status</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
            </select>

            <select
              value={filters.device_type || "all"}
              onChange={(e) => handleFilterChange("device_type", e.target.value)}
              className="rounded-2xl border border-white/10 bg-slate-900/50 px-3 py-2 text-white focus:border-techi-orange focus:outline-none"
            >
              <option value="all">All Types</option>
              <option value="server">Servers</option>
              <option value="client">Clients</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </div>
        </div>
      </div>

      {/* Devices Table */}
      {devices.length === 0 ? (
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-12 text-center shadow-soft">
          <Monitor className="mx-auto h-12 w-12 text-slate-400" />
          <h3 className="mt-4 text-lg font-semibold text-white">No devices found</h3>
          <p className="mt-2 text-slate-400">
            {searchQuery || filters.status || filters.device_type
              ? "Try adjusting your search or filters"
              : "No devices have been registered yet"}
          </p>
        </div>
      ) : (
        <div className="rounded-3xl border border-white/10 bg-slate-950/80 shadow-soft overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-white/10">
                <tr className="text-left">
                  <th className="px-6 py-4 text-sm font-semibold text-slate-300">Device</th>
                  <th className="px-6 py-4 text-sm font-semibold text-slate-300">Status</th>
                  <th className="px-6 py-4 text-sm font-semibold text-slate-300">Type</th>
                  <th className="px-6 py-4 text-sm font-semibold text-slate-300">User</th>
                  <th className="px-6 py-4 text-sm font-semibold text-slate-300">OS</th>
                  <th className="px-6 py-4 text-sm font-semibold text-slate-300">IP Address</th>
                  <th className="px-6 py-4 text-sm font-semibold text-slate-300">Last Seen</th>
                  <th className="px-6 py-4 text-sm font-semibold text-slate-300">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {devices.map((device) => (
                  <tr key={device.id} className="hover:bg-white/5">
                    <td className="px-6 py-4">
                      <div>
                        <div className="font-medium text-white">{device.hostname || "Unknown"}</div>
                        <div className="text-sm text-slate-400">{device.rustdesk_id}</div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(device.status)}
                        <span className={`text-sm capitalize ${
                          device.status === "online" ? "text-green-400" : "text-gray-400"
                        }`}>
                          {device.status}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {getDeviceTypeIcon(device.device_type)}
                        <span className="text-sm text-slate-300 capitalize">
                          {device.device_type}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <User className="h-4 w-4 text-slate-400" />
                        <span className="text-sm text-slate-300">
                          {device.current_user || "Unknown"}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-slate-300">
                        {device.os_name && device.os_version
                          ? `${device.os_name} ${device.os_version}`
                          : device.os_name || "Unknown"
                        }
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-slate-300">
                        {device.local_ip || device.public_ip || "Unknown"}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm text-slate-400">
                        {formatLastSeen(device.last_seen)}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <Button
                        size="sm"
                        className="flex items-center gap-2"
                        onClick={() => {
                          // Placeholder for RustDesk connection
                          window.open(`rustdesk://${device.rustdesk_id}`, "_blank");
                        }}
                      >
                        <ExternalLink className="h-3 w-3" />
                        Connect
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
