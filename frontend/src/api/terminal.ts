import { ApiError, fetchJson, fetchText } from "./client";

export interface TerminalSession {
  session_id: string;
  operator_ws_path: string; // wss://…/ws/terminal/{id}?ticket=…
  operator_ticket: string;
  expires_in_seconds: number;
  /** "command": Windows without a pseudo console (Server 2012 R2 / 2016);
   *  each command runs on its own, no socket. */
  mode?: "console" | "command";
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

// ── Administrator PowerShell (Windows, agent 2.1.29+) ───────────────────
// Same session/relay stack; the platform opens it only with a current
// two-factor code and records everything the console shows.

export class PowerShellStepUpError extends Error {
  constructor(
    public code: "mfa_not_enabled" | "mfa_invalid",
    message: string,
  ) {
    super(message);
  }
}

// The administrator console of a device: PowerShell as SYSTEM on Windows,
// a root shell on Linux. Both open only with a current two-factor code.
export type ConsoleKind = "powershell" | "linux";

export async function createPowerShellSession(
  deviceId: number,
  mfaCode: string,
  kind: ConsoleKind = "powershell",
): Promise<TerminalSession> {
  try {
    return await fetchJson<TerminalSession>(`/api/v1/devices/${deviceId}/terminal/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: kind === "linux" ? "bash" : "powershell", mfa_code: mfaCode }),
    });
  } catch (err) {
    if (err instanceof ApiError && (err.code === "mfa_not_enabled" || err.code === "mfa_invalid")) {
      throw new PowerShellStepUpError(err.code, err.message);
    }
    throw err;
  }
}

export interface ConsoleSessionSummary {
  session_id: string;
  engine: string;
  operator_username: string | null;
  status: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  disconnect_reason: string | null;
  recording_bytes: number | null;
  mode?: "agent" | "command";
}

// ── PowerShell in command mode ─────────────────────────────────────────
// Windows without a pseudo console: a command at a time, as a run_powershell
// action; the folder the last one ended in is sent with the next.

export interface CommandModeResult {
  action_id: number;
  status: string;
  done: boolean;
  output: string;
  stderr: string | null;
  error: string | null;
  failed: boolean | null;
  duration_ms: number | null;
  cwd: string | null;
  truncated: boolean;
}

export async function runCommandModeCommand(
  deviceId: number,
  sessionId: string,
  command: string,
  cwd: string | null,
): Promise<{ action_id: number }> {
  return fetchJson(`/api/v1/devices/${deviceId}/terminal/sessions/${sessionId}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, cwd, timeout_seconds: 300 }),
  });
}

export async function getCommandModeResult(
  deviceId: number,
  sessionId: string,
  actionId: number,
): Promise<CommandModeResult> {
  return fetchJson<CommandModeResult>(
    `/api/v1/devices/${deviceId}/terminal/sessions/${sessionId}/commands/${actionId}`,
  );
}

export async function closeCommandModeSession(deviceId: number, sessionId: string): Promise<void> {
  await fetchJson<void>(`/api/v1/devices/${deviceId}/terminal/sessions/${sessionId}/close`, { method: "POST" });
}

export async function listConsoleSessions(deviceId: number, limit = 20): Promise<ConsoleSessionSummary[]> {
  return fetchJson<ConsoleSessionSummary[]>(`/api/v1/devices/${deviceId}/terminal/sessions?limit=${limit}`);
}

// The asciicast recording (one JSON header line, then [seconds, "o"|"r", text]).
export async function getConsoleRecording(deviceId: number, sessionId: string): Promise<string> {
  return fetchText(`/api/v1/devices/${deviceId}/terminal/sessions/${sessionId}/recording`);
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

// ── Saved PowerShell scripts (administrator console) ────────────────────

export interface ConsoleScriptBody {
  name: string;
  description?: string | null;
  body: string;
}

export interface ConsoleScript extends ConsoleScriptBody {
  id: number;
  version: number;
  uses: number;
  last_used_at: string | null;
  updated_by: string | null;
  updated_at: string;
}

export async function listConsoleScripts(): Promise<ConsoleScript[]> {
  return fetchJson<ConsoleScript[]>(`/api/v1/console/scripts`);
}

export async function createConsoleScript(body: ConsoleScriptBody): Promise<ConsoleScript> {
  return fetchJson<ConsoleScript>(`/api/v1/console/scripts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function updateConsoleScript(id: number, body: ConsoleScriptBody): Promise<ConsoleScript> {
  return fetchJson<ConsoleScript>(`/api/v1/console/scripts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteConsoleScript(id: number): Promise<void> {
  return fetchJson<void>(`/api/v1/console/scripts/${id}`, { method: "DELETE" });
}

// Audited on the platform; returns the one line to type into the open console.
export async function runConsoleScript(
  deviceId: number,
  sessionId: string,
  scriptId: number,
): Promise<{ command: string; script: ConsoleScript }> {
  return fetchJson<{ command: string; script: ConsoleScript }>(
    `/api/v1/devices/${deviceId}/terminal/sessions/${sessionId}/scripts/${scriptId}`,
    { method: "POST" },
  );
}
