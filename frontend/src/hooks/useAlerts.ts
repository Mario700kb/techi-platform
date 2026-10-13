import { useCallback, useEffect, useRef, useState } from "react";
import { getAlerts, getAlertCount } from "../api/alerts";
import { Alert, AlertCount } from "../types/alert";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";

interface UseAlertsOptions {
  latestEvent?: DeviceRealtimeEvent | null;
  /** Fetch only for a signed-in operator; flipping to true (login) loads immediately. */
  enabled?: boolean;
  /** sessionStorage key (per operator) so a reload paints the last counts at once. */
  cacheKey?: string;
}

interface UseAlertsResult {
  alerts: Alert[];
  alertCount: AlertCount;
  /** False until the first count arrives (or a cached one is shown): not yet "no alerts". */
  alertCountReady: boolean;
  loading: boolean;
  reload: () => void;
}

const EMPTY_COUNT: AlertCount = { total_open: 0, by_severity: {} };
const CACHE_PREFIX = "techi.alerts.count.v1";

export function alertCountCacheKey(userId: number): string {
  return `${CACHE_PREFIX}:${userId}`;
}

function readCachedCount(key?: string): AlertCount | null {
  if (!key) return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as AlertCount) : null;
  } catch {
    return null;
  }
}

function clearCachedCounts() {
  try {
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith(CACHE_PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch {
    // Storage blocked: nothing was cached.
  }
}

function bump(map: Record<string, number> | undefined, key: string, by: number): Record<string, number> {
  return { ...map, [key]: Math.max(0, (map?.[key] ?? 0) + by) };
}

export function useAlerts({ latestEvent, enabled = true, cacheKey }: UseAlertsOptions = {}): UseAlertsResult {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertCount, setAlertCount] = useState<AlertCount>(() => readCachedCount(cacheKey) ?? EMPTY_COUNT);
  const [alertCountReady, setAlertCountReady] = useState(() => readCachedCount(cacheKey) !== null);
  const [loading, setLoading] = useState(false);
  const seenIds = useRef(new Set<number>());

  // The count and the feed resolve on their own: the dashboard's counts must
  // not wait for the 50-alert feed.
  const loadAlerts = useCallback(async () => {
    setLoading(true);
    const count = getAlertCount().then((value) => {
      setAlertCount(value);
      setAlertCountReady(true);
      if (cacheKey) {
        try {
          window.sessionStorage.setItem(cacheKey, JSON.stringify(value));
        } catch {
          // Storage full or blocked: the next reload just waits for the request.
        }
      }
    });
    const feed = getAlerts({ state: "open", limit: 50 }).then((value) => {
      seenIds.current = new Set(value.map((a) => a.id));
      setAlerts(value);
    });
    await Promise.allSettled([count, feed]);
    setLoading(false);
  }, [cacheKey]);

  useEffect(() => {
    if (!enabled) {
      setAlerts([]);
      setAlertCount(EMPTY_COUNT);
      setAlertCountReady(false);
      clearCachedCounts();
      return;
    }
    const cached = readCachedCount(cacheKey);
    if (cached) {
      setAlertCount(cached);
      setAlertCountReady(true);
    }
    void loadAlerts();
    const id = window.setInterval(() => void loadAlerts(), 120000);
    return () => window.clearInterval(id);
  }, [loadAlerts, enabled, cacheKey]);

  useEffect(() => {
    if (!latestEvent) return;
    const { type, data } = latestEvent;

    if (type === "alert_created" && data) {
      const alert = data as unknown as Alert;
      if (alert.id && !seenIds.current.has(alert.id)) {
        seenIds.current.add(alert.id);
        setAlerts((prev) => [alert, ...prev].slice(0, 100));
        setAlertCount((prev) => ({
          ...prev,
          total_open: prev.total_open + 1,
          by_severity: bump(prev.by_severity, alert.severity, 1),
          by_kind: alert.kind ? bump(prev.by_kind, alert.kind, 1) : prev.by_kind,
        }));
      }
    }

    if (type === "alert_resolved" && data) {
      const alert = data as unknown as Alert;
      if (alert.id) {
        setAlerts((prev) => prev.filter((a) => a.id !== alert.id));
        setAlertCount((prev) => ({
          ...prev,
          total_open: Math.max(0, prev.total_open - 1),
          by_severity: bump(prev.by_severity, alert.severity, -1),
          by_kind: alert.kind ? bump(prev.by_kind, alert.kind, -1) : prev.by_kind,
        }));
      }
    }
  }, [latestEvent]);

  return { alerts, alertCount, alertCountReady, loading, reload: loadAlerts };
}
