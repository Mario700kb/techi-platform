import { useCallback, useEffect, useRef, useState } from "react";
import { getDeviceAlerts } from "../api/alerts";
import { Alert } from "../types/alert";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";

interface UseDeviceAlertsOptions {
  deviceId: number;
  latestEvent?: DeviceRealtimeEvent | null;
}

export function useDeviceAlerts({ deviceId, latestEvent }: UseDeviceAlertsOptions) {
  const [openAlerts, setOpenAlerts] = useState<Alert[]>([]);
  const [resolvedAlerts, setResolvedAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const seenOpen = useRef(new Set<number>());

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      const [open, resolved] = await Promise.all([
        getDeviceAlerts(deviceId, "open"),
        getDeviceAlerts(deviceId, "resolved"),
      ]);
      seenOpen.current = new Set(open.map((a) => a.id));
      setOpenAlerts(open);
      setResolvedAlerts(resolved.slice(0, 5));
    } catch {
      // fail silently
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!latestEvent?.data) return;
    const { type, data } = latestEvent;
    const alert = data as unknown as Alert;

    if (type === "alert_created" && alert.device_id === deviceId && alert.id && !seenOpen.current.has(alert.id)) {
      seenOpen.current.add(alert.id);
      setOpenAlerts((prev) => [alert, ...prev]);
    }

    if (type === "alert_resolved" && alert.device_id === deviceId && alert.id) {
      seenOpen.current.delete(alert.id);
      setOpenAlerts((prev) => prev.filter((a) => a.id !== alert.id));
      setResolvedAlerts((prev) => [alert, ...prev].slice(0, 5));
    }
  }, [latestEvent, deviceId]);

  return { openAlerts, resolvedAlerts, loading, reload };
}
