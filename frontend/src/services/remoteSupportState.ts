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

export interface RemoteSupportCredentialState {
  heartbeatAuthState?: string | null;
  applyStatus?: string | null;
  activeGeneration?: number | null;
  desiredGeneration?: number | null;
  appliedGeneration?: number | null;
  failureReason?: string | null;
}

export interface RemoteSupportCredentialPresentation {
  label: string;
  detail: string;
  severity: "neutral" | "warning" | "error" | "healthy";
}

export function remoteSupportCredentialRevealAvailable(state: Pick<
  RemoteSupportCredentialState,
  "applyStatus" | "activeGeneration" | "appliedGeneration"
>): boolean {
  const active = state.activeGeneration ?? 0;
  return active > 0 && active === (state.appliedGeneration ?? 0);
}

export function remoteSupportCredentialPresentation(
  state: RemoteSupportCredentialState,
): RemoteSupportCredentialPresentation {
  if (state.heartbeatAuthState === "legacy_restricted" || state.applyStatus === "unsupported_legacy") {
    return {
      label: "Credential unavailable until Agent authentication",
      detail: "Use ID-only Connect until this Agent authenticates.",
      severity: "neutral",
    };
  }
  if (state.applyStatus === "failed") {
    return {
      label: "Credential application failed",
      detail: state.failureReason || "The Agent reported an unspecified credential application failure.",
      severity: "error",
    };
  }
  if (state.applyStatus === "conflicted") {
    return {
      label: "Credential profiles conflicted",
      detail: state.failureReason || "Remote Support profiles do not agree on credential state.",
      severity: "error",
    };
  }
  const active = state.activeGeneration ?? 0;
  const desired = state.desiredGeneration ?? 0;
  const applied = state.appliedGeneration ?? 0;
  if (state.applyStatus === "pending" || desired > active) {
    return {
      label: "Credential pending application",
      detail: active > 0
        ? `Generation ${active} remains active while generation ${desired} is pending.`
        : `Generation ${desired || 1} is waiting for Agent acknowledgement.`,
      severity: "warning",
    };
  }
  if (state.applyStatus === "applied" && active > 0 && active === applied) {
    return {
      label: "Credential applied",
      detail: `Generation ${active} is confirmed by the Agent.`,
      severity: "healthy",
    };
  }
  return {
    label: "Preparing device credential",
    detail: "The next authenticated heartbeat will prepare this device's credential.",
    severity: "neutral",
  };
}
