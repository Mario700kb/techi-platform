import { useCallback, useEffect, useRef, useState } from "react";
import { getDeviceAlerts } from "../api/alerts";
import { Alert } from "../types/alert";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";
import { parseUTC } from "../utils/time";

interface UseDeviceAlertsOptions {
  deviceId: number;
  latestEvent?: DeviceRealtimeEvent | null;
}

/** Every kind and severity; the view shows five and expands to the rest. */
const RESOLVED_KEPT = 20;
/**
 * Realtime events keep the lists current; this re-reads them as a backstop
 * for anything a socket missed (a reconnect, a laptop waking up). Two small
 * requests a minute per open device view.
 */
const REFRESH_MS = 60_000;

function newestResolvedFirst(alerts: Alert[]): Alert[] {
  return [...alerts]
    .sort(
      (a, b) => parseUTC(b.resolved_at ?? b.updated_at).getTime() - parseUTC(a.resolved_at ?? a.updated_at).getTime(),
    )
    .slice(0, RESOLVED_KEPT);
}

export function useDeviceAlerts({ deviceId, latestEvent }: UseDeviceAlertsOptions) {
  const [openAlerts, setOpenAlerts] = useState<Alert[]>([]);
  const [resolvedAlerts, setResolvedAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const loaded = useRef(false);

  const reload = useCallback(async () => {
    try {
      // Only the first load shows a spinner; refreshes replace the lists quietly.
      if (!loaded.current) setLoading(true);
      const [open, resolved] = await Promise.all([
        getDeviceAlerts(deviceId, "open"),
        getDeviceAlerts(deviceId, "resolved"),
      ]);
      setOpenAlerts(open);
      setResolvedAlerts(newestResolvedFirst(resolved));
      loaded.current = true;
    } catch {
      // Keep what is shown; the next refresh or event will correct it.
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    loaded.current = false;
    void reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  useEffect(() => {
    if (!latestEvent?.data) return;
    const { type, data } = latestEvent;
    const alert = data as unknown as Alert;
    if (alert.device_id !== deviceId || !alert.id) return;

    if (type === "alert_created") {
      setOpenAlerts((prev) => (prev.some((a) => a.id === alert.id) ? prev : [alert, ...prev]));
    }
    if (type === "alert_resolved") {
      setOpenAlerts((prev) => prev.filter((a) => a.id !== alert.id));
      setResolvedAlerts((prev) => newestResolvedFirst([alert, ...prev.filter((a) => a.id !== alert.id)]));
    }
  }, [latestEvent, deviceId]);

  return { openAlerts, resolvedAlerts, loading, reload };
}
