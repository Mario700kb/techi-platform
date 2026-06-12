export type AlertSeverity = "info" | "warning" | "critical";
export type AlertState = "open" | "resolved";
export type AlertKind =
  | "device_offline"
  | "repeated_reconnects"
  | "high_cpu"
  | "high_ram"
  | "low_disk"
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
}

export interface AlertCount {
  total_open: number;
  by_severity: Record<string, number>;
}
