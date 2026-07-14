import type { Device } from "../api/devices";

export type RemoteSupportTrustedState =
  | "healthy"
  | "installed_running"
  | "installed_stopped"
  | "missing"
  | "damaged"
  | "unknown"
  | "legacy_status_unavailable"
  | "repair_pending"
  | "repair_failed";

export interface RemoteSupportPresentation {
  state: RemoteSupportTrustedState;
  label: string;
  detail: string;
  connectAllowed: boolean;
  severity: "healthy" | "neutral" | "warning" | "error";
}

const PRESENTATION: Record<RemoteSupportTrustedState, Omit<RemoteSupportPresentation, "state">> = {
  healthy: { label: "Running", detail: "Authenticated Agent reports Remote Support is usable.", connectAllowed: true, severity: "healthy" },
  installed_running: { label: "Running", detail: "Authenticated Agent reports Remote Support is usable.", connectAllowed: true, severity: "healthy" },
  installed_stopped: { label: "Stopped", detail: "Remote Support is installed but its runtime is stopped.", connectAllowed: false, severity: "warning" },
  missing: { label: "Missing", detail: "A fresh authenticated heartbeat reports Remote Support is absent.", connectAllowed: false, severity: "error" },
  damaged: { label: "Damaged", detail: "A fresh authenticated heartbeat reports a partial or stale installation.", connectAllowed: false, severity: "error" },
  unknown: { label: "Status unavailable", detail: "No complete trusted Remote Support status is available yet.", connectAllowed: false, severity: "neutral" },
  legacy_status_unavailable: { label: "Status unavailable", detail: "This legacy-restricted heartbeat updates liveness only; Remote Support state is not trusted.", connectAllowed: false, severity: "neutral" },
  repair_pending: { label: "Repair pending", detail: "Remote Support repair is pending validation.", connectAllowed: false, severity: "warning" },
  repair_failed: { label: "Repair failed", detail: "The last Remote Support repair did not validate successfully.", connectAllowed: false, severity: "error" },
};

export function remoteSupportPresentation(device: Device): RemoteSupportPresentation {
  const raw = (device.remote_support_state || "unknown") as RemoteSupportTrustedState;
  const state = raw in PRESENTATION ? raw : "unknown";
  return { state, ...PRESENTATION[state] };
}
