import { useCallback, useEffect } from "react";
import { getDeviceAlerts } from "../api/alerts";
import { Alert } from "../types/alert";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";
import { parseUTC } from "../utils/time";
import { useCachedQuery } from "./useCachedQuery";

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
  const open = useCachedQuery(`page.device.${deviceId}.alerts.open`, () => getDeviceAlerts(deviceId, "open"));
  const resolved = useCachedQuery(`page.device.${deviceId}.alerts.resolved`, async () =>
    newestResolvedFirst(await getDeviceAlerts(deviceId, "resolved")),
  );
  const { reload: reloadOpen, setData: setOpenAlerts } = open;
  const { reload: reloadResolved, setData: setResolvedAlerts } = resolved;

  const reload = useCallback(async () => {
    await Promise.all([reloadOpen(), reloadResolved()]);
  }, [reloadOpen, reloadResolved]);

  useEffect(() => {
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
      setOpenAlerts((prev = []) => (prev.some((a) => a.id === alert.id) ? prev : [alert, ...prev]));
    }
    if (type === "alert_resolved") {
      setOpenAlerts((prev = []) => prev.filter((a) => a.id !== alert.id));
      setResolvedAlerts((prev = []) => newestResolvedFirst([alert, ...prev.filter((a) => a.id !== alert.id)]));
    }
  }, [latestEvent, deviceId, setOpenAlerts, setResolvedAlerts]);

  return {
    openAlerts: open.data ?? [],
    resolvedAlerts: resolved.data ?? [],
    loading: open.loading || resolved.loading,
    reload,
  };
}
