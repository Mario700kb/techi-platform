import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Clock3, Radio, RefreshCcw, Server, ShieldAlert, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { Client, DeviceGroup, getClients, getGroups } from "../api/clients";
import { archiveDevice, deleteDevice, getDevices, getDevicesSummary, getDeviceTree, restoreDevice, Device, DeviceFilters, DeviceStats } from "../api/devices";
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
import { appCache, CACHE_KEYS, CACHE_TTL, deviceTableCacheKey } from "../store/appCache";

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

interface DevicesSnapshotCache {
  allDevices: Device[];
  stats: DeviceStats;
  treeCounts: { total: number; unassigned: number; byClient: Record<number, number> };
  healthMap: Record<number, DeviceHealthSummary>;
  patchMap: Record<number, PatchStatus>;
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

// Map quick filter pills to backend API params where possible.
// Health-based pills (critical, warnings, etc.) remain client-side in DevicesTable.
function quickFilterToApiFilters(qf: QuickFilter): Partial<DeviceFilters> {
  switch (qf) {
    case "online": return { freshness_state: "online" };
    case "stale": return { freshness_state: "stale" };
    case "offline": return { freshness_state: "offline" };
    case "servers": return { smart_folder: "windows_server" };
    case "workstations": return { smart_folder: "windows_workstation" };
    case "maintenance": return { maintenance_state: "maintenance" };
    default: return {};
  }
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

  // Pagination from URL
  const tablePage = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const tableLimit = (() => {
    const v = parseInt(searchParams.get("limit") || "20", 10);
    return [10, 20, 50].includes(v) ? v : 20;
  })();

  const handleQuickFilterChange = useCallback((f: QuickFilter) => {
    const next = new URLSearchParams(searchParams);
    if (f === "all") next.delete("filter");
    else next.set("filter", f);
    next.delete("page");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // tableDevices: the current page from the API (seed from cache for instant navigation)
  const [tableDevices, setTableDevices] = useState<Device[]>(() => {
    const k = deviceTableCacheKey(tablePage, tableLimit, searchParams.get("q") || "", quickFilter, {});
    return appCache.peek<{ devices: Device[]; total: number }>(k)?.devices ?? [];
  });
  const [tableTotal, setTableTotal] = useState<number>(() => {
    const k = deviceTableCacheKey(tablePage, tableLimit, searchParams.get("q") || "", quickFilter, {});
    return appCache.peek<{ devices: Device[]; total: number }>(k)?.total ?? 0;
  });
  const [tableLoading, setTableLoading] = useState<boolean>(() => {
    const k = deviceTableCacheKey(tablePage, tableLimit, searchParams.get("q") || "", quickFilter, {});
    return appCache.get(k, CACHE_TTL.devicesTable) === null && appCache.peek(k) === null;
  });

  // allDevices: full snapshot from summary (used for stats, health, patches, tree, drawer)
  const [allDevices, setAllDevices] = useState<Device[]>(() =>
    appCache.peek<DevicesSnapshotCache>(CACHE_KEYS.devicesStats)?.allDevices ?? []
  );
  const [clients, setClients] = useState<Client[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [filters, setFilters] = useState<DeviceFilters>({});

  // Two-tier search: immediate (input display) vs. debounced (API trigger)
  const [searchQuery, setSearchQuery] = useState(searchParams.get("q") || "");
  const [debouncedSearch, setDebouncedSearch] = useState(searchParams.get("q") || "");
  const searchTimerRef = useRef<number | undefined>();

  const [selectedTreeKey, setSelectedTreeKey] = useState("all");
  const [hideOldOffline, setHideOldOffline] = useState(false);
  const [hideOfflineDays, setHideOfflineDays] = useState(30);
  // snapshotLoading: true while getDevicesSummary() is in flight (stats cards, health, patches).
  // Does NOT block the table — table skeleton is driven by tableLoading only.
  const [snapshotLoading, setSnapshotLoading] = useState<boolean>(() =>
    appCache.peek(CACHE_KEYS.devicesStats) === null
  );
  const [error, setError] = useState<string | null>(null);
  const devicesLoadedRef = useRef(false);
  const refreshTimerRef = useRef<number | undefined>();

  // Stable refs for WS callbacks (avoids stale closures)
  const allDevicesRef = useRef<Device[]>([]);
  const tableDevicesRef = useRef<Device[]>([]);
  allDevicesRef.current = allDevices;
  tableDevicesRef.current = tableDevices;

  const [drawerDeviceId, setDrawerDeviceId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerCloseTimerRef = useRef<number | undefined>();
  const [latestEvent, setLatestEvent] = useState<DeviceRealtimeEvent | null>(null);
  const [treeCounts, setTreeCounts] = useState<TreeCounts>(() => {
    const snap = appCache.peek<DevicesSnapshotCache>(CACHE_KEYS.devicesStats);
    if (!snap) return computeTreeCounts([]);
    return {
      total: snap.treeCounts.total,
      unassigned: snap.treeCounts.unassigned,
      byClient: new Map(Object.entries(snap.treeCounts.byClient).map(([k, v]) => [Number(k), v])),
    };
  });
  const [snapshotStats, setSnapshotStats] = useState<DeviceStats>(() =>
    appCache.peek<DevicesSnapshotCache>(CACHE_KEYS.devicesStats)?.stats ?? { total: 0, online: 0, stale: 0, offline: 0 }
  );
  const [healthMap, setHealthMap] = useState<Record<number, DeviceHealthSummary>>(() =>
    appCache.peek<DevicesSnapshotCache>(CACHE_KEYS.devicesStats)?.healthMap ?? {}
  );
  const [patchMap, setPatchMap] = useState<Record<number, PatchStatus>>(() =>
    appCache.peek<DevicesSnapshotCache>(CACHE_KEYS.devicesStats)?.patchMap ?? {}
  );
  const [activeActionMap, setActiveActionMap] = useState<Record<number, ActiveActionEntry>>({});

  // Drawer lookup: prefer allDevices (full snapshot), fall back to current page
  const drawerDevice = useMemo(
    () =>
      drawerDeviceId != null
        ? (allDevices.find((d) => d.id === drawerDeviceId) ??
           tableDevices.find((d) => d.id === drawerDeviceId) ??
           null)
        : null,
    [drawerDeviceId, allDevices, tableDevices]
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

  // loadSnapshot loads the full summary for stats/health/patch cards.
  // The table data comes separately from loadTableData.
  const loadSnapshot = useCallback(async () => {
    // Fresh cache → instant, skip fetch
    const fresh = appCache.get<DevicesSnapshotCache>(CACHE_KEYS.devicesStats, CACHE_TTL.devicesStats);
    if (fresh) {
      setAllDevices(fresh.allDevices);
      setSnapshotStats(fresh.stats);
      setTreeCounts({
        total: fresh.treeCounts.total,
        unassigned: fresh.treeCounts.unassigned,
        byClient: new Map(Object.entries(fresh.treeCounts.byClient).map(([k, v]) => [Number(k), v])),
      });
      setHealthMap(fresh.healthMap);
      setPatchMap(fresh.patchMap);
      setSnapshotLoading(false);
      devicesLoadedRef.current = true;
      return;
    }
    // Stale cache → show immediately, then revalidate in background
    const stale = appCache.peek<DevicesSnapshotCache>(CACHE_KEYS.devicesStats);
    if (stale) {
      setAllDevices(stale.allDevices);
      setSnapshotStats(stale.stats);
      setTreeCounts({
        total: stale.treeCounts.total,
        unassigned: stale.treeCounts.unassigned,
        byClient: new Map(Object.entries(stale.treeCounts.byClient).map(([k, v]) => [Number(k), v])),
      });
      setHealthMap(stale.healthMap);
      setPatchMap(stale.patchMap);
      setSnapshotLoading(false);
      devicesLoadedRef.current = true;
    }

    try {
      setError(null);

      const treePromise = getDeviceTree().then((tree) => {
        setTreeCounts({
          total: tree.total,
          unassigned: tree.unassigned,
          byClient: new Map(Object.entries(tree.by_client).map(([id, count]) => [Number(id), count])),
        });
      }).catch(() => undefined);

      const snapshotPromise = getDevicesSummary().then((snapshot) => {
        const sorted = [...snapshot.devices].sort((a, b) => (a.hostname ?? "").localeCompare(b.hostname ?? ""));
        const newHealthMap = Object.fromEntries(snapshot.health.map((item) => [item.device_id, item]));
        const newPatchMap = Object.fromEntries(snapshot.patches.map((item) => [item.device_id, item]));
        const newTreeCounts = {
          total: snapshot.tree_counts.total,
          unassigned: snapshot.tree_counts.unassigned,
          byClient: Object.fromEntries(
            Object.entries(snapshot.tree_counts.by_client).map(([id, count]) => [Number(id), count])
          ),
        };
        setAllDevices(sorted);
        setSnapshotStats(snapshot.stats);
        setTreeCounts({
          ...newTreeCounts,
          byClient: new Map(Object.entries(newTreeCounts.byClient).map(([k, v]) => [Number(k), v])),
        });
        setHealthMap(newHealthMap);
        setPatchMap(newPatchMap);
        devicesLoadedRef.current = true;
        appCache.set(CACHE_KEYS.devicesStats, {
          allDevices: sorted,
          stats: snapshot.stats,
          treeCounts: newTreeCounts,
          healthMap: newHealthMap,
          patchMap: newPatchMap,
        });
      });

      await Promise.all([treePromise, snapshotPromise]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load devices");
    } finally {
      setSnapshotLoading(false);
    }
  }, []);

  // loadTableData fetches the paginated table data from the API (stale-while-revalidate cache)
  const loadTableData = useCallback(async () => {
    const cacheKey = deviceTableCacheKey(
      tablePage, tableLimit, debouncedSearch, quickFilter,
      filters as Record<string, unknown>,
    );

    // Fresh cache → instant, no fetch
    const fresh = appCache.get<{ devices: Device[]; total: number }>(cacheKey, CACHE_TTL.devicesTable);
    if (fresh) {
      setTableDevices(fresh.devices);
      setTableTotal(fresh.total);
      setTableLoading(false);
      return;
    }

    // Stale cache → show stale immediately, revalidate silently in background
    const stale = appCache.peek<{ devices: Device[]; total: number }>(cacheKey);
    if (stale) {
      setTableDevices(stale.devices);
      setTableTotal(stale.total);
      setTableLoading(false);
      try {
        const skip = (tablePage - 1) * tableLimit;
        const qfExtra = quickFilterToApiFilters(quickFilter);
        const apiFilters: DeviceFilters = { ...filters, ...qfExtra };
        if (debouncedSearch) apiFilters.search = debouncedSearch;
        const result = await getDevices(apiFilters, skip, tableLimit);
        setTableDevices(result.devices);
        setTableTotal(result.total);
        appCache.set(cacheKey, { devices: result.devices, total: result.total });
      } catch { /* keep stale data on background refresh failure */ }
      return;
    }

    // No cache → fetch with skeleton
    setTableLoading(true);
    try {
      const skip = (tablePage - 1) * tableLimit;
      const qfExtra = quickFilterToApiFilters(quickFilter);
      const apiFilters: DeviceFilters = { ...filters, ...qfExtra };
      if (debouncedSearch) apiFilters.search = debouncedSearch;
      const result = await getDevices(apiFilters, skip, tableLimit);
      setTableDevices(result.devices);
      setTableTotal(result.total);
      appCache.set(cacheKey, { devices: result.devices, total: result.total });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load devices");
    } finally {
      setTableLoading(false);
    }
  }, [tablePage, tableLimit, quickFilter, filters, debouncedSearch]);

  const loadOrgData = useCallback(async () => {
    try {
      const [clientData, groupData] = await Promise.all([getClients(), getGroups()]);
      setClients(clientData);
      setGroups(groupData);
    } catch {
      // organization metadata is optional for device refresh
    }
  }, []);

  const refreshBoth = useCallback(async () => {
    await Promise.all([loadSnapshot(), loadTableData()]);
  }, [loadSnapshot, loadTableData]);

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

      const foundInAll = allDevicesRef.current.some((d) => d.id === eventDevice.id);
      const foundInTable = tableDevicesRef.current.some((d) => d.id === eventDevice.id);

      setAllDevices((items) => applyPatch(items).nextItems);
      // In-place patch for the current page only (no add/remove — pagination handles that)
      setTableDevices((items) => applyPatch(items).nextItems);

      return foundInAll || foundInTable;
    },
    []
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

  usePollingRefresh(refreshBoth, {
    intervalMs: 60000,
    enabled: wsStatus !== "connected",
    immediate: false,
  });

  // Initial load
  useEffect(() => {
    void loadSnapshot();
  }, []);

  // Load/reload paginated table whenever page, limit, filter, quick filter, or debounced search changes
  useEffect(() => {
    void loadTableData();
  }, [loadTableData]);

  useEffect(() => {
    return () => {
      window.clearTimeout(refreshTimerRef.current);
      window.clearTimeout(drawerCloseTimerRef.current);
      window.clearTimeout(searchTimerRef.current);
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
    // Reset to page 1 when tree selection changes
    const next = new URLSearchParams(searchParams);
    next.delete("page");
    setSearchParams(next, { replace: true });
  };

  const handleSearch = useCallback((value: string) => {
    setSearchQuery(value);
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      setDebouncedSearch(value);
      const next = new URLSearchParams(searchParams);
      if (value) next.set("q", value); else next.delete("q");
      next.delete("page");
      setSearchParams(next, { replace: true });
    }, 300);
  }, [searchParams, setSearchParams]);

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
    // Reset to page 1 when filter changes
    const next = new URLSearchParams(searchParams);
    next.delete("page");
    setSearchParams(next, { replace: true });
  };

  const handlePageChange = useCallback((page: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(page));
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const handleLimitChange = useCallback((limit: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("limit", String(limit));
    next.delete("page");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const handleRefresh = async () => {
    appCache.invalidatePrefix("devices-table");
    appCache.invalidate(CACHE_KEYS.devicesStats);
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
    setTableDevices(upsert);
  };

  const handleDeviceDelete = async (device: Device) => {
    await deleteDevice(device.id, true);
    setAllDevices((items) => items.filter((item) => item.id !== device.id));
    setTableDevices((items) => items.filter((item) => item.id !== device.id));
    if (drawerDeviceId === device.id) {
      closeDrawer();
    }
    await refreshBoth();
  };

  const handleDeviceArchive = async (device: Device) => {
    const updated = await archiveDevice(device.id);
    setAllDevices((items) => items.map((item) => (item.id === device.id ? updated : item)).filter((item) => filters.lifecycle_state === "all" || filters.lifecycle_state === "archived" || !item.is_archived));
    setTableDevices((items) => items.map((item) => (item.id === device.id ? updated : item)).filter((item) => filters.lifecycle_state === "all" || filters.lifecycle_state === "archived" || !item.is_archived));
    if (drawerDeviceId === device.id && filters.lifecycle_state !== "all" && filters.lifecycle_state !== "archived") {
      closeDrawer();
    }
    await refreshBoth();
  };

  const handleDeviceRestore = async (device: Device) => {
    const updated = await restoreDevice(device.id);
    setAllDevices((items) => {
      const exists = items.some((item) => item.id === device.id);
      return exists
        ? items.map((item) => (item.id === device.id ? updated : item))
        : [...items, updated];
    });
    setTableDevices((items) =>
      filters.lifecycle_state === "archived"
        ? items.filter((item) => item.id !== device.id)
        : items.map((item) => (item.id === device.id ? updated : item))
    );
    if (drawerDeviceId === device.id && filters.lifecycle_state === "archived") {
      closeDrawer();
    }
    await refreshBoth();
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
    return tableDevices.filter((device) => {
      if (!hideOldOffline) return true;
      if (device.freshness_state !== "offline") return true;
      if (!device.last_seen) return false;
      return new Date(device.last_seen).getTime() >= cutoff;
    });
  }, [tableDevices, hideOldOffline, hideOfflineDays]);

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
            {tableTotal > 0 ? `${tableTotal} devices` : `${visibleDevices.length} devices`}
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
              <p className="mt-3 text-3xl font-bold text-white">
                {snapshotLoading ? <span className="inline-block h-8 w-12 animate-pulse rounded bg-slate-700/60" /> : snapshotStats.total}
              </p>
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
              <p className="mt-3 text-3xl font-bold text-emerald-300">
                {snapshotLoading ? <span className="inline-block h-8 w-12 animate-pulse rounded bg-slate-700/60" /> : snapshotStats.online}
              </p>
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
              <p className="mt-3 text-3xl font-bold text-amber-200">
                {snapshotLoading ? <span className="inline-block h-8 w-12 animate-pulse rounded bg-slate-700/60" /> : snapshotStats.stale}
              </p>
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
              <p className="mt-3 text-3xl font-bold text-slate-200">
                {snapshotLoading ? <span className="inline-block h-8 w-12 animate-pulse rounded bg-slate-700/60" /> : snapshotStats.offline}
              </p>
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
                {snapshotLoading ? <span className="inline-block h-8 w-12 animate-pulse rounded bg-slate-700/60" /> : fleetQuickCounts.critical}
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
                {snapshotLoading ? <span className="inline-block h-8 w-12 animate-pulse rounded bg-slate-700/60" /> : fleetQuickCounts.warnings}
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
                aria-label="Days offline before hiding"
                value={hideOfflineDays}
                onChange={(event) => setHideOfflineDays(Math.max(1, Number(event.target.value) || 1))}
                className="w-20 rounded-lg border border-white/[0.1] bg-slate-900/70 px-3 py-2 text-[13px] font-semibold text-white focus:border-techi-orange/50 focus:outline-none"
              />
              <span className="text-[13px] text-slate-400">days</span>
            </div>
          </div>

          <DevicesTable
            devices={visibleDevices}
            loading={tableLoading && tableDevices.length === 0}
            tableLoading={tableLoading}
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
            page={tablePage}
            limit={tableLimit}
            total={tableTotal}
            onPageChange={handlePageChange}
            onLimitChange={handleLimitChange}
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
