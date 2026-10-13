import { useEffect, useRef } from "react";
import { getDeviceActivity } from "../api/activity";
import { useCachedQuery } from "./useCachedQuery";
import { ActivityEvent } from "../types/activity";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";

interface UseDeviceActivityOptions {
  deviceId: number | null;
  latestEvent?: DeviceRealtimeEvent | null;
  enabled?: boolean;
}

const EVENT_SUMMARIES: Partial<Record<string, string>> = {
  heartbeat_received: "Heartbeat received",
  device_online: "Device came online",
  device_offline: "Device went offline",
  rustdesk_updated: "TECHI Remote Support metadata updated",
  sync_failed: "Sync failure detected",
  device_updated: "Device state updated",
  health_warning: "Health warning",
  health_critical: "Health critical",
  health_recovered: "Health recovered",
  note_added: "Note added",
  note_edited: "Note edited",
  assignment_changed: "Assignment changed",
  device_archived: "Device archived",
  device_restored: "Device restored",
  maintenance_entered: "Maintenance started",
  maintenance_cleared: "Maintenance cleared",
  action_queued: "Action queued",
  action_completed: "Action completed",
  action_failed: "Action failed",
};

const IGNORED_TYPES = new Set(["connection_ready", "server_ping", "telemetry_updated"]);

export function useDeviceActivity({ deviceId, latestEvent, enabled = true }: UseDeviceActivityOptions) {
  const seenIds = useRef(new Set<string>());
  const key = deviceId && enabled ? `page.device.${deviceId}.activity` : null;
  const { data, loading, reload, setData } = useCachedQuery(key, async () => {
    const fresh = await getDeviceActivity(deviceId as number);
    seenIds.current = new Set(fresh.map((e) => e.id));
    return fresh;
  });

  useEffect(() => {
    seenIds.current = new Set();
  }, [key]);

  useEffect(() => {
    if (!latestEvent || !deviceId || !enabled) return;
    const eventDeviceId = latestEvent.data?.device_id ?? latestEvent.data?.id;
    if (eventDeviceId !== deviceId) return;
    if (!latestEvent.occurred_at) return;
    if (IGNORED_TYPES.has(latestEvent.type)) return;

    const evtId = `rt-${latestEvent.event_id ?? `${latestEvent.type}-${latestEvent.occurred_at}`}`;
    if (seenIds.current.has(evtId)) return;
    seenIds.current.add(evtId);

    const newEvent: ActivityEvent = {
      id: evtId,
      type: latestEvent.type as ActivityEvent["type"],
      occurred_at: latestEvent.occurred_at,
      summary: EVENT_SUMMARIES[latestEvent.type] ?? latestEvent.type,
      detail: latestEvent.reason ?? undefined,
      device_id: deviceId,
    };

    setData((prev) => {
      const current = prev ?? [];
      if (current.some((e) => e.id === evtId)) return current;
      return [newEvent, ...current].slice(0, 60);
    });
  }, [latestEvent, deviceId, enabled, setData]);

  return { events: data ?? [], loading, reload };
}
