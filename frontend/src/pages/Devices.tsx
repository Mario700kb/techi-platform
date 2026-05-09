import { useEffect, useMemo, useState } from "react";
import { RefreshCcw, Monitor, Server } from "lucide-react";
import { getDevices, Device, DeviceFilters } from "../api/devices";
import DeviceTree from "../components/DeviceTree";
import DevicesTable from "../components/DevicesTable";
import { Badge, Button } from "../components/ui";

const categoryFilters: Record<string, Partial<DeviceFilters>> = {
  all: {},
  unassigned: { device_type: "unassigned" },
  "adp-servers": { client_id: 1, device_type: "server" },
  "adp-clients": { client_id: 1, device_type: "client" },
  "top-servers": { client_id: 2, device_type: "server" },
  "top-clients": { client_id: 2, device_type: "client" },
};

export default function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [allDevices, setAllDevices] = useState<Device[]>([]);
  const [filters, setFilters] = useState<DeviceFilters>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTreeKey, setSelectedTreeKey] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAllDevices = async () => {
    try {
      const data = await getDevices({});
      setAllDevices(data);
    } catch {
      // ignore
    }
  };

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
    loadAllDevices();
  }, []);

  useEffect(() => {
    loadDevices();
  }, [filters, searchQuery]);

  const handleTreeSelect = (key: string) => {
    setSelectedTreeKey(key);
    const nextFilters: DeviceFilters = {
      status: filters.status,
      client_id: undefined,
      group_id: undefined,
      device_type: undefined,
      ...categoryFilters[key],
    };
    setFilters(nextFilters);
  };

  const handleSearch = (value: string) => {
    setSearchQuery(value);
  };

  const handleFilterChange = (key: keyof DeviceFilters, value: string) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value === "all" ? undefined : value,
    }));
  };

  const handleRefresh = async () => {
    await Promise.all([loadAllDevices(), loadDevices()]);
  };

  const statusSummary = useMemo(() => {
    const online = devices.filter((item) => item.status === "online").length;
    const offline = devices.filter((item) => item.status === "offline").length;
    return { online, offline, total: devices.length };
  }, [devices]);

  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-techi-orange">Devices hub</p>
            <h1 className="mt-3 text-3xl font-semibold text-white">Remote device management</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-400">
              Review device status, filter by client groups, and access remote sessions through the connected RustDesk IDs.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleRefresh}>
              <RefreshCcw className="h-4 w-4" />
              Refresh all
            </Button>
            <Badge variant="ghost">Showing {statusSummary.total} devices</Badge>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div>
          <DeviceTree selectedKey={selectedTreeKey} onSelect={handleTreeSelect} devices={allDevices} />
        </div>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
              <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Total</p>
              <p className="mt-4 text-3xl font-semibold text-white">{statusSummary.total}</p>
              <p className="mt-2 text-sm text-slate-400">Devices matching current selection</p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
              <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Online</p>
              <p className="mt-4 text-3xl font-semibold text-emerald-300">{statusSummary.online}</p>
              <p className="mt-2 text-sm text-slate-400">Active endpoints available</p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-6 shadow-soft">
              <p className="text-sm uppercase tracking-[0.3em] text-techi-orange">Offline</p>
              <p className="mt-4 text-3xl font-semibold text-slate-200">{statusSummary.offline}</p>
              <p className="mt-2 text-sm text-slate-400">Devices not responding</p>
            </div>
          </div>

          <DevicesTable
            devices={devices}
            loading={loading}
            error={error}
            filters={filters}
            searchQuery={searchQuery}
            onSearch={handleSearch}
            onFilterChange={handleFilterChange}
            onRefresh={handleRefresh}
          />
        </div>
      </div>
    </section>
  );
}
