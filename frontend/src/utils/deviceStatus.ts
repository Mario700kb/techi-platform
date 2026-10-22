import { deviceFreshness, type PresenceFields } from "./devicePresence";

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
export function remoteSupportStatus(device: {
  rustdesk_status?: string | null;
  rustdesk_install_status?: string | null;
}): StatusView {
  const install = (device.rustdesk_install_status ?? "").toLowerCase();
  const status = (device.rustdesk_status ?? "").toLowerCase();
  if (["not_installed", "not installed", "missing", "absent"].includes(install))
    return { label: "Not installed", tone: TONE.neutral };
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

/** Offline (not stale) now. Connect stays enabled: the operator decides. */
export function isDeviceOffline(device: PresenceFields): boolean {
  return deviceFreshness(device) === "offline";
}

// Production bug fix (Device Catalog Connect button): this row action used
// to be RustDesk-only (`isValidRustDeskId` + no conflict) regardless of
// platform, so every non-Windows device — which never has a rustdesk_id —
// showed a permanently grey Connect button with no explanation, even though
// those devices have real Connect Framework methods (SSH/Winbox/WebFig/
// Terminal) available in the Drawer. Platforms whose Connect Framework
// entry declares at least one capability=None (native, always-present)
// method never need a reported capability to be connectable; Linux (and any
// future capability-gated platform) needs at least one reported capability.
// This is a structural/cheap check — NOT a live credential-aware status
// (that would need one API call per row across a ~700-device table); the
// accurate, credential-aware ConnectMenu is what opens when the operator
// gets to the Drawer.
const PLATFORMS_WITH_ALWAYS_PRESENT_NATIVE_METHOD = new Set([
  "mikrotik",
  "synology",
  "qnap",
  "vmware",
  "proxmox",
  "hyperv",
]);

export function hasStructuralConnectMethod(device: {
  platform?: string | null;
  capabilities?: Record<string, unknown> | null;
}): boolean {
  const platform = (device.platform || "windows").toLowerCase();
  if (platform === "windows") return false; // Windows uses the RustDesk-specific check instead.
  if (PLATFORMS_WITH_ALWAYS_PRESENT_NATIVE_METHOD.has(platform)) return true;
  return Object.keys(device.capabilities || {}).length > 0;
}

// Realtime events that carry a device's new fields: a screen showing that
// device merges them in place instead of reloading.
export const DEVICE_PATCH_EVENTS: ReadonlySet<string> = new Set([
  "device_online",
  "device_offline",
  "device_updated",
  "heartbeat_received",
  "rustdesk_updated",
  "rustdesk_online",
  "rustdesk_offline",
  "sync_failed",
]);
