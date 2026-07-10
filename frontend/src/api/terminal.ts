import { fetchJson } from "./client";

export interface TerminalSession {
  session_id: string;
  operator_ws_path: string; // wss://…/ws/terminal/{id}?ticket=…
  operator_ticket: string;
  expires_in_seconds: number;
}

// Create a Web Terminal session for a device (Platform Expansion Phase 5).
// 404 when FEATURE_TERMINAL is off or the device lacks the terminal capability.
export async function createTerminalSession(
  deviceId: number,
  engine: "bash" | "sh" = "bash",
): Promise<TerminalSession> {
  return fetchJson<TerminalSession>(`/api/v1/devices/${deviceId}/terminal/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine }),
  });
}

// ── Embedded SSH Connect ────────────────────────────────────────────────
// Reuses the exact same session/relay/watchdog stack above — the operator
// side still connects over `operator_ws_path` with the plain DeviceTerminal
// component. The only difference is what creates the session server-side
// (the backend dials the SSH connection itself; see app/services/
// ssh_connector.py) and what the session displays (device/client/operator/
// username/auth source — see SSHSessionDetail below).

export interface SSHCredentialCandidate {
  id: number;
  name: string;
  username: string | null;
  credential_type: string;
}

export interface SSHCredentialsResponse {
  tier: "device" | "group" | "client" | "global" | "none";
  candidates: SSHCredentialCandidate[];
}

// Step 1: resolve Vault candidates (Device > Group > Client > Global).
export async function getSshCredentialCandidates(deviceId: number): Promise<SSHCredentialsResponse> {
  return fetchJson<SSHCredentialsResponse>(`/api/v1/devices/${deviceId}/ssh/credentials`);
}

export interface SSHSessionCreateOptions {
  credentialId?: number;
  temporaryUsername?: string;
  temporaryPassword?: string;
}

export interface SSHSession extends TerminalSession {
  ssh_username: string;
  credential_source: "device" | "group" | "client" | "global" | "temporary";
}

// Step 2: create the session. Never guesses credentials — pass exactly one
// of credentialId (a resolved candidate) or a temporary username/password
// (only when the operator explicitly chose "Temporary Session").
export async function createSshTerminalSession(
  deviceId: number,
  options: SSHSessionCreateOptions = {},
): Promise<SSHSession> {
  return fetchJson<SSHSession>(`/api/v1/devices/${deviceId}/ssh/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      credential_id: options.credentialId ?? null,
      temporary_username: options.temporaryUsername ?? null,
      temporary_password: options.temporaryPassword ?? null,
    }),
  });
}

export interface SSHSessionDetail {
  session_id: string;
  device_id: number;
  device_hostname: string | null;
  client_id: number | null;
  client_name: string | null;
  operator_username: string | null;
  ssh_username: string | null;
  credential_source: string | null;
  status: "pending" | "active" | "closed" | "expired" | "failed";
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number;
  idle_seconds: number | null;
  disconnect_reason: string | null;
}

// Feeds the session info panel (device/client/operator/username/auth
// source/start/duration/status) and, on failure, the precise reason
// (credential_missing/host_unreachable/authentication_failed/timeout/
// host_key_mismatch/connection_refused/network_error).
export async function getSshSessionDetail(deviceId: number, sessionId: string): Promise<SSHSessionDetail> {
  return fetchJson<SSHSessionDetail>(`/api/v1/devices/${deviceId}/ssh/sessions/${sessionId}`);
}

// Human-readable text for every SSHConnectError reason the backend can
// report (app/services/ssh_connector.py) — shown instead of a generic
// "connection closed" message whenever the session ended abnormally.
export const SSH_FAILURE_MESSAGES: Record<string, string> = {
  credential_missing: "No usable SSH credential is configured for this device.",
  host_unreachable: "The device could not be reached at its current IP address.",
  authentication_failed: "Authentication failed — check the credential's username/password or key.",
  timeout: "The connection attempt timed out.",
  host_key_mismatch: "The device's SSH host key could not be verified.",
  connection_refused: "Connection refused — is SSH running on the device?",
  network_error: "A network error occurred while connecting.",
};
