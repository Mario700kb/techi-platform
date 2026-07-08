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
