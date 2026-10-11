import type { Alert } from "../types/alert";

export interface AlertDescription {
  /** One line that says what is wrong, without the device name. */
  summary: string;
  /** The measured value when the alert carries one ("83.3%", "3×"). */
  value: string | null;
}

const PERCENT = /(\d+(?:\.\d+)?)\s*%/;
const TIMES = /(\d+)\s*×/;

const METRIC_NAME: Partial<Record<Alert["kind"], string>> = {
  high_cpu: "CPU usage",
  high_ram: "Memory usage",
  low_disk: "Disk usage",
};

// The stored message embeds the hostname the device had when the alert
// opened ("RAM elevated on DESKTOP-098OMH1: 81.0%"), which goes stale when
// the device is renamed. The table shows the device in its own column, so the
// alert itself is described without it, and its value gets a column of its own.
export function describeAlert(alert: Alert): AlertDescription {
  const metric = METRIC_NAME[alert.kind];
  if (metric) {
    const match = PERCENT.exec(alert.message);
    return {
      summary: `${metric} ${alert.severity === "critical" ? "critical" : "elevated"}`,
      value: match ? `${match[1]}%` : null,
    };
  }
  switch (alert.kind) {
    case "device_offline":
      return { summary: "Stopped sending heartbeats", value: null };
    case "heartbeat_stale":
      return { summary: "Heartbeats arriving late", value: null };
    case "telemetry_missing":
      return { summary: "No telemetry received", value: null };
    case "repeated_reconnects": {
      const match = TIMES.exec(alert.message);
      return { summary: "Connection keeps dropping", value: match ? `${match[1]}×` : null };
    }
    case "rustdesk_sync_failure":
      return { summary: alert.detail?.trim() || "Remote Support could not sync", value: null };
    default:
      return { summary: alert.detail?.trim() || alert.message, value: null };
  }
}
