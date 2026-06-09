import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Clock3, Radio, RefreshCcw, Server, ShieldAlert, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { Client, DeviceGroup, getClients, getGroups } from "../api/clients";
import { archiveDevice, deleteDevice, getDevicesSummary, getDeviceTree, restoreDevice, Device, DeviceFilters, DeviceStats } from "../api/devices";
import { PatchStatus } from "../api/inventory";
import DeviceDrawer from "../components/DeviceDrawer";
import DeviceTree from "../components/DeviceTree";
import DevicesTable, { type ActiveActionEntry, type QuickFilter } from "../components/DevicesTable";
import NotificationCenter from "../components/NotificationCenter";
import { Button } from "../components/ui";
import { useAlerts } from "../hooks/useAlerts";
import { useFavorites } from "../hooks/useFavorites";
import { useDeviceRealtime } from "../hooks/useDeviceRealtime";
import { usePollingRefresh } from "../hooks/usePollingRefresh";
import { useAuth } from "../auth/AuthContext";
import { isActiveStatus } from "../api/actions";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";
import { DeviceHealthSummary } from "../types/telemetry";

const DEVICE_PATCH_EVENTS = new Set([
  "device_online",
  "device_offline",
  "device_updated",
  "heartbeat_received",
  "rustdesk_updated",
  "rustdesk_online",
  "rustdesk_offline",
  "sync_failed",
]);

interface TreeCounts {
  total: number;
  unassigned: number;
  byClient: Map<number, number>;
}

function computeTreeCounts(devices: Device[]): TreeCounts {
  const byClient = new Map<number, number>();
  let unassigned = 0;
  for (const d of devices) {
    const cid = d.resolved_client_id ?? d.client_id ?? null;
    if (cid === null) unassigned++;
    else byClient.set(cid, (byClient.get(cid) ?? 0) + 1);
  }
  return { total: devices.length, unassigned, byClient };
}

function deviceMatchesFilters(device: Device, filters: DeviceFilters, searchQuery: string): boolean {
  const resolvedClientId = device.resolved_client_id ?? device.client_id ?? null;
  const resolvedCategory = device.resolved_device_category ?? "unassigned";
  if (filters.status && device.status !== filters.status) return false;
  if (filters.freshness_state && device.freshness_state !== filters.freshness_state) return false;
  if (filters.device_type && device.device_type !== filters.device_type) return false;
  if (filters.lifecycle_state === "archived" && !device.is_archived) return false;
  if ((filters.lifecycle_state === "active" || !filters.lifecycle_state) && device.is_archived) return false;
  if (filters.client_id === -1) {
    if (resolvedClientId !== null) return false;
  } else if (filters.client_id && resolvedClientId !== filters.client_id) {
    return false;
  }
  if (filters.group_id && device.group_id !== filters.group_id) return false;
  if (filters.smart_folder === "windows_server" && resolvedCategory !== "servers") return false;
  if (filters.smart_folder === "windows_workstation" && resolvedCategory !== "clientpc") return false;
  if (filters.maintenance_state === "maintenance" && !device.is_in_maintenance) return false;
  if (filters.maintenance_state === "normal" && device.is_in_maintenance) return false;
  if (filters.duplicate_candidates && !device.duplicate_candidate) return false;
  if (filters.assignment_source) {
    const source = device.resolved_assignment_source ?? device.assignment_source;
    const expectedSources: Record<NonNullable<DeviceFilters["assignment_source"]>, string[]> = {
      auto: ["system_auto", "trusted_domain", "auto_os"],
      manual: ["manual", "legacy_manual"],
      token: ["enrollment_token"],
      unassigned: ["unassigned", "system_auto_unassigned"],
    };
    if (!expectedSources[filters.assignment_source].includes(source ?? "unassigned")) return false;
  }
  if (searchQuery) {
    const query = searchQuery.toLowerCase();
    const searchable = [
      device.hostname,
      device.rustdesk_id,
      device.current_user,
      device.public_ip,
      device.local_ip,
      device.domain,
    ].filter(Boolean).join(" ").toLowerCase();
    if (!searchable.includes(query)) return false;
  }
  return true;
}

export default function Devices() {
  const { can, user } = useAuth();
  const { favorites, toggle: toggleFavorite } = useFavorites();
  const [searchParams, setSearchParams] = useSearchParams();
  const validQuickFilters = new Set<QuickFilter>([
    "all", "online", "stale", "offline", "servers", "workstations", "needs_updates",
    "reboot_required", "warnings", "critical", "healthy", "maintenance",
    "needs_attention", "low_health", "rustdesk_issues", "favorites",
  ]);
  const requestedQuickFilter = searchParams.get("filter") as QuickFilter | null;
  const quickFilter = requestedQuickFilter && validQuickFilters.has(requestedQuickFilter)
    ? requestedQuickFilter
    : "all";

  const handleQuickFilterChange = useCallback((f: QuickFilter) => {
    const next = new URLSearchParams(searchParams);
    if (f === "all") next.delete("filter");
    else next.set("filter", f);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [allDevices, setAllDevices] = useState<Device[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [filters, setFilters] = useState<DeviceFilters>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTreeKey, setSelectedTreeKey] = useState("all");
  const [hideOldOffline, setHideOldOffline] = useState(false);
  const [hideOfflineDays, setHideOfflineDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const devicesLoadedRef = useRef(false);
  const refreshTimerRef = useRef<number | undefined>();
  // Stable refs so mergeDeviceEvent can synchronously check device existence
  // without relying on React 18 state-updater side-effects (which run async).
  const allDevicesRef = useRef<Device[]>([]);
  const devicesRef = useRef<Device[]>([]);
  // Keep refs in sync with state so callbacks see the latest values without
  // needing them in their dependency arrays.
  allDevicesRef.current = allDevices;
  devicesRef.current = devices;

  const [drawerDeviceId, setDrawerDeviceId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerCloseTimerRef = useRef<number | undefined>();
  const [latestEvent, setLatestEvent] = useState<DeviceRealtimeEvent | null>(null);
  const [treeCounts, setTreeCounts] = useState<TreeCounts>(() => computeTreeCounts([]));
  const [snapshotStats, setSnapshotStats] = useState<DeviceStats>({ total: 0, online: 0, stale: 0, offline: 0 });
  const [healthMap, setHealthMap] = useState<Record<number, DeviceHealthSummary>>({});
  const [patchMap, setPatchMap] = useState<Record<number, PatchStatus>>({});
  const [activeActionMap, setActiveActionMap] = useState<Record<number, ActiveActionEntry>>({});

  const drawerDevice = useMemo(
    () =>
      drawerDeviceId != null
        ? (allDevices.find((d) => d.id === drawerDeviceId) ??
           devices.find((d) => d.id === drawerDeviceId) ??
           null)
        : null,
    [drawerDeviceId, allDevices, devices]
  );

  const openDrawer = useCallback((device: Device) => {
    window.clearTimeout(drawerCloseTimerRef.current);
    setDrawerDeviceId(device.id);
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    window.clearTimeout(drawerCloseTimerRef.current);
    drawerCloseTimerRef.current = window.setTimeout(() => setDrawerDeviceId(null), 310);
  }, []);

  const jumpToDevice = useCallback((deviceId: number) => {
    const device = allDevices.find((d) => d.id === deviceId);
    if (device) openDrawer(device);
  }, [allDevices, openDrawer]);

  const loadSnapshot = useCallback(async () => {
    const showLoading = !devicesLoadedRef.current;
    try {
      if (showLoading) setLoading(true);
      setError(null);

      // Fire a fast tree-counts query in parallel so the sidebar renders before
      // the full 575KB summary completes (GROUP BY only, no telemetry/health).
      const treePromise = getDeviceTree().then((tree) => {
        setTreeCounts({
          total: tree.total,
          unassigned: tree.unassigned,
          byClient: new Map(Object.entries(tree.by_client).map(([id, count]) => [Number(id), count])),
        });
      }).catch(() => undefined);

      const snapshotPromise = getDevicesSummary().then((snapshot) => {
        const sorted = [...snapshot.devices].sort((a, b) => (a.hostname ?? "").localeCompare(b.hostname ?? ""));
        setAllDevices(sorted);
        setDevices(sorted.filter((device) => deviceMatchesFilters(device, filters, searchQuery)));
        setSnapshotStats(snapshot.stats);
        setTreeCounts({
          total: snapshot.tree_counts.total,
          unassigned: snapshot.tree_counts.unassigned,
          byClient: new Map(Object.entries(snapshot.tree_counts.by_client).map(([id, count]) => [Number(id), count])),
        });
        setHealthMap(Object.fromEntries(snapshot.health.map((item) => [item.device_id, item])));
        setPatchMap(Object.fromEntries(snapshot.patches.map((item) => [item.device_id, item])));
        devicesLoadedRef.current = true;
      });

      // Wait for both but don't let a slow summary block tree rendering
      await Promise.all([treePromise, snapshotPromise]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load devices");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [filters, searchQuery]);

  const loadOrgData = useCallback(async () => {
    try {
      const [clientData, groupData] = await Promise.all([getClients(), getGroups()]);
      setClients(clientData);
      setGroups(groupData);
    } catch {
      // organization metadata is optional for device refresh
    }
  }, []);

  const loadDevices = useCallback(async () => {
    setDevices(
      allDevices
        .filter((device) => deviceMatchesFilters(device, filters, searchQuery))
        .sort((a, b) => (a.hostname ?? "").localeCompare(b.hostname ?? ""))
    );
  }, [allDevices, filters, searchQuery]);

  const refreshBoth = useCallback(async () => {
    await loadSnapshot();
  }, [loadSnapshot]);

  const deviceMatchesCurrentView = useCallback(
    (device: Device) => deviceMatchesFilters(device, filters, searchQuery),
    [filters, searchQuery]
  );

  const mergeDeviceEvent = useCallback(
    (event: DeviceRealtimeEvent) => {
      const eventDevice = event.data;
      if (!eventDevice?.id) {
        return false;
      }

      const applyPatch = (items: Device[]) => {
        const index = items.findIndex((item) => item.id === eventDevice.id);
        if (index === -1) {
          return { nextItems: items, found: false };
        }
        const nextDevice = { ...items[index], ...eventDevice } as Device;
        if (
          items[index].last_seen === nextDevice.last_seen &&
          items[index].status === nextDevice.status &&
          items[index].freshness_state === nextDevice.freshness_state &&
          items[index].rustdesk_sync_state === nextDevice.rustdesk_sync_state &&
          items[index].rustdesk_status === nextDevice.rustdesk_status &&
          items[index].client_id === nextDevice.client_id &&
          items[index].group_id === nextDevice.group_id &&
          items[index].client_name === nextDevice.client_name &&
          items[index].group_name === nextDevice.group_name &&
          items[index].resolved_client_id === nextDevice.resolved_client_id &&
          items[index].resolved_client_name === nextDevice.resolved_client_name &&
          items[index].resolved_group === nextDevice.resolved_group &&
          items[index].resolved_assignment_source === nextDevice.resolved_assignment_source &&
          items[index].resolved_device_category === nextDevice.resolved_device_category &&
          items[index].is_archived === nextDevice.is_archived
        ) {
          return { nextItems: items, found: true, nextDevice: items[index] };
        }
        const nextItems = [...items];
        nextItems[index] = nextDevice;
        return { nextItems, found: true, nextDevice };
      };

      // Check existence synchronously against the stable refs BEFORE scheduling
      // any setState calls.  React 18 batches state updates so the updater
      // functions run asynchronously; reading the found flag from inside them
      // always yields false at return time.
      const foundInAll = allDevicesRef.current.some((d) => d.id === eventDevice.id);
      const foundInVisible = devicesRef.current.some((d) => d.id === eventDevice.id);

      setAllDevices((items) => applyPatch(items).nextItems);

      setDevices((items) => {
        const result = applyPatch(items);
        if (!result.found) {
          const baseDevice = allDevicesRef.current.find((item) => item.id === eventDevice.id);
          const nextDevice = baseDevice ? ({ ...baseDevice, ...eventDevice } as Device) : null;
          if (nextDevice && deviceMatchesCurrentView(nextDevice)) {
            return [...items, nextDevice];
          }
          return items;
        }
        return result.nextDevice && deviceMatchesCurrentView(result.nextDevice)
          ? result.nextItems
          : result.nextItems.filter((item) => item.id !== eventDevice.id);
      });

      return foundInAll || foundInVisible;
    },
    [deviceMatchesCurrentView]
  );

  const scheduleDevicesRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      return;
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = undefined;
      void refreshBoth();
    }, 5000);
  }, [refreshBoth]);

  useEffect(() => {
    void loadOrgData();
  }, [loadOrgData]);

  const { alerts, alertCount } = useAlerts({ latestEvent });

  const wsStatus = useDeviceRealtime({
    onEvent: (event) => {
      if (event.type === "connection_ready") {
        return;
      }
      setLatestEvent(event);
      if (event.type === "telemetry_updated" && event.data?.id) {
        const deviceId = event.data.id;
        const d = event.data;
        setHealthMap((prev) => ({
          ...prev,
          [deviceId]: {
            device_id: deviceId,
            health_state: (d.health_state as DeviceHealthSummary["health_state"]) ?? prev[deviceId]?.health_state ?? "healthy",
            health_score: d.health_score ?? prev[deviceId]?.health_score ?? 100,
            cpu_percent: d.cpu_percent ?? null,
            ram_percent: d.ram_percent ?? null,
            disk_percent: d.disk_percent ?? null,
            uptime_seconds: d.uptime_seconds ?? null,
            heartbeat_latency_ms: d.heartbeat_latency_ms ?? null,
            computed_at: event.occurred_at ?? null,
          },
        }));
        return;
      }

      if (event.type === "action_queued" || event.type === "action_status_changed") {
        const ev = event.data as Record<string, unknown>;
        const deviceId = typeof ev?.device_id === "number" ? ev.device_id : null;
        const actionType = typeof ev?.action_type === "string" ? ev.action_type : null;
        const status = typeof ev?.status === "string" ? ev.status : null;
        if (deviceId !== null && actionType && status) {
          setActiveActionMap((prev) => {
            if (isActiveStatus(status as Parameters<typeof isActiveStatus>[0])) {
              return { ...prev, [deviceId]: { action_type: actionType, status: status as ActiveActionEntry["status"] } };
            }
            // Action reached terminal state — remove from map only if it was the tracked one.
            const existing = prev[deviceId];
            if (existing?.action_type === actionType) {
              const next = { ...prev };
              delete next[deviceId];
              return next;
            }
            return prev;
          });
        }
        return;
      }

      if (DEVICE_PATCH_EVENTS.has(event.type)) {
        const patchedExistingDevice = mergeDeviceEvent(event);
        if (!patchedExistingDevice && event.type === "device_updated") {
          scheduleDevicesRefresh();
        }
      }
    },
  });

  usePollingRefresh(loadSnapshot, {
    intervalMs: 60000,
    enabled: wsStatus !== "connected",
    immediate: false,
  });

  useEffect(() => {
    void loadSnapshot();
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    return () => {
      window.clearTimeout(refreshTimerRef.current);
      window.clearTimeout(drawerCloseTimerRef.current);
    };
  }, []);

  const handleTreeSelect = (key: string) => {
    setSelectedTreeKey(key);
    const nextFilters: DeviceFilters = {
      status: filters.status,
      freshness_state: filters.freshness_state,
      maintenance_state: filters.maintenance_state,
      duplicate_candidates: filters.duplicate_candidates,
      smart_folder: undefined,
    };
    if (key === "unassigned") {
      nextFilters.client_id = -1;
      nextFilters.group_id = undefined;
    } else if (key.startsWith("client-")) {
      const match = key.match(/^client-(\d+)(?:-(servers|clientpc))?$/);
      if (match) {
        nextFilters.client_id = Number(match[1]);
        nextFilters.group_id = undefined;
        if (match[2] === "servers") {
          nextFilters.smart_folder = "windows_server";
        } else if (match[2] === "clientpc") {
          nextFilters.smart_folder = "windows_workstation";
        }
      }
    }
    setFilters(nextFilters);
  };

  const handleSearch = (value: string) => {
    setSearchQuery(value);
  };

  const handleFilterChange = (key: keyof DeviceFilters, value: string | boolean | undefined) => {
    let nextValue: string | number | boolean | undefined;
    if (typeof value === "boolean" || value === undefined) {
      nextValue = value;
    } else if (value === "all") {
      nextValue = undefined;
    } else if (key === "client_id" || key === "group_id") {
      nextValue = Number(value);
    } else {
      nextValue = value;
    }
    setFilters((prev) => ({
      ...prev,
      [key]: nextValue,
      ...(key === "client_id" ? { group_id: undefined } : {}),
    }));
  };

  const handleRefresh = async () => {
    await Promise.all([refreshBoth(), loadOrgData()]);
  };

  const handleDeviceUpdated = (updated: Device) => {
    const upsert = (items: Device[]) => {
      const exists = items.some((item) => item.id === updated.id);
      return exists
        ? items.map((item) => (item.id === updated.id ? updated : item))
        : [updated, ...items];
    };
    setAllDevices(upsert);
    setDevices((items) => {
      const nextItems = upsert(items);
      return nextItems.filter(deviceMatchesCurrentView);
    });
  };

  const handleDeviceDelete = async (device: Device) => {
    await deleteDevice(device.id, true);
    setAllDevices((items) => items.filter((item) => item.id !== device.id));
    setDevices((items) => items.filter((item) => item.id !== device.id));
    if (drawerDeviceId === device.id) {
      closeDrawer();
    }
    await loadSnapshot();
  };

  const handleDeviceArchive = async (device: Device) => {
    const updated = await archiveDevice(device.id);
    setAllDevices((items) => items.map((item) => (item.id === device.id ? updated : item)).filter((item) => filters.lifecycle_state === "all" || filters.lifecycle_state === "archived" || !item.is_archived));
    setDevices((items) => items.map((item) => (item.id === device.id ? updated : item)).filter((item) => filters.lifecycle_state === "all" || filters.lifecycle_state === "archived" || !item.is_archived));
    if (drawerDeviceId === device.id && filters.lifecycle_state !== "all" && filters.lifecycle_state !== "archived") {
      closeDrawer();
    }
    await loadSnapshot();
  };

  const handleDeviceRestore = async (device: Device) => {
    const updated = await restoreDevice(device.id);
    // allDevices holds only active devices; the restored device was absent (archived),
    // so add it now that it is active again.
    setAllDevices((items) => {
      const exists = items.some((item) => item.id === device.id);
      return exists
        ? items.map((item) => (item.id === device.id ? updated : item))
        : [...items, updated];
    });
    // In the archived view the restored device should disappear from the list;
    // in any other view update it in place.
    setDevices((items) =>
      filters.lifecycle_state === "archived"
        ? items.filter((item) => item.id !== device.id)
        : items.map((item) => (item.id === device.id ? updated : item))
    );
    if (drawerDeviceId === device.id && filters.lifecycle_state === "archived") {
      closeDrawer();
    }
    await loadSnapshot();
  };

  const alertsMap = useMemo(() => {
    const map: Record<number, { critical: number; warning: number }> = {};
    for (const alert of alerts) {
      if (!map[alert.device_id]) map[alert.device_id] = { critical: 0, warning: 0 };
      if (alert.severity === "critical") map[alert.device_id].critical++;
      else if (alert.severity === "warning") map[alert.device_id].warning++;
    }
    return map;
  }, [alerts]);

  const fleetQuickCounts = useMemo(() => {
    let critical = 0;
    let warnings = 0;
    let updates = 0;
    let reboot = 0;
    let lowHealth = 0;
    for (const device of allDevices) {
      const health = healthMap[device.id];
      const patch = patchMap[device.id];
      if (health?.health_state === "critical") critical++;
      if (health?.health_state === "warning") warnings++;
      if (patch?.patch_state === "updates_available") updates++;
      if (patch?.patch_state === "reboot_required") reboot++;
      if ((health?.health_score ?? 100) < 60) lowHealth++;
    }
    return { critical, warnings, updates, reboot, lowHealth };
  }, [allDevices, healthMap, patchMap]);

  const visibleDevices = useMemo(() => {
    const cutoff = Date.now() - hideOfflineDays * 24 * 60 * 60 * 1000;
    return devices.filter((device) => {
      if (!hideOldOffline) return true;
      if (device.freshness_state !== "offline") return true;
      if (!device.last_seen) return false;
      return new Date(device.last_seen).getTime() >= cutoff;
    });
  }, [devices, hideOldOffline, hideOfflineDays]);

  const treeDevices = useMemo(() => {
    const cutoff = Date.now() - hideOfflineDays * 24 * 60 * 60 * 1000;
    return allDevices.filter((device) => {
      if (!hideOldOffline) return true;
      if (device.freshness_state !== "offline") return true;
      if (!device.last_seen) return false;
      return new Date(device.last_seen).getTime() >= cutoff;
    });
  }, [allDevices, hideOldOffline, hideOfflineDays]);

  return (
    <section className="premium-page devices-premium min-w-0 space-y-5">
      <div className="premium-card overflow-hidden p-5 md:p-6">
        <div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <p className="premium-kicker">TECHI Devices Hub</p>
            <h1 className="mt-1.5 text-3xl font-semibold text-white md:text-4xl">
              Remote device <span className="premium-accent-text">management</span>
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-400">
              Inspect endpoint posture, filter client fleets, and launch TECHI Remote Support connections.
            </p>
          </div>
          <div className="flex flex-none flex-wrap items-center gap-2">
            <NotificationCenter
              alerts={alerts}
              totalOpen={alertCount.total_open}
              onDeviceJump={jumpToDevice}
            />
            <Button onClick={handleRefresh} size="sm">
              <RefreshCcw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>
        </div>

        {/* Operational status strip */}
        <div className="op-strip">
          <span className={`op-pill ${wsStatus === "connected" ? "op-pill-ok" : wsStatus === "fallback" ? "op-pill-warn" : "op-pill-err"}`}>
            <span className="op-dot" />
            {wsStatus === "connected" ? "WS Connected" : wsStatus === "fallback" ? "WS Fallback" : "WS Offline"}
          </span>
          <span className="op-pill op-pill-ok">
            <span className="op-dot" />
            Backend Healthy
          </span>
          <span className="op-pill op-pill-neutral">
            <span className="op-dot" />
            Agent Active
          </span>
          {alertCount.total_open > 0 && (
            <span className={`op-pill ${(alertCount.by_severity["critical"] ?? 0) > 0 ? "op-pill-err" : "op-pill-warn"}`}>
              <span className="op-dot" />
              {alertCount.total_open} Active {alertCount.total_open === 1 ? "Alert" : "Alerts"}
            </span>
          )}
          <span className="op-pill op-pill-neutral ml-auto">
            {visibleDevices.length} devices shown
          </span>
        </div>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[248px_minmax(0,1fr)]">
        <div className="min-w-0">
          <DeviceTree
            selectedKey={selectedTreeKey}
            onSelect={handleTreeSelect}
            devices={treeDevices}
            clients={clients}
            groups={groups}
            treeCounts={treeCounts}
            onRefreshCounts={() => void loadSnapshot()}
          />
        </div>

        <div className="min-w-0 space-y-4">
          <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {/* Total */}
            <button
              type="button"
              onClick={() => handleQuickFilterChange("all")}
              className="premium-metric p-5 text-left transition-all hover:opacity-90"
              style={
                quickFilter === "all"
                  ? { outline: "2px solid rgba(249,115,22,0.45)", outlineOffset: "-2px" }
                  : undefined
              }
            >
              <div className="flex items-center justify-between">
                <p className="premium-kicker">Total</p>
                <Radio className="h-4 w-4 text-orange-400/70" />
              </div>
              <p className="mt-3 text-3xl font-bold text-white">{snapshotStats.total}</p>
              <p className="mt-2 text-[13px] text-slate-400">Scoped fleet snapshot</p>
            </button>

            {/* Online */}
            <button
              type="button"
              onClick={() => handleQuickFilterChange(quickFilter === "online" ? "all" : "online")}
              className="premium-metric metric-online p-5 text-left transition-all hover:opacity-90"
              style={
                quickFilter === "online"
                  ? { outline: "2px solid rgba(52,211,153,0.45)", outlineOffset: "-2px" }
                  : undefined
              }
            >
              <div className="flex items-center justify-between">
                <p className="premium-kicker">Online</p>
                <Wifi className="h-4 w-4 text-emerald-400/70" />
              </div>
              <p className="mt-3 text-3xl font-bold text-emerald-300">{snapshotStats.online}</p>
              <p className="mt-2 text-[13px] text-slate-400">Active endpoints available</p>
            </button>

            {/* Stale */}
            <button
              type="button"
              onClick={() => handleQuickFilterChange(quickFilter === "stale" ? "all" : "stale")}
              className="premium-metric metric-warning p-5 text-left transition-all hover:opacity-90"
              style={
                quickFilter === "stale"
                  ? { outline: "2px solid rgba(251,191,36,0.45)", outlineOffset: "-2px" }
                  : undefined
              }
            >
              <div className="flex items-center justify-between">
                <p className="premium-kicker">Stale</p>
                <Clock3 className="h-4 w-4 text-amber-400/80" />
              </div>
              <p className="mt-3 text-3xl font-bold text-amber-200">{snapshotStats.stale}</p>
              <p className="mt-2 text-[13px] text-slate-400">Last seen within 15 minutes</p>
            </button>

            {/* Offline */}
            <button
              type="button"
              onClick={() => handleQuickFilterChange(quickFilter === "offline" ? "all" : "offline")}
              className="premium-metric metric-offline p-5 text-left transition-all hover:opacity-90"
              style={
                quickFilter === "offline"
                  ? { outline: "2px solid rgba(148,163,184,0.45)", outlineOffset: "-2px" }
                  : undefined
              }
            >
              <div className="flex items-center justify-between">
                <p className="premium-kicker">Offline</p>
                <WifiOff className="h-4 w-4 text-slate-500" />
              </div>
              <p className="mt-3 text-3xl font-bold text-slate-200">{snapshotStats.offline}</p>
              <p className="mt-2 text-[13px] text-slate-400">Devices not responding</p>
            </button>
          </div>

          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            {/* Critical health */}
            <button
              type="button"
              onClick={() => handleQuickFilterChange(quickFilter === "critical" ? "all" : "critical")}
              className="premium-metric metric-critical p-5 text-left transition-all hover:opacity-90"
              style={
                quickFilter === "critical"
                  ? { outline: "2px solid rgba(248,113,113,0.45)", outlineOffset: "-2px" }
                  : undefined
              }
            >
              <div className="flex items-center justify-between">
                <p className="premium-kicker">Critical</p>
                <ShieldAlert className="h-4 w-4 text-red-400/80" />
              </div>
              <p className="mt-3 text-3xl font-bold text-red-300">
                {fleetQuickCounts.critical}
              </p>
              <p className="mt-2 text-[13px] text-slate-400">Critical device health</p>
            </button>

            {/* Warnings */}
            <button
              type="button"
              onClick={() => handleQuickFilterChange(quickFilter === "warnings" ? "all" : "warnings")}
              className="premium-metric metric-warning p-5 text-left transition-all hover:opacity-90"
              style={
                quickFilter === "warnings"
                  ? { outline: "2px solid rgba(251,191,36,0.45)", outlineOffset: "-2px" }
                  : undefined
              }
            >
              <div className="flex items-center justify-between">
                <p className="premium-kicker">Warnings</p>
                <AlertTriangle className="h-4 w-4 text-amber-400/80" />
              </div>
              <p className="mt-3 text-3xl font-bold text-amber-200">
                {fleetQuickCounts.warnings}
              </p>
              <p className="mt-2 text-[13px] text-slate-400">Warning device health</p>
            </button>
          </div>

          <div className="premium-card-soft flex flex-col gap-3 p-4 text-sm font-medium text-slate-200 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-orange-300" />
              <span>Native TECHI Remote Support connect action is preserved as a future desktop-launch workflow.</span>
            </div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.06em] text-slate-400">
              <Server className="h-4 w-4" />
              <span>Managed fleet</span>
            </div>
          </div>

          <div className="premium-card-soft flex flex-col gap-3 p-4 text-sm font-medium text-slate-200 lg:flex-row lg:items-center lg:justify-between">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={hideOldOffline}
                onChange={(event) => setHideOldOffline(event.target.checked)}
                className="h-4 w-4 rounded border-white/15 bg-slate-950 accent-orange-500"
              />
              <span>Hide offline devices older than</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={365}
                value={hideOfflineDays}
                onChange={(event) => setHideOfflineDays(Math.max(1, Number(event.target.value) || 1))}
                className="w-20 rounded-lg border border-white/[0.1] bg-slate-900/70 px-3 py-2 text-[13px] font-semibold text-white focus:border-techi-orange/50 focus:outline-none"
              />
              <span className="text-[13px] text-slate-400">days</span>
            </div>
          </div>

          <DevicesTable
            devices={visibleDevices}
            loading={loading}
            error={error}
            filters={filters}
            searchQuery={searchQuery}
            onSearch={handleSearch}
            onFilterChange={handleFilterChange}
            onRefresh={handleRefresh}
            onDeviceSelect={openDrawer}
            onDeviceDelete={handleDeviceDelete}
            onDeviceArchive={handleDeviceArchive}
            onDeviceRestore={handleDeviceRestore}
            healthMap={healthMap}
	            patchMap={patchMap}
	            activeActionMap={activeActionMap}
	            alertsMap={alertsMap}
	            canOperate={can("operator")}
	            canDelete={can("admin")}
	            currentUser={user?.display_name ?? user?.username}
	            onBulkComplete={handleRefresh}
	            favorites={favorites}
	            onToggleFavorite={toggleFavorite}
	            quickFilter={quickFilter}
	            onQuickFilterChange={handleQuickFilterChange}
	            scopedDeviceCount={snapshotStats.total}
	          />
        </div>
      </div>

      {drawerDevice && (
        <DeviceDrawer
          device={drawerDevice}
          isOpen={drawerOpen}
          onClose={closeDrawer}
          wsStatus={wsStatus}
          latestEvent={latestEvent}
          clients={clients}
          groups={groups}
	          onDeviceUpdated={handleDeviceUpdated}
	          canOperate={can("operator")}
	          isFavorite={drawerDevice ? favorites.has(drawerDevice.id) : false}
	          onToggleFavorite={toggleFavorite}
	        />
      )}
    </section>
  );
}
