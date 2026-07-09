import { API_BASE_URL, fetchJson, getAuthToken } from "./client";

export interface AgentConfig {
  heartbeat_interval_seconds: number;
  platform_heartbeat_intervals: Record<string, number>;
  platform_inventory_intervals: Record<string, number>;
  online_threshold_minutes: number;
  stale_threshold_minutes: number;
  remote_support_managed_password_enabled: boolean;
}

export interface AgentConfigUpdate {
  heartbeat_interval_seconds?: number;
  platform_heartbeat_intervals?: Record<string, number>;
  platform_inventory_intervals?: Record<string, number>;
  remote_support_managed_password_enabled?: boolean;
}

export async function getAgentConfig(): Promise<AgentConfig> {
  return fetchJson<AgentConfig>("/api/v1/agent-config");
}

export async function putAgentConfig(update: AgentConfigUpdate): Promise<AgentConfig> {
  return fetchJson<AgentConfig>("/api/v1/agent-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
}

export async function getHeartbeatScript(seconds: number): Promise<string> {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE_URL}/api/v1/agent-config/heartbeat-script?seconds=${seconds}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(await res.text());
  return res.text();
}
