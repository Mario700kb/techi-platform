import { useCallback, useEffect, useRef, useState } from "react";
import { getAlerts, getAlertCount } from "../api/alerts";
import { Alert, AlertCount } from "../types/alert";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";

interface UseAlertsOptions {
  latestEvent?: DeviceRealtimeEvent | null;
  /** Fetch only for a signed-in operator; flipping to true (login) loads immediately. */
  enabled?: boolean;
}

interface UseAlertsResult {
  alerts: Alert[];
  alertCount: AlertCount;
  loading: boolean;
  reload: () => void;
}

const EMPTY_COUNT: AlertCount = { total_open: 0, by_severity: {} };

export function useAlerts({ latestEvent, enabled = true }: UseAlertsOptions = {}): UseAlertsResult {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertCount, setAlertCount] = useState<AlertCount>(EMPTY_COUNT);
  const [loading, setLoading] = useState(false);
  const seenIds = useRef(new Set<number>());

  const loadAlerts = useCallback(async () => {
    setLoading(true);
    const [feedResult, countResult] = await Promise.allSettled([
      getAlerts({ state: "open", limit: 50 }),
      getAlertCount(),
    ]);
    if (feedResult.status === "fulfilled") {
      seenIds.current = new Set(feedResult.value.map((a) => a.id));
      setAlerts(feedResult.value);
    }
    if (countResult.status === "fulfilled") {
      setAlertCount(countResult.value);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setAlerts([]);
      setAlertCount(EMPTY_COUNT);
      return;
    }
    void loadAlerts();
    const id = window.setInterval(() => void loadAlerts(), 120000);
    return () => window.clearInterval(id);
  }, [loadAlerts, enabled]);

  useEffect(() => {
    if (!latestEvent) return;
    const { type, data } = latestEvent;

    if (type === "alert_created" && data) {
      const alert = data as unknown as Alert;
      if (alert.id && !seenIds.current.has(alert.id)) {
        seenIds.current.add(alert.id);
        setAlerts((prev) => [alert, ...prev].slice(0, 100));
        setAlertCount((prev) => ({
          total_open: prev.total_open + 1,
          by_severity: {
            ...prev.by_severity,
            [alert.severity]: (prev.by_severity[alert.severity] ?? 0) + 1,
          },
        }));
      }
    }

    if (type === "alert_resolved" && data) {
      const alert = data as unknown as Alert;
      if (alert.id) {
        setAlerts((prev) => prev.filter((a) => a.id !== alert.id));
        setAlertCount((prev) => ({
          total_open: Math.max(0, prev.total_open - 1),
          by_severity: {
            ...prev.by_severity,
            [alert.severity]: Math.max(0, (prev.by_severity[alert.severity] ?? 0) - 1),
          },
        }));
      }
    }
  }, [latestEvent]);

  return { alerts, alertCount, loading, reload: loadAlerts };
}
