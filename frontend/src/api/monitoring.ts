// Monitoring: policies, a device's metrics and monitors, a client's analytics
// and the health of the telemetry pipeline (backend app/api/v1/endpoints/
// monitoring.py; shapes mirror app/schemas/telemetry_pipeline.py).
import { fetchJson } from "./client";

export type MetricsRange = "1h" | "24h" | "7d" | "30d" | "13mo";
export type MonitorMetric =
  | "cpu"
  | "mem"
  | "disk"
  | "net_rx_mbps"
  | "net_tx_mbps"
  | "disk_forecast_days"
  | "no_data"
  // Agent 2.1.33, evaluated on the device every sample.
  | "disk_busy"
  | "gw_ms"
  | "gw_loss"
  | "service"
  // Judged by the platform from the device's reports.
  | "disk_health"
  | "critical_events"
  | "reboot_pending_days"
  | "security_score";
export type MonitorSeverity = "info" | "warning" | "critical";
export type PolicyScope = "default" | "device_type" | "client" | "group";

export interface Monitor {
  key: string;
  metric: MonitorMetric;
  op: ">" | "<";
  threshold: number;
  duration_s: number;
  severity: MonitorSeverity;
  enabled: boolean;
  /** Service monitors: the services to watch, comma-separated; a trailing * matches a prefix. */
  target?: string | null;
}

export interface PolicyBody {
  name: string;
  description?: string | null;
  scope: PolicyScope;
  scope_value?: string | null;
  enabled: boolean;
  sample_seconds: number;
  upload_seconds: number;
  buffer_mb: number;
  keep_days: number;
  monitors: Monitor[];
}

export interface MonitoringPolicy extends PolicyBody {
  id: number;
  version: number;
  updated_at: string;
  updated_by?: string | null;
  devices: number;
  devices_current: number;
  /** Of `devices`, those whose agent reports the policy it runs (2.1.29+). */
  devices_reporting: number;
}

export interface EffectivePolicy {
  version: string;
  sample_seconds: number;
  upload_seconds: number;
  buffer_mb: number;
  keep_days: number;
  monitors: Monitor[];
  policies: string[];
}

export interface MetricPoint {
  t: string;
  samples: number;
  expected: number;
  cpu_avg: number | null;
  cpu_max: number | null;
  mem_avg: number | null;
  mem_max: number | null;
  rx_avg: number | null;
  rx_max: number | null;
  tx_avg: number | null;
  tx_max: number | null;
  disk_max: number | null;
  // Agent 2.1.33 (null before).
  disk_busy_avg?: number | null;
  disk_busy_max?: number | null;
  disk_queue_avg?: number | null;
  disk_read_avg?: number | null;
  disk_write_avg?: number | null;
  gw_ms_avg?: number | null;
  gw_ms_max?: number | null;
  gw_loss_avg?: number | null;
  gw_loss_max?: number | null;
  wan_ms_avg?: number | null;
  /** Busy minutes only: the top processes of the point's busiest minute. */
  top?: TopProcess[] | null;
}

/** One of the busiest processes of a minute: name, CPU % of the machine, memory MB. */
export interface TopProcess {
  n: string;
  c?: number | null;
  m?: number | null;
}

export interface AlertSpan {
  id: number;
  kind: string;
  severity: string;
  message: string;
  start: string;
  end: string | null;
}

export interface ProcessPeak {
  name: string;
  minutes: number;
  cpu_peak: number | null;
  cpu_peak_at: string | null;
  mem_peak_mb: number | null;
}

export interface DiskTrend {
  mount: string;
  used_pct: number;
  free_gb: number | null;
  total_gb: number | null;
  growth_gb_per_day: number | null;
  days_to_90: number | null;
  days_to_full: number | null;
  history: number[];
  /** False for a volume under 5 GB: shown, never alerted on. */
  monitored?: boolean;
}

export interface CoverageSegment {
  start: string;
  end: string;
  kind: "received" | "late" | "missing" | "off";
}

export interface Coverage {
  received: number;
  late: number;
  missing_minutes: number;
  off_minutes: number;
  pct: number | null;
  segments: CoverageSegment[];
}

export interface MetricSummary {
  cpu_avg: number | null;
  cpu_p95: number | null;
  cpu_peak: number | null;
  cpu_peak_at: string | null;
  mem_avg: number | null;
  mem_peak: number | null;
  rx_peak: number | null;
  tx_peak: number | null;
  disk_busy_avg?: number | null;
  disk_busy_peak?: number | null;
  disk_read_peak?: number | null;
  disk_write_peak?: number | null;
  gw_ms_avg?: number | null;
  gw_ms_peak?: number | null;
  gw_loss_avg?: number | null;
  wan_ms_avg?: number | null;
}

export interface DeliveryState {
  last_upload_at: string | null;
  last_sample_at: string | null;
  pending: number;
  oldest_pending_at: string | null;
  dropped_total: number;
  clock_offset_ms: number | null;
  sample_seconds: number | null;
  policy_version: string | null;
  policy_current: boolean;
}

export interface DeviceMetrics {
  range: MetricsRange;
  resolution: "1m" | "5m" | "1h" | "1d";
  source: "agent" | "heartbeat" | "none";
  start: string;
  end: string;
  points: MetricPoint[];
  summary: MetricSummary;
  disks: DiskTrend[];
  coverage: Coverage;
  delivery: DeliveryState | null;
  policy: EffectivePolicy;
  /** Boots inside the range (up to 7 days back). */
  restarts?: string[];
  /** Monitor alerts open at some point in the range. */
  alerts?: AlertSpan[];
  /** Processes that were among the busiest in the range. */
  processes?: ProcessPeak[];
}

export interface MonitorStatus {
  key: string;
  metric: string;
  rule: string;
  severity: MonitorSeverity | string;
  enabled: boolean;
  state: "ok" | "firing" | "watch" | "unknown" | "off";
  now: string | null;
  alert_id: number | null;
}

export interface PhysicalDisk {
  name: string;
  media: string | null;
  bus: string | null;
  size_gb: number | null;
  health: "healthy" | "warning" | "unhealthy" | "unknown" | string;
  operational: string | null;
  predict_failure: boolean | null;
  temperature_c: number | null;
  wear_pct: number | null;
  power_on_hours: number | null;
  read_errors: number | null;
  write_errors: number | null;
  /** Why it needs attention, or null. */
  problem: string | null;
}

export interface HealthEvent {
  at: string;
  source: string;
  event_id: number;
  category: "crash" | "hardware" | "disk" | "service" | string;
  level: "critical" | "error" | "warning" | string;
  title: string;
  message: string | null;
}

/** The last health report (agent 2.1.33). */
export interface DeviceHealth {
  collected_at: string | null;
  disks: PhysicalDisk[];
  reboot_pending: boolean | null;
  reboot_reasons: string[];
  reboot_pending_since: string | null;
  events: HealthEvent[];
}

export interface DeviceMonitoring {
  policy: EffectivePolicy;
  monitors: MonitorStatus[];
  delivery: DeliveryState | null;
  /** Null until the agent (2.1.33) sends its first health report. */
  health?: DeviceHealth | null;
}

export interface HeatmapRow {
  device_id: number;
  name: string;
  cells: Array<number | null>;
  peak: number | null;
}

export interface AttentionItem {
  device_id: number;
  name: string;
  kind: "disk_forecast" | "cpu_sustained" | "mem_sustained" | "not_seen" | "gaps" | "monitor";
  severity: MonitorSeverity;
  title: string;
  detail: string;
}

export interface ClientDeviceRow {
  device_id: number;
  name: string;
  kind: string;
  agent_version: string | null;
  spark: Array<number | null>;
  cpu_peak: number | null;
  mem_peak: number | null;
  disk_worst: string | null;
  disk_worst_pct: number | null;
  coverage_pct: number | null;
  one_minute: boolean;
  monitors_firing: number;
}

export interface TrendPoint {
  t: string;
  cpu_avg: number | null;
  cpu_p95: number | null;
  mem_avg: number | null;
}

export interface ClientMonitoring {
  range: MetricsRange;
  devices_total: number;
  devices_reporting: number;
  one_minute_devices: number;
  coverage_pct: number | null;
  coverage_breakdown: Coverage;
  monitor_alerts: number;
  monitor_alerts_open: number;
  cpu_avg: number | null;
  busiest_hour: number | null;
  busiest_hour_cpu: number | null;
  disks_at_risk: number;
  heatmap: HeatmapRow[];
  trend: TrendPoint[];
  attention: AttentionItem[];
  devices: ClientDeviceRow[];
}

export interface StorageTier {
  name: string;
  keep: string;
  bytes: number | null;
  rows: number | null;
}

export interface PipelineHealth {
  devices_online: number;
  devices_one_minute: number;
  uploads_last_hour: number;
  median_delay_seconds: number | null;
  devices_with_backlog: number;
  oldest_backlog_at: string | null;
  dropped_30d: number;
  samples_30d: number;
  policy_behind: number;
  storage: StorageTier[];
}

export function getDeviceMetrics(deviceId: number, range: MetricsRange = "24h"): Promise<DeviceMetrics> {
  return fetchJson<DeviceMetrics>(`/api/v1/devices/${deviceId}/metrics?range=${range}`);
}

export function getDeviceMonitoring(deviceId: number): Promise<DeviceMonitoring> {
  return fetchJson<DeviceMonitoring>(`/api/v1/devices/${deviceId}/monitoring`);
}

export function getClientMonitoring(
  clientId: number,
  range: Exclude<MetricsRange, "1h"> = "7d",
): Promise<ClientMonitoring> {
  return fetchJson<ClientMonitoring>(`/api/v1/clients/${clientId}/monitoring?range=${range}`);
}

export function listMonitoringPolicies(): Promise<MonitoringPolicy[]> {
  return fetchJson<MonitoringPolicy[]>(`/api/v1/monitoring/policies`);
}

export function createMonitoringPolicy(body: PolicyBody): Promise<MonitoringPolicy> {
  return fetchJson<MonitoringPolicy>(`/api/v1/monitoring/policies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function updateMonitoringPolicy(id: number, body: PolicyBody): Promise<MonitoringPolicy> {
  return fetchJson<MonitoringPolicy>(`/api/v1/monitoring/policies/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteMonitoringPolicy(id: number): Promise<void> {
  return fetchJson<void>(`/api/v1/monitoring/policies/${id}`, { method: "DELETE" });
}

export function getPipelineHealth(): Promise<PipelineHealth> {
  return fetchJson<PipelineHealth>(`/api/v1/monitoring/pipeline`);
}

// ── plain words shared by the pages ─────────────────────────────────────────

export const METRIC_LABEL: Record<MonitorMetric, string> = {
  cpu: "CPU usage",
  mem: "Memory used",
  disk: "Any fixed disk used",
  net_rx_mbps: "Network receive",
  net_tx_mbps: "Network send",
  disk_forecast_days: "Disk full forecast",
  no_data: "No data while on",
  disk_busy: "Disk activity",
  gw_ms: "Gateway latency",
  gw_loss: "Packet loss",
  service: "Services stopped",
  disk_health: "Disk health",
  critical_events: "Critical events",
  reboot_pending_days: "Restart pending",
  security_score: "Security score",
};

export const METRIC_UNIT: Record<MonitorMetric, string> = {
  cpu: "%",
  mem: "%",
  disk: "%",
  net_rx_mbps: " Mb/s",
  net_tx_mbps: " Mb/s",
  disk_forecast_days: " days",
  no_data: "",
  disk_busy: "%",
  gw_ms: " ms",
  gw_loss: "%",
  service: "",
  disk_health: "",
  critical_events: "",
  reboot_pending_days: " days",
  security_score: "",
};

export function formatDuration(seconds: number): string {
  if (!seconds) return "now";
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${+(seconds / 3600).toFixed(1)} h`;
  return `${+(seconds / 86400).toFixed(1)} d`;
}

/** Bytes per second as "12 MB/s". */
export function formatBytesRate(bps: number | null | undefined): string {
  if (bps == null) return "—";
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} GB/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kB/s`;
  return `${Math.round(bps)} B/s`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1) return "<1 ms";
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

export function formatBits(bps: number | null | undefined): string {
  if (bps == null) return "—";
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gb/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mb/s`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kb/s`;
  return `${Math.round(bps)} b/s`;
}
