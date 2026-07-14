import type { Device } from "../api/devices";
import { isValidRustDeskId } from "./rustdeskLaunch";

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
  severity: "healthy" | "neutral" | "warning" | "error";
}

const PRESENTATION: Record<RemoteSupportTrustedState, Omit<RemoteSupportPresentation, "state">> = {
  healthy: { label: "Running", detail: "Authenticated Agent reports Remote Support is usable.", severity: "healthy" },
  installed_running: { label: "Running", detail: "Authenticated Agent reports Remote Support is usable.", severity: "healthy" },
  installed_stopped: { label: "Stopped", detail: "Remote Support is installed but its runtime is stopped.", severity: "warning" },
  missing: { label: "Missing", detail: "A fresh authenticated heartbeat reports Remote Support is absent.", severity: "error" },
  damaged: { label: "Damaged", detail: "A fresh authenticated heartbeat reports a partial or stale installation.", severity: "error" },
  unknown: { label: "Status unavailable", detail: "No complete trusted Remote Support status is available yet.", severity: "neutral" },
  legacy_status_unavailable: { label: "Status unavailable", detail: "This legacy-restricted heartbeat updates liveness only; Remote Support state is not trusted.", severity: "neutral" },
  repair_pending: { label: "Repair pending", detail: "Remote Support repair is pending validation.", severity: "warning" },
  repair_failed: { label: "Repair failed", detail: "The last Remote Support repair did not validate successfully.", severity: "error" },
};

export function remoteSupportPresentation(device: Device): RemoteSupportPresentation {
  const raw = (device.remote_support_state || "unknown") as RemoteSupportTrustedState;
  const state = raw in PRESENTATION ? raw : "unknown";
  return { state, ...PRESENTATION[state] };
}

export function remoteSupportConnectAvailable(device: Device): boolean {
  return isValidRustDeskId(device.rustdesk_id) && !device.rustdesk_conflict_detected;
}
