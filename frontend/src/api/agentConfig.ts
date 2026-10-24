import { fetchJson, fetchText } from "./client";

export interface AgentConfig {
  heartbeat_interval_seconds: number;
  platform_heartbeat_intervals: Record<string, number>;
  platform_inventory_intervals: Record<string, number>;
  online_threshold_minutes: number;
  stale_threshold_minutes: number;
  remote_support_managed_password_enabled: boolean;
  /** Whether agents collect installed software, per platform (agent 2.1.42). */
  platform_collect_software?: Record<string, boolean>;
  /** Capacity context and the limits the PUT enforces. */
  active_device_count: number;
  projected_requests_per_second: number;
  minimum_allowed_interval_seconds: number;
  maximum_allowed_interval_seconds: number;
  platform_minimum_intervals: Record<string, number>;
}

export interface AgentConfigUpdate {
  heartbeat_interval_seconds?: number;
  platform_heartbeat_intervals?: Record<string, number>;
  platform_inventory_intervals?: Record<string, number>;
  remote_support_managed_password_enabled?: boolean;
  platform_collect_software?: Record<string, boolean>;
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
  return fetchText(`/api/v1/agent-config/heartbeat-script?seconds=${seconds}`);
}
