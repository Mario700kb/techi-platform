// One vocabulary for how device state is named and coloured, shared by the
// Devices table, the mobile cards, both device drawers and the Dashboard, so
// the same state never reads or looks different from one screen to the next.

export const TONE = {
  online: "var(--th-status-online)",
  stale: "var(--th-status-stale)",
  offline: "var(--th-status-offline)",
  critical: "var(--th-status-critical)",
  warning: "var(--th-status-warning)",
  info: "var(--th-status-info)",
  maintenance: "var(--th-status-maint)",
  neutral: "var(--th-text-faint)",
} as const;

export const TERMS = {
  clientPc: "Client PC",
  clientPcs: "Client PCs",
  server: "Server",
  servers: "Servers",
  remoteSupport: "Remote Support",
  remoteSupportId: "Remote Support ID",
  agent: "TECHI agent",
  noClient: "No client",
  noGroup: "No group",
} as const;

// Mirrors backend/app/services/alert_rules.py, so a bar turns amber at the
// same value that opens an alert.
export const METRIC_THRESHOLDS = {
  cpu: { warn: 85, critical: 95 },
  ram: { warn: 90, critical: 95 },
  disk: { warn: 85, critical: 95 },
} as const;

export type Metric = keyof typeof METRIC_THRESHOLDS;

export function metricTone(metric: Metric, percent: number | null | undefined): string {
  if (percent == null) return TONE.neutral;
  const { warn, critical } = METRIC_THRESHOLDS[metric];
  if (percent >= critical) return TONE.critical;
  if (percent >= warn) return TONE.warning;
  return TONE.online;
}

/** "not_running" → "Not running". */
export function humanize(value: string): string {
  const text = value.replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Unknown";
}

export interface StatusView {
  label: string;
  tone: string;
}

/** Remote Support (RustDesk service) state, the same on every screen. */
export function remoteSupportStatus(device: { rustdesk_status?: string | null; rustdesk_install_status?: string | null }): StatusView {
  const install = (device.rustdesk_install_status ?? "").toLowerCase();
  const status = (device.rustdesk_status ?? "").toLowerCase();
  if (["not_installed", "not installed", "missing", "absent"].includes(install)) return { label: "Not installed", tone: TONE.neutral };
  if (status === "running") return { label: "Running", tone: TONE.online };
  if (["stopped", "not_running", "offline"].includes(status)) return { label: "Stopped", tone: TONE.warning };
  if (!status || status === "unknown") return { label: "Unknown", tone: TONE.neutral };
  return { label: humanize(status), tone: TONE.warning };
}

export function freshnessTone(state: string | null | undefined): string {
  if (state === "online") return TONE.online;
  if (state === "stale") return TONE.stale;
  return TONE.offline;
}
