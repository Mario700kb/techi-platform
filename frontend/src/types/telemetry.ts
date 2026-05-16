export type HealthState = "healthy" | "warning" | "critical";

export interface TelemetrySnapshot {
  id: number;
  device_id: number;
  cpu_percent: number | null;
  ram_percent: number | null;
  disk_percent: number | null;
  uptime_seconds: number | null;
  heartbeat_latency_ms: number | null;
  created_at: string;
}

export interface DeviceHealth {
  device_id: number;
  health_score: number;
  health_state: HealthState;
  latest_telemetry: TelemetrySnapshot | null;
  reasons: string[];
}

export interface DeviceHealthSummary {
  device_id: number;
  health_score: number;
  health_state: HealthState;
  cpu_percent: number | null;
  ram_percent: number | null;
  disk_percent: number | null;
  uptime_seconds: number | null;
  heartbeat_latency_ms: number | null;
  computed_at: string | null;
}
