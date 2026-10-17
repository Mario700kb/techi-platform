export type AlertSeverity = "info" | "warning" | "critical";
export type AlertState = "open" | "resolved";
export type AlertKind =
  | "device_offline"
  | "repeated_reconnects"
  | "high_cpu"
  | "high_ram"
  | "low_disk"
  | "disk_forecast"
  | "high_network"
  | "rustdesk_sync_failure"
  | "heartbeat_stale"
  | "telemetry_missing"
  | "token_usage_warning"
  | "token_usage_critical";

export interface Alert {
  id: number;
  // null for synthetic token-usage alerts (negative id, token_id set)
  device_id: number | null;
  token_id?: number | null;
  kind: AlertKind;
  severity: AlertSeverity;
  state: AlertState;
  message: string;
  detail?: string | null;
  created_at: string;
  updated_at: string;
  resolved_at?: string | null;
  acknowledged_at?: string | null;
  cooldown_until?: string | null;
  // The device's current name and client (the message keeps the hostname it
  // had when the alert opened).
  device_name?: string | null;
  client_name?: string | null;
}

export interface AlertCount {
  total_open: number;
  by_severity: Record<string, number>;
  by_kind?: Record<string, number>;
  devices_affected?: number;
  oldest_open_at?: string | null;
}

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  device_offline: "Device offline",
  repeated_reconnects: "Repeated reconnects",
  high_cpu: "High CPU",
  high_ram: "High memory",
  low_disk: "Low disk space",
  disk_forecast: "Disk full forecast",
  high_network: "High network",
  rustdesk_sync_failure: "Remote Support sync failed",
  heartbeat_stale: "Heartbeat stale",
  telemetry_missing: "Telemetry missing",
  token_usage_warning: "Enrollment token nearly used up",
  token_usage_critical: "Enrollment token used up",
};

export const ALERT_SEVERITY_TONE: Record<AlertSeverity, string> = {
  critical: "var(--th-status-critical)",
  warning: "var(--th-status-warning)",
  info: "var(--th-status-info)",
};
