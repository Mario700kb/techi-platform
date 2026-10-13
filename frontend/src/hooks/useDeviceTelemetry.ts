import { useEffect } from "react";
import { getDeviceHealth } from "../api/telemetry";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";
import { HealthState, TelemetrySnapshot } from "../types/telemetry";
import { useCachedQuery } from "./useCachedQuery";

interface UseDeviceTelemetryOptions {
  deviceId: number | null;
  latestEvent?: DeviceRealtimeEvent | null;
}

interface DeviceTelemetryState {
  snapshot: TelemetrySnapshot | null;
  healthScore: number | null;
  healthState: HealthState;
  healthReasons: string[];
}

const EMPTY: DeviceTelemetryState = {
  snapshot: null,
  healthScore: null,
  healthState: "healthy",
  healthReasons: [],
};

export function useDeviceTelemetry({ deviceId, latestEvent }: UseDeviceTelemetryOptions) {
  const { data, loading, reload, setData } = useCachedQuery<DeviceTelemetryState>(
    deviceId ? `page.device.${deviceId}.telemetry` : null,
    async () => {
      const health = await getDeviceHealth(deviceId as number);
      return {
        snapshot: health.latest_telemetry,
        healthScore: health.health_score,
        healthState: health.health_state,
        healthReasons: health.reasons,
      };
    },
  );

  useEffect(() => {
    if (!latestEvent || !deviceId) return;
    if (latestEvent.data?.id !== deviceId) return;

    if (latestEvent.type === "device_offline") {
      setData((prev = EMPTY) => ({ ...prev, healthScore: 0, healthState: "critical" }));
      return;
    }

    if (latestEvent.type !== "telemetry_updated") return;

    const d = latestEvent.data;
    setData((prev = EMPTY) => ({
      healthScore: d.health_score != null ? d.health_score : prev.healthScore,
      healthState: d.health_state ? (d.health_state as HealthState) : prev.healthState,
      healthReasons: d.health_reasons ? (d.health_reasons as string[]) : prev.healthReasons,
      snapshot: {
        id: -1,
        device_id: deviceId,
        cpu_percent: d.cpu_percent ?? null,
        ram_percent: d.ram_percent ?? null,
        disk_percent: d.disk_percent ?? null,
        uptime_seconds: d.uptime_seconds ?? null,
        heartbeat_latency_ms: d.heartbeat_latency_ms ?? null,
        created_at: latestEvent.occurred_at ?? new Date().toISOString(),
      },
    }));
  }, [latestEvent, deviceId, setData]);

  const state = data ?? EMPTY;
  return { ...state, loading, reload };
}
