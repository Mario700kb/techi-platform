import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { DeviceFleetOverview, getDevicesOverview } from "../api/devices";
import { DeviceInventory, inventoryCacheKey, patchStatusFromEvent, withPatchStatus } from "../api/inventory";
import { useAuth } from "../auth/AuthContext";
import { useDeviceRealtime } from "../hooks/useDeviceRealtime";
import { DeviceRealtimeEvent, DeviceRealtimeStatus } from "../services/deviceRealtime";
import { alertCountCacheKey, useAlerts } from "../hooks/useAlerts";
import { appCache } from "../store/appCache";
import { Alert, AlertCount } from "../types/alert";
import { serverNow } from "../utils/devicePresence";
import { parseUTC } from "../utils/time";

const OVERVIEW_STORAGE_KEY = "techi.fleet.overview.v2";
const OVERVIEW_TTL_MS = 30_000;
/** Overview polling while the WebSocket is down (events refresh it otherwise). */
const OVERVIEW_POLL_MS = 30_000;
/** A tab hidden at least this long refreshes the overview and alerts when shown. */
const CATCH_UP_AFTER_HIDDEN_MS = 30_000;
const OVERVIEW_REFRESH_EVENTS = new Set([
  "device_online",
  "device_offline",
  "device_updated",
  "heartbeat_received",
  "rustdesk_updated",
  "rustdesk_online",
  "rustdesk_offline",
  "sync_failed",
  "telemetry_updated",
  "health_warning",
  "health_critical",
  "health_recovered",
  "alert_created",
  "alert_resolved",
  "patch_status_updated",
]);
/** A device changed status or live state: the counts are out of date now. */
const STATUS_CHANGE_EVENTS = new Set(["device_online", "device_offline"]);
/** Counted again this soon after a status change (a burst is counted once). */
const STATUS_REFRESH_DELAY_MS = 3000;
/** The earliest refresh for a time-based change (the server recounts at most every 5 s). */
const MIN_CHANGE_REFRESH_MS = 5000;
/** Events waiting for their turn (a fleet reconnect is ~10 a second; this is minutes of backlog). */
const MAX_QUEUED_EVENTS = 2000;

function isStatusChange(event: DeviceRealtimeEvent): boolean {
  return (
    STATUS_CHANGE_EVENTS.has(event.type) ||
    (event.type === "device_updated" && (event.reason ?? "").startsWith("agent_channel"))
  );
}

interface PersistedOverview {
  userId: number;
  data: DeviceFleetOverview;
  fetchedAt: number;
}

interface AppDataContextValue {
  fleetOverview: DeviceFleetOverview | null;
  fleetOverviewLoading: boolean;
  fleetOverviewError: string | null;
  lastFetchTime: number | null;
  refreshFleetOverview: (force?: boolean) => Promise<void>;
  latestEvent: DeviceRealtimeEvent | null;
  realtimeStatus: DeviceRealtimeStatus;
  alertCount: AlertCount;
  alertCountReady: boolean;
  totalOpenAlerts: number;
  alerts: Alert[];
  reloadAlerts: () => void;
}

const AppDataContext = createContext<AppDataContextValue | null>(null);

function readPersistedOverview(userId: number | undefined): PersistedOverview | null {
  if (!userId) return null;
  try {
    const raw = window.sessionStorage.getItem(OVERVIEW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedOverview;
    if (!parsed.data?.tree_counts?.by_client_category) return null;
    return parsed.userId === userId ? parsed : null;
  } catch {
    return null;
  }
}

export function AppDataProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const initialOverview = useMemo(() => readPersistedOverview(userId), [userId]);
  const [fleetOverview, setFleetOverview] = useState<DeviceFleetOverview | null>(() => initialOverview?.data ?? null);
  const [lastFetchTime, setLastFetchTime] = useState<number | null>(() => initialOverview?.fetchedAt ?? null);
  const [fleetOverviewLoading, setFleetOverviewLoading] = useState(() => Boolean(user && !initialOverview));
  const [fleetOverviewError, setFleetOverviewError] = useState<string | null>(null);
  const [latestEvent, setLatestEvent] = useState<DeviceRealtimeEvent | null>(null);
  // Every screen reads realtime events from latestEvent in an effect, so each
  // event needs a render of its own. A heartbeat's events (heartbeat_received,
  // device_updated, telemetry_updated, patch_status_updated) arrive within
  // milliseconds; set in one go they shared a render and screens saw only the
  // last, so a field sent once in a heartbeat delta (a new agent version) was
  // lost until a reload. Events now wait here and are handed out one at a time.
  const eventQueueRef = useRef<DeviceRealtimeEvent[]>([]);
  const deliveringRef = useRef(false);
  const deliverEvent = useCallback((event: DeviceRealtimeEvent) => {
    if (deliveringRef.current) {
      const queue = eventQueueRef.current;
      queue.push(event);
      if (queue.length > MAX_QUEUED_EVENTS) queue.shift();
      return;
    }
    deliveringRef.current = true;
    setLatestEvent(event);
  }, []);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const refreshTimerRef = useRef<number | undefined>();
  const statusTimerRef = useRef<number | undefined>();
  const activeUserIdRef = useRef(userId);
  const fleetOverviewRef = useRef(fleetOverview);
  const lastFetchTimeRef = useRef(lastFetchTime);
  activeUserIdRef.current = userId;
  fleetOverviewRef.current = fleetOverview;
  lastFetchTimeRef.current = lastFetchTime;

  const refreshFleetOverview = useCallback(
    async (force = false) => {
      if (!userId) return;
      const now = Date.now();
      if (
        !force &&
        fleetOverviewRef.current &&
        lastFetchTimeRef.current &&
        now - lastFetchTimeRef.current < OVERVIEW_TTL_MS
      ) {
        return;
      }
      if (refreshPromiseRef.current) return refreshPromiseRef.current;

      if (!fleetOverviewRef.current) setFleetOverviewLoading(true);
      setFleetOverviewError(null);
      const request = getDevicesOverview()
        .then((data) => {
          if (activeUserIdRef.current !== userId) return;
          const fetchedAt = Date.now();
          setFleetOverview(data);
          setLastFetchTime(fetchedAt);
          window.sessionStorage.setItem(
            OVERVIEW_STORAGE_KEY,
            JSON.stringify({
              userId,
              data,
              fetchedAt,
            } satisfies PersistedOverview),
          );
        })
        .catch((error) => {
          if (activeUserIdRef.current !== userId) return;
          setFleetOverviewError(error instanceof Error ? error.message : "Failed to load fleet overview");
        })
        .finally(() => {
          if (activeUserIdRef.current === userId) {
            setFleetOverviewLoading(false);
          }
          if (refreshPromiseRef.current === request) {
            refreshPromiseRef.current = null;
          }
        });
      refreshPromiseRef.current = request;
      return request;
    },
    [userId],
  );

  useEffect(() => {
    if (!userId) {
      refreshPromiseRef.current = null;
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = undefined;
      window.clearTimeout(statusTimerRef.current);
      statusTimerRef.current = undefined;
      setFleetOverview(null);
      setLastFetchTime(null);
      setFleetOverviewLoading(false);
      setFleetOverviewError(null);
      eventQueueRef.current = [];
      deliveringRef.current = false;
      setLatestEvent(null);
      window.sessionStorage.removeItem(OVERVIEW_STORAGE_KEY);
      return;
    }
    const cached = readPersistedOverview(userId);
    if (cached) {
      setFleetOverview(cached.data);
      setLastFetchTime(cached.fetchedAt);
      setFleetOverviewLoading(false);
      fleetOverviewRef.current = cached.data;
      lastFetchTimeRef.current = cached.fetchedAt;
      if (Date.now() - cached.fetchedAt < OVERVIEW_TTL_MS) {
        return;
      }
    }
    void refreshFleetOverview();
  }, [refreshFleetOverview, userId]);

  const {
    alerts,
    alertCount,
    alertCountReady,
    reload: reloadAlerts,
  } = useAlerts({
    latestEvent,
    enabled: Boolean(userId),
    cacheKey: userId ? alertCountCacheKey(userId) : undefined,
  });

  const realtimeStatus = useDeviceRealtime({
    enabled: Boolean(userId),
    onEvent: (event) => {
      // An inventory pulled earlier this session is shown again without a
      // request; it carries the new update count from the next render on.
      const patch = patchStatusFromEvent(event);
      if (patch) {
        const key = inventoryCacheKey(patch.device_id);
        const cached = appCache.peek<DeviceInventory>(key);
        if (cached) appCache.set(key, withPatchStatus(cached, patch));
      }
      deliverEvent(event);
      if (isStatusChange(event)) {
        // Counts (tabs, Explorer rings, client figures) move with the rows:
        // forced past the overview's 30 s freshness, once per burst.
        if (statusTimerRef.current) return;
        statusTimerRef.current = window.setTimeout(() => {
          statusTimerRef.current = undefined;
          void refreshFleetOverview(true);
        }, STATUS_REFRESH_DELAY_MS);
        return;
      }
      if (!OVERVIEW_REFRESH_EVENTS.has(event.type)) return;
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = undefined;
        void refreshFleetOverview();
      }, 5000);
    },
  });

  // The screens are this provider's descendants, so their effects for an
  // event have run when this one does: hand out the next.
  useEffect(() => {
    if (!latestEvent) return;
    const next = eventQueueRef.current.shift();
    if (next) setLatestEvent(next);
    else deliveringRef.current = false;
  }, [latestEvent]);

  useEffect(() => {
    return () => {
      window.clearTimeout(refreshTimerRef.current);
      window.clearTimeout(statusTimerRef.current);
    };
  }, []);

  // No event says a device turned stale at 6 minutes or offline at 25: the
  // overview says when the next such change is due, and is fetched again
  // then — one timer, not a poll.
  const nextChangeAt = fleetOverview?.next_change_at ?? null;
  useEffect(() => {
    if (!userId || !nextChangeAt) return;
    const due = parseUTC(nextChangeAt).getTime();
    if (Number.isNaN(due)) return;
    const delay = Math.max(MIN_CHANGE_REFRESH_MS, due - serverNow() + 1000);
    const id = window.setTimeout(() => {
      if (document.visibilityState === "visible") void refreshFleetOverview(true);
    }, delay);
    return () => window.clearTimeout(id);
  }, [nextChangeAt, refreshFleetOverview, userId]);

  // Events are what keep the overview current. Without a socket there are
  // none, so poll instead (visible tabs only), and catch up as soon as the
  // socket comes back: whatever happened while it was down sent no event.
  // While it retries, the socket cycles through connecting/fallback; only
  // "connected or not" may restart the poll, or its timer never gets to fire.
  const socketConnected = realtimeStatus === "connected";
  const socketWasDown = useRef(false);
  useEffect(() => {
    if (!userId) return;
    if (realtimeStatus === "disconnected" || realtimeStatus === "fallback") socketWasDown.current = true;
    if (realtimeStatus === "connected" && socketWasDown.current) {
      socketWasDown.current = false;
      void refreshFleetOverview(true);
      reloadAlerts();
    }
  }, [realtimeStatus, refreshFleetOverview, reloadAlerts, userId]);
  useEffect(() => {
    if (!userId || socketConnected) return;
    const id = window.setInterval(() => {
      // Forced: the poll is the cadence, and a fetch that returned a moment
      // after the last tick would otherwise still count as fresh and be skipped.
      if (document.visibilityState === "visible") void refreshFleetOverview(true);
    }, OVERVIEW_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshFleetOverview, socketConnected, userId]);

  // A tab in the background (or a laptop asleep) misses events and has its
  // timers throttled; refresh what is stale when it is shown again.
  useEffect(() => {
    if (!userId) return;
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt >= CATCH_UP_AFTER_HIDDEN_MS) {
        void refreshFleetOverview();
        reloadAlerts();
      }
      hiddenAt = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshFleetOverview, reloadAlerts, userId]);

  const value = useMemo<AppDataContextValue>(
    () => ({
      fleetOverview,
      fleetOverviewLoading,
      fleetOverviewError,
      lastFetchTime,
      refreshFleetOverview,
      latestEvent,
      realtimeStatus,
      alertCount,
      alertCountReady,
      totalOpenAlerts: alertCount.total_open,
      alerts,
      reloadAlerts,
    }),
    [
      fleetOverview,
      fleetOverviewLoading,
      fleetOverviewError,
      lastFetchTime,
      refreshFleetOverview,
      latestEvent,
      realtimeStatus,
      alertCount,
      alertCountReady,
      alerts,
      reloadAlerts,
    ],
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppDataContextValue {
  const value = useContext(AppDataContext);
  if (!value) throw new Error("useAppData must be used inside AppDataProvider");
  return value;
}
