import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deviceDisplayName } from "../utils/deviceLabel";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, Clock3, Radio, RefreshCcw, Server, ShieldAlert, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { Client, DeviceGroup, getClients, getGroups } from "../api/clients";
import {
  archiveDevice,
  deleteDevice,
  getDevices,
  getDeviceTableDetails,
  restoreDevice,
  Device,
  DeviceFilters,
} from "../api/devices";
import { PatchStatus } from "../api/inventory";
import DeviceDrawer from "../components/DeviceDrawer";
import GenericDeviceDrawer from "../components/GenericDeviceDrawer";
import DeviceTree from "../components/DeviceTree";
import { usePlatformFeatures } from "../hooks/usePlatformFeatures";
import DevicesTable, { type ActiveActionEntry, type QuickFilter } from "../components/DevicesTable";
import NotificationCenter from "../components/NotificationCenter";
import { Button } from "../components/ui";
import { useFavorites } from "../hooks/useFavorites";
import { usePollingRefresh } from "../hooks/usePollingRefresh";
import { useAuth } from "../auth/AuthContext";
import { useAppData } from "../contexts/AppDataContext";
import { isActiveStatus } from "../api/actions";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";
import { DeviceHealthSummary } from "../types/telemetry";
import { appCache, CACHE_TTL, deviceTableCacheKey } from "../store/appCache";
import { parseUTC } from "../utils/time";

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
  byClientCategory: Map<number, Map<string, number>>;
  // Platform Expansion: clientId → category → platform → count.
  byClientCategoryPlatform: Map<number, Map<string, Map<string, number>>>;
}

function computeTreeCounts(devices: Device[]): TreeCounts {
  const byClient = new Map<number, number>();
  let unassigned = 0;
  for (const d of devices) {
    const cid = d.resolved_client_id ?? d.client_id ?? null;
    if (cid === null) unassigned++;
    else byClient.set(cid, (byClient.get(cid) ?? 0) + 1);
  }
  return { total: devices.length, unassigned, byClient, byClientCategory: new Map(), byClientCategoryPlatform: new Map() };
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
    case "needs_agent_update": return { agent_update_state: "outdated" };
    default: return {};
  }
}

export default function Devices() {
  const { can, user } = useAuth();
  const platformFeatures = usePlatformFeatures();
  const {
    fleetOverview,
    fleetOverviewLoading,
    latestEvent,
    realtimeStatus,
    refreshFleetOverview,
    alerts,
    alertCount,
  } = useAppData();
  const { favorites, toggle: toggleFavorite } = useFavorites();
  const [searchParams, setSearchParams] = useSearchParams();
  const validQuickFilters = new Set<QuickFilter>([
    "all", "online", "stale", "offline", "servers", "workstations", "needs_updates",
    "reboot_required", "warnings", "critical", "healthy", "maintenance",
    "needs_attention", "low_health", "rustdesk_issues", "needs_agent_update", "favorites",
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
    // Functional updater (not a `next` built from the closed-over
    // `searchParams`): Mobile UI 2.0's FilterSheet Apply calls this
    // together with handleFilterChange in the same synchronous handler,
    // and two `setSearchParams(next, ...)` calls built from the same
    // stale snapshot would otherwise clobber each other (the second call
    // silently drops the first's change — confirmed while wiring
    // FilterSheet v2's Apply button).
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (f === "all") next.delete("filter");
      else next.set("filter", f);
      next.delete("page");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

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

  const [clients, setClients] = useState<Client[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [filters, setFilters] = useState<DeviceFilters>({});

  // Two-tier search: immediate (input display) vs. debounced (API trigger)
  const [searchQuery, setSearchQuery] = useState(searchParams.get("q") || "");
  const [debouncedSearch, setDebouncedSearch] = useState(searchParams.get("q") || "");
  const searchTimerRef = useRef<number | undefined>();
  const treeSelectTimerRef = useRef<number | undefined>();

  const [selectedTreeKey, setSelectedTreeKey] = useState("all");
  const [hideOldOffline, setHideOldOffline] = useState(false);
  const [hideOfflineDays, setHideOfflineDays] = useState(30);
  const snapshotLoading = fleetOverviewLoading && fleetOverview === null;
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<number | undefined>();

  // Stable refs for WS callbacks (avoids stale closures)
  const tableDevicesRef = useRef<Device[]>([]);
  const detailsRequestRef = useRef(0);
  // In-flight device list request: aborted when a new one starts, and
  // its cache key is checked on resolve so a stale response (from a
  // selection the user already navigated away from) never overwrites state.
  const tableAbortRef = useRef<AbortController | null>(null);
  const tableRequestKeyRef = useRef<string>("");
  // Always points at the latest refreshBoth so the one-shot setTimeout in
  // scheduleDevicesRefresh never fires against a stale client_id/folder closure.
  const refreshBothRef = useRef<() => Promise<void>>(async () => {});
  tableDevicesRef.current = tableDevices;

  const [drawerDeviceId, setDrawerDeviceId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerInitialTab, setDrawerInitialTab] = useState<string | undefined>(undefined);
  const drawerCloseTimerRef = useRef<number | undefined>();
  const treeCounts = useMemo<TreeCounts>(() => {
    if (!fleetOverview) return computeTreeCounts([]);
    return {
      total: fleetOverview.tree_counts.total,
      unassigned: fleetOverview.tree_counts.unassigned,
      byClient: new Map(
        Object.entries(fleetOverview.tree_counts.by_client).map(([id, count]) => [Number(id), count]),
      ),
      byClientCategory: new Map(
        Object.entries(fleetOverview.tree_counts.by_client_category ?? {}).map(([clientId, counts]) => [
          Number(clientId),
          new Map(Object.entries(counts)),
        ]),
      ),
      byClientCategoryPlatform: new Map(
        Object.entries(fleetOverview.tree_counts.by_client_category_platform ?? {}).map(([clientId, cats]) => [
          Number(clientId),
          new Map(
            Object.entries(cats).map(([category, plats]) => [category, new Map(Object.entries(plats))]),
          ),
        ]),
      ),
    };
  }, [fleetOverview]);
  const snapshotStats = fleetOverview?.stats ?? { total: 0, online: 0, stale: 0, offline: 0 };
  const [healthMap, setHealthMap] = useState<Record<number, DeviceHealthSummary>>({});
  const [patchMap, setPatchMap] = useState<Record<number, PatchStatus>>({});
  const [activeActionMap, setActiveActionMap] = useState<Record<number, ActiveActionEntry>>({});

  const drawerDevice = useMemo(
    () =>
      drawerDeviceId != null
        ? (tableDevices.find((d) => d.id === drawerDeviceId) ?? null)
        : null,
    [drawerDeviceId, tableDevices]
  );

  const openDrawer = useCallback((device: Device) => {
    window.clearTimeout(drawerCloseTimerRef.current);
    setDrawerInitialTab(undefined);
    setDrawerDeviceId(device.id);
    setDrawerOpen(true);
  }, []);

  // Connect ▸ Embedded Terminal from a Device Catalog row: the terminal
  // lives in the drawer's Terminal tab, so deep-link straight to it (the
  // Connect button itself never opens the drawer).
  // Connect opens the terminal in its own browser window rather than the
  // drawer: a terminal is a long-lived working surface, and an operator needs
  // to keep it open — on a second screen if they like — while still using the
  // catalog. Named per device, so clicking Connect twice focuses the existing
  // window instead of opening a duplicate session.
  const openDeviceTerminal = useCallback((device: Device) => {
    const name = deviceDisplayName(device);
    const url = `/terminal/${device.id}?name=${encodeURIComponent(name)}`;
    const features = "width=1024,height=640,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes";
    const win = window.open(url, `techi-terminal-${device.id}`, features);
    if (win) {
      win.focus();
      return;
    }
    // Popup blocked: fall back to the drawer's Terminal tab so the click still
    // does something rather than silently failing.
    window.clearTimeout(drawerCloseTimerRef.current);
    setDrawerInitialTab("terminal");
    setDrawerDeviceId(device.id);
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    window.clearTimeout(drawerCloseTimerRef.current);
    drawerCloseTimerRef.current = window.setTimeout(() => setDrawerDeviceId(null), 310);
  }, []);

  const jumpToDevice = useCallback((deviceId: number) => {
    const device = tableDevices.find((d) => d.id === deviceId);
    if (device) openDrawer(device);
  }, [tableDevices, openDrawer]);

  // loadTableData fetches the paginated table data from the API (stale-while-revalidate cache)
  const loadTableData = useCallback(async () => {
    const cacheKey = deviceTableCacheKey(
      tablePage, tableLimit, debouncedSearch, quickFilter,
      filters as Record<string, unknown>,
    );
    // Records the selection this call was made for; checked after each
    // await below so a response for an old client_id/folder is discarded.
    tableRequestKeyRef.current = cacheKey;

    const loadDetails = async (devices: Device[]) => {
      const requestId = ++detailsRequestRef.current;
      if (devices.length === 0) {
        setHealthMap({});
        setPatchMap({});
        return;
      }
      try {
        const details = await getDeviceTableDetails(devices.map((device) => device.id));
        if (detailsRequestRef.current !== requestId) return;
        setHealthMap(Object.fromEntries(details.health.map((item) => [item.device_id, item])));
        setPatchMap(Object.fromEntries(details.patches.map((item) => [item.device_id, item])));
      } catch {
        // Optional row details must not block the paginated table.
      }
    };

    // Fresh cache → instant, no fetch
    const fresh = appCache.get<{ devices: Device[]; total: number }>(cacheKey, CACHE_TTL.devicesTable);
    if (fresh) {
      setTableDevices(fresh.devices);
      setTableTotal(fresh.total);
      setTableLoading(false);
      void loadDetails(fresh.devices);
      return;
    }

    // Cancel any in-flight request for a previous selection before starting a new one.
    tableAbortRef.current?.abort();
    const controller = new AbortController();
    tableAbortRef.current = controller;

    // Stale cache → show stale immediately, revalidate silently in background
    const stale = appCache.peek<{ devices: Device[]; total: number }>(cacheKey);
    if (stale) {
      setTableDevices(stale.devices);
      setTableTotal(stale.total);
      setTableLoading(false);
      void loadDetails(stale.devices);
      try {
        const skip = (tablePage - 1) * tableLimit;
        const qfExtra = quickFilterToApiFilters(quickFilter);
        const apiFilters: DeviceFilters = { ...filters, ...qfExtra };
        if (debouncedSearch) apiFilters.search = debouncedSearch;
        const result = await getDevices(apiFilters, skip, tableLimit, controller.signal);
        if (tableRequestKeyRef.current !== cacheKey) return; // selection changed while in flight
        setTableDevices(result.devices);
        setTableTotal(result.total);
        appCache.set(cacheKey, { devices: result.devices, total: result.total });
        void loadDetails(result.devices);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        /* keep stale data on background refresh failure */
      }
      return;
    }

    // No cache → fetch with skeleton
    setTableLoading(true);
    try {
      const skip = (tablePage - 1) * tableLimit;
      const qfExtra = quickFilterToApiFilters(quickFilter);
      const apiFilters: DeviceFilters = { ...filters, ...qfExtra };
      if (debouncedSearch) apiFilters.search = debouncedSearch;
      const result = await getDevices(apiFilters, skip, tableLimit, controller.signal);
      if (tableRequestKeyRef.current !== cacheKey) return; // selection changed while in flight
      setTableDevices(result.devices);
      setTableTotal(result.total);
      appCache.set(cacheKey, { devices: result.devices, total: result.total });
      void loadDetails(result.devices);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to load devices");
    } finally {
      if (tableRequestKeyRef.current === cacheKey) setTableLoading(false);
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
    await Promise.all([refreshFleetOverview(true), loadTableData()]);
  }, [refreshFleetOverview, loadTableData]);
  refreshBothRef.current = refreshBoth;

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

      const foundInTable = tableDevicesRef.current.some((d) => d.id === eventDevice.id);

      // In-place patch for the current page only (no add/remove — pagination handles that)
      setTableDevices((items) => applyPatch(items).nextItems);

      return foundInTable;
    },
    []
  );

  const scheduleDevicesRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      return;
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = undefined;
      // Read via ref so this always targets the current client_id/folder,
      // not the one in scope when this timeout was scheduled 5s ago.
      void refreshBothRef.current();
    }, 5000);
  }, []);

  useEffect(() => {
    void loadOrgData();
  }, [loadOrgData]);

  useEffect(() => {
    const event = latestEvent;
    if (!event || event.type === "connection_ready") {
      return;
    }
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
  }, [latestEvent, mergeDeviceEvent, scheduleDevicesRefresh]);

  usePollingRefresh(refreshBoth, {
    intervalMs: 60000,
    enabled: realtimeStatus !== "connected",
    immediate: false,
  });

  // Load/reload paginated table whenever page, limit, filter, quick filter, or debounced search changes
  useEffect(() => {
    void loadTableData();
  }, [loadTableData]);

  useEffect(() => {
    return () => {
      window.clearTimeout(refreshTimerRef.current);
      window.clearTimeout(drawerCloseTimerRef.current);
      window.clearTimeout(searchTimerRef.current);
      window.clearTimeout(treeSelectTimerRef.current);
    };
  }, []);

  const handleTreeSelect = (key: string) => {
    // Immediate visual feedback; the actual filter/fetch is debounced below
    // so a burst of rapid clicks across the fleet tree only triggers one fetch.
    setSelectedTreeKey(key);
    window.clearTimeout(treeSelectTimerRef.current);
    treeSelectTimerRef.current = window.setTimeout(() => {
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
        const CATS = "servers|clientpc|network|storage|hypervisors|other";
        // Platform sub-folder: client-N-<category>-<platform> (Platform Expansion).
        const platformMatch = key.match(new RegExp(`^client-(\\d+)-(${CATS})-([a-z0-9]+)$`));
        if (platformMatch) {
          // Leaf: cumulative client AND category AND platform. Category uses the
          // SAME classification as the tree counts, so the result matches the
          // sub-folder badge (fixes servers→windows returning the wrong set).
          const [, cid, cat, plat] = platformMatch;
          nextFilters.client_id = Number(cid);
          nextFilters.group_id = undefined;
          nextFilters.category = cat;
          nextFilters.platform = plat;
        } else {
          const match = key.match(new RegExp(`^client-(\\d+)(?:-(${CATS}))?$`));
          if (match) {
            nextFilters.client_id = Number(match[1]);
            nextFilters.group_id = undefined;
            // Parent category node: same category classification as its count.
            if (match[2]) nextFilters.category = match[2];
          }
        }
      }
      setFilters(nextFilters);
      // Reset to page 1 when tree selection changes
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("page");
        return next;
      }, { replace: true });
    }, 200);
  };

  const handleSearch = useCallback((value: string) => {
    setSearchQuery(value);
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      setDebouncedSearch(value);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set("q", value); else next.delete("q");
        next.delete("page");
        return next;
      }, { replace: true });
    }, 300);
  }, [setSearchParams]);

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
    // Functional updater — Mobile UI 2.0's FilterSheet Apply calls
    // onFilterChange twice in a row (client_id, then device_type) together
    // with onQuickFilterChange in the same handler; building `next` from
    // the closed-over `searchParams` would let the later call silently
    // clobber the earlier one's pending update (confirmed while wiring
    // FilterSheet v2's Apply button — the "filter" param was dropped).
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("page");
      return next;
    }, { replace: true });
  };

  const handlePageChange = useCallback((page: number) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("page", String(page));
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const handleLimitChange = useCallback((limit: number) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("limit", String(limit));
      next.delete("page");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const handleRefresh = async () => {
    appCache.invalidatePrefix("devices-table");
    await Promise.all([refreshBoth(), loadOrgData()]);
  };

  const handleDeviceUpdated = (updated: Device) => {
    const upsert = (items: Device[]) => {
      const exists = items.some((item) => item.id === updated.id);
      return exists
        ? items.map((item) => (item.id === updated.id ? updated : item))
        : [updated, ...items];
    };
    setTableDevices(upsert);
  };

  const handleDeviceDelete = async (device: Device) => {
    await deleteDevice(device.id, true);
    setTableDevices((items) => items.filter((item) => item.id !== device.id));
    if (drawerDeviceId === device.id) {
      closeDrawer();
    }
    await refreshBoth();
  };

  const handleDeviceArchive = async (device: Device) => {
    const updated = await archiveDevice(device.id);
    setTableDevices((items) => items.map((item) => (item.id === device.id ? updated : item)).filter((item) => filters.lifecycle_state === "all" || filters.lifecycle_state === "archived" || !item.is_archived));
    if (drawerDeviceId === device.id && filters.lifecycle_state !== "all" && filters.lifecycle_state !== "archived") {
      closeDrawer();
    }
    await refreshBoth();
  };

  const handleDeviceRestore = async (device: Device) => {
    const updated = await restoreDevice(device.id);
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

  // Mobile "Load More" — grows the limit without touching URL-based desktop pagination
  const mobileExtraLimitRef = useRef(0);
  const [mobileLoadingMore, setMobileLoadingMore] = useState(false);

  const handleMobileLoadMore = useCallback(async () => {
    mobileExtraLimitRef.current += 20;
    const effectiveLimit = tableLimit + mobileExtraLimitRef.current;
    setMobileLoadingMore(true);
    try {
      const qfExtra = quickFilterToApiFilters(quickFilter);
      const apiFilters: DeviceFilters = { ...filters, ...qfExtra };
      if (debouncedSearch) apiFilters.search = debouncedSearch;
      const result = await getDevices(apiFilters, 0, effectiveLimit);
      setTableDevices(result.devices);
      setTableTotal(result.total);
    } catch {
      // keep existing data on error
    } finally {
      setMobileLoadingMore(false);
    }
  }, [tableLimit, quickFilter, filters, debouncedSearch]);

  // Reset mobile extra limit when filters/search change
  useEffect(() => {
    mobileExtraLimitRef.current = 0;
  }, [quickFilter, filters, debouncedSearch]);

  const alertsMap = useMemo(() => {
    const map: Record<number, { critical: number; warning: number }> = {};
    for (const alert of alerts) {
      const deviceId = alert.device_id;
      if (deviceId == null) continue; // synthetic token-usage alerts have no device
      if (!map[deviceId]) map[deviceId] = { critical: 0, warning: 0 };
      if (alert.severity === "critical") map[deviceId].critical++;
      else if (alert.severity === "warning") map[deviceId].warning++;
    }
    return map;
  }, [alerts]);

  const visibleDevices = useMemo(() => {
    const cutoff = Date.now() - hideOfflineDays * 24 * 60 * 60 * 1000;
    return tableDevices.filter((device) => {
      if (!hideOldOffline) return true;
      if (device.freshness_state !== "offline") return true;
      if (!device.last_seen) return false;
      return parseUTC(device.last_seen).getTime() >= cutoff;
    });
  }, [tableDevices, hideOldOffline, hideOfflineDays]);

  return (
    <section className="premium-page devices-premium min-w-0 space-y-5">
      {/* Mobile: the screen title lives in MobileTopBar (Mobile UI 2.0);
          the alert count lives in the BottomNav badge. */}

      {/* Desktop header card — hidden on mobile */}
      <div className="hidden md:block premium-card overflow-hidden p-5 md:p-6">
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
          <span className={`op-pill ${realtimeStatus === "connected" ? "op-pill-ok" : realtimeStatus === "fallback" ? "op-pill-warn" : "op-pill-err"}`}>
            <span className="op-dot" />
            {realtimeStatus === "connected" ? "WS Connected" : realtimeStatus === "fallback" ? "WS Fallback" : "WS Offline"}
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
        {/* DeviceTree — desktop only */}
        <div className="hidden md:block min-w-0">
          <DeviceTree
            selectedKey={selectedTreeKey}
            onSelect={handleTreeSelect}
            devices={tableDevices}
            clients={clients}
            groups={groups}
            treeCounts={treeCounts}
            showPlatformFolders={platformFeatures.FEATURE_LINUX}
            onRefreshCounts={() => void refreshFleetOverview(true)}
          />
        </div>

        <div className="min-w-0 space-y-4">
          {/* Stat cards — desktop only */}
          <div className="hidden md:grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {/* Total */}
            <button
              type="button"
              onClick={() => handleQuickFilterChange("all")}
              className="premium-metric p-5 text-left transition-all hover:opacity-90"
              style={
                quickFilter === "all"
                  ? { outline: "2px solid color-mix(in srgb, var(--th-accent) 45%, transparent)", outlineOffset: "-2px" }
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
                  ? { outline: "2px solid color-mix(in srgb, var(--th-status-online) 45%, transparent)", outlineOffset: "-2px" }
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
                  ? { outline: "2px solid color-mix(in srgb, var(--th-status-warning) 45%, transparent)", outlineOffset: "-2px" }
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
                  ? { outline: "2px solid color-mix(in srgb, var(--th-status-offline) 45%, transparent)", outlineOffset: "-2px" }
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

          {/* Health metric cards — desktop only */}
          <div className="hidden md:grid min-w-0 gap-4 sm:grid-cols-2">
            {/* Critical health */}
            <button
              type="button"
              onClick={() => handleQuickFilterChange(quickFilter === "critical" ? "all" : "critical")}
              className="premium-metric metric-critical p-5 text-left transition-all hover:opacity-90"
              style={
                quickFilter === "critical"
                  ? { outline: "2px solid color-mix(in srgb, var(--th-status-critical) 45%, transparent)", outlineOffset: "-2px" }
                  : undefined
              }
            >
              <div className="flex items-center justify-between">
                <p className="premium-kicker">Critical</p>
                <ShieldAlert className="h-4 w-4 text-red-400/80" />
              </div>
              <p className="mt-3 text-3xl font-bold text-red-300">
                {snapshotLoading ? <span className="inline-block h-8 w-12 animate-pulse rounded bg-slate-700/60" /> : (fleetOverview?.critical ?? 0)}
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
                  ? { outline: "2px solid color-mix(in srgb, var(--th-status-warning) 45%, transparent)", outlineOffset: "-2px" }
                  : undefined
              }
            >
              <div className="flex items-center justify-between">
                <p className="premium-kicker">Warnings</p>
                <AlertTriangle className="h-4 w-4 text-amber-400/80" />
              </div>
              <p className="mt-3 text-3xl font-bold text-amber-200">
                {snapshotLoading ? <span className="inline-block h-8 w-12 animate-pulse rounded bg-slate-700/60" /> : (fleetOverview?.warnings ?? 0)}
              </p>
              <p className="mt-2 text-[13px] text-slate-400">Warning device health</p>
            </button>
          </div>

          {/* Info panels — desktop only */}
          <div className="hidden md:flex premium-card-soft flex-col gap-3 p-4 text-sm font-medium text-slate-200 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-orange-300" />
              <span>Native TECHI Remote Support connect action is preserved as a future desktop-launch workflow.</span>
            </div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.06em] text-slate-400">
              <Server className="h-4 w-4" />
              <span>Managed fleet</span>
            </div>
          </div>

          <div className="hidden md:flex premium-card-soft flex-col gap-3 p-4 text-sm font-medium text-slate-200 lg:flex-row lg:items-center lg:justify-between">
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
                id="hide-offline-days"
                name="hide-offline-days"
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
            clients={clients}
            clientGroups={fleetOverview?.tree_counts.by_client_category}
            unassignedCount={fleetOverview?.tree_counts.unassigned}
            onMobileLoadMore={handleMobileLoadMore}
            mobileHasMore={tableTotal > tableDevices.length}
            mobileLoadingMore={mobileLoadingMore}
            activePackageVersion={fleetOverview?.active_agent_version}
            activePackageSha256={fleetOverview?.active_agent_sha256}
            activeConnectorVersions={fleetOverview?.active_connector_versions}
            activeAgentVersions={fleetOverview?.active_agent_versions}
            agentsOutdated={fleetOverview?.agents_outdated ?? 0}
            onOpenDeviceTerminal={openDeviceTerminal}
          />
        </div>
      </div>

      {drawerDevice && (
        // Registry selects the renderer: a device that reports capabilities
        // (Linux + future platforms) uses the generic registry-driven Drawer;
        // a device with no capabilities (every Windows agent) uses the classic
        // DeviceDrawer, unchanged and byte-identical.
        drawerDevice.capabilities && Object.keys(drawerDevice.capabilities).length > 0 ? (
          <GenericDeviceDrawer
            device={drawerDevice}
            isOpen={drawerOpen}
            onClose={closeDrawer}
            latestEvent={latestEvent}
            clients={clients}
            groups={groups}
            canOperate={can("operator")}
            onDeviceUpdated={handleDeviceUpdated}
            initialTab={drawerInitialTab}
          />
        ) : (
          <DeviceDrawer
            device={drawerDevice}
            isOpen={drawerOpen}
            onClose={closeDrawer}
            wsStatus={realtimeStatus}
            latestEvent={latestEvent}
            clients={clients}
            groups={groups}
            onDeviceUpdated={handleDeviceUpdated}
            canOperate={can("operator")}
            isFavorite={drawerDevice ? favorites.has(drawerDevice.id) : false}
            onToggleFavorite={toggleFavorite}
          />
        )
      )}
    </section>
  );
}
