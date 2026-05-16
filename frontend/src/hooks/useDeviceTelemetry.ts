import { useCallback, useEffect, useState } from "react";
import { getDeviceHealth } from "../api/telemetry";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";
import { HealthState, TelemetrySnapshot } from "../types/telemetry";

interface UseDeviceTelemetryOptions {
  deviceId: number | null;
  latestEvent?: DeviceRealtimeEvent | null;
}

export function useDeviceTelemetry({ deviceId, latestEvent }: UseDeviceTelemetryOptions) {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [healthScore, setHealthScore] = useState<number | null>(null);
  const [healthState, setHealthState] = useState<HealthState>("healthy");
  const [healthReasons, setHealthReasons] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!deviceId) return;
    try {
      setLoading(true);
      const health = await getDeviceHealth(deviceId);
      setSnapshot(health.latest_telemetry);
      setHealthScore(health.health_score);
      setHealthState(health.health_state);
      setHealthReasons(health.reasons);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    setSnapshot(null);
    setHealthScore(null);
    setHealthState("healthy");
    setHealthReasons([]);
    if (deviceId) void load();
  }, [deviceId, load]);

  useEffect(() => {
    if (!latestEvent || !deviceId) return;
    if (latestEvent.data?.id !== deviceId) return;

    if (latestEvent.type === "device_offline") {
      setHealthScore(0);
      setHealthState("critical");
      return;
    }

    if (latestEvent.type !== "telemetry_updated") return;

    const d = latestEvent.data;
    if (d.health_score != null) setHealthScore(d.health_score);
    if (d.health_state) setHealthState(d.health_state as HealthState);
    if (d.health_reasons) setHealthReasons(d.health_reasons as string[]);

    setSnapshot({
      id: -1,
      device_id: deviceId,
      cpu_percent: d.cpu_percent ?? null,
      ram_percent: d.ram_percent ?? null,
      disk_percent: d.disk_percent ?? null,
      uptime_seconds: d.uptime_seconds ?? null,
      heartbeat_latency_ms: d.heartbeat_latency_ms ?? null,
      created_at: latestEvent.occurred_at ?? new Date().toISOString(),
    });
  }, [latestEvent, deviceId]);

  return { snapshot, healthScore, healthState, healthReasons, loading, reload: load };
}
