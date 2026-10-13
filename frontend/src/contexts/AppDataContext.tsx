import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { DeviceFleetOverview, getDevicesOverview } from "../api/devices";
import { useAuth } from "../auth/AuthContext";
import { useDeviceRealtime } from "../hooks/useDeviceRealtime";
import { DeviceRealtimeEvent, DeviceRealtimeStatus } from "../services/deviceRealtime";
import { alertCountCacheKey, useAlerts } from "../hooks/useAlerts";
import { Alert, AlertCount } from "../types/alert";

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
]);

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
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const refreshTimerRef = useRef<number | undefined>();
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
      setFleetOverview(null);
      setLastFetchTime(null);
      setFleetOverviewLoading(false);
      setFleetOverviewError(null);
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
      setLatestEvent(event);
      if (!OVERVIEW_REFRESH_EVENTS.has(event.type)) return;
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = undefined;
        void refreshFleetOverview();
      }, 5000);
    },
  });

  useEffect(() => {
    return () => window.clearTimeout(refreshTimerRef.current);
  }, []);

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
