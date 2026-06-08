import { fetchJson } from "./client";

export type ActionStatus =
  | "queued"
  | "sent"
  | "acknowledged"
  | "running"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled";

export type ActionType =
  | "ping"
  | "restart_device"
  | "refresh_inventory"
  | "restart_agent"
  | "sync_rustdesk"
  | "restart_rustdesk"
  | "reinstall_rustdesk"
  | "reopen_rustdesk"
  | "repair_config_rustdesk"
  | "sync_inventory"
  | "immediate_heartbeat"
  | "apply_power_policy";

export const ACTION_LABELS: Record<ActionType, string> = {
  ping: "Ping",
  restart_device: "Restart Device",
  refresh_inventory: "Refresh Inventory",
  restart_agent: "Restart Agent",
  sync_rustdesk: "Sync TECHI Remote Support",
  restart_rustdesk: "Restart TECHI Remote Support",
  reinstall_rustdesk: "Reinstall TECHI Remote Support",
  reopen_rustdesk: "Reopen TECHI Remote Support",
  repair_config_rustdesk: "Repair TECHI Remote Support Config",
  sync_inventory: "Sync Inventory",
  immediate_heartbeat: "Immediate Heartbeat",
  apply_power_policy: "Apply Power Policy",
};

export const ACTION_STATUS_LABELS: Record<ActionStatus, string> = {
  queued: "Queued",
  sent: "Sent",
  acknowledged: "Acknowledged",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  expired: "Expired",
  cancelled: "Cancelled",
};

// Actions that require a destructive confirmation before queuing.
export const DESTRUCTIVE_ACTIONS = new Set<ActionType>(["restart_device", "restart_agent", "reinstall_rustdesk"]);

// Actions that are Windows-agent-only.
export const WINDOWS_ONLY_ACTIONS = new Set<ActionType>([
  "sync_rustdesk",
  "restart_rustdesk",
  "reinstall_rustdesk",
  "reopen_rustdesk",
  "repair_config_rustdesk",
  "apply_power_policy",
]);

export interface RemoteAction {
  id: number;
  device_id: number;
  action_type: ActionType;
  parameters?: Record<string, unknown> | null;
  status: ActionStatus;
  created_at: string;
  created_by?: string | null;
  queued_at?: string | null;
  sent_at?: string | null;
  acknowledged_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
  cancelled_at?: string | null;
  expired_at?: string | null;
  result_message?: string | null;
  error_message?: string | null;
  output?: string | null;
  stderr_output?: string | null;
  execution_timeout_seconds: number;
  duration_seconds?: number | null;
}

export interface RemoteActionWithDevice extends RemoteAction {
  device_hostname?: string | null;
}

export interface ActionStatusStats {
  queued: number;
  sent: number;
  acknowledged: number;
  running: number;
  completed: number;
  failed: number;
  expired: number;
  cancelled: number;
  total: number;
}

export interface QueueActionPayload {
  action_type: ActionType;
  parameters?: Record<string, unknown> | null;
  created_by?: string | null;
  execution_timeout_seconds?: number;
}

export async function queueDeviceAction(deviceId: number, payload: QueueActionPayload): Promise<RemoteAction> {
  return fetchJson<RemoteAction>(`/api/v1/devices/${deviceId}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getDeviceActions(
  deviceId: number,
  limit = 30,
  status?: string,
): Promise<RemoteAction[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set("status", status);
  return fetchJson<RemoteAction[]>(`/api/v1/devices/${deviceId}/actions?${params}`);
}

export async function getDeviceActionStats(deviceId: number): Promise<ActionStatusStats> {
  return fetchJson<ActionStatusStats>(`/api/v1/devices/${deviceId}/actions/stats`);
}

export async function cancelAction(actionId: number): Promise<RemoteAction> {
  return fetchJson<RemoteAction>(`/api/v1/actions/${actionId}/cancel`, { method: "POST" });
}

export async function retryAction(actionId: number): Promise<RemoteAction> {
  return fetchJson<RemoteAction>(`/api/v1/actions/${actionId}/retry`, { method: "POST" });
}

export async function getRecentActions(limit = 20): Promise<RemoteActionWithDevice[]> {
  return fetchJson<RemoteActionWithDevice[]>(`/api/v1/actions/recent?limit=${limit}`);
}

export function isTerminalStatus(status: ActionStatus): boolean {
  return ["completed", "failed", "expired", "cancelled"].includes(status);
}

export function isActiveStatus(status: ActionStatus): boolean {
  return ["queued", "sent", "acknowledged", "running"].includes(status);
}

export function statusColor(status: ActionStatus): string {
  switch (status) {
    case "completed": return "text-emerald-400";
    case "failed": return "text-red-400";
    case "expired": return "text-slate-500";
    case "cancelled": return "text-slate-500";
    case "running": return "text-sky-400";
    case "acknowledged": return "text-sky-300";
    case "sent": return "text-amber-400";
    case "queued": return "text-amber-300";
    default: return "text-slate-400";
  }
}

export function statusDotColor(status: ActionStatus): string {
  switch (status) {
    case "completed": return "bg-emerald-400";
    case "failed": return "bg-red-400";
    case "running": return "bg-sky-400 shadow-[0_0_4px_rgba(56,189,248,0.6)]";
    case "sent": case "acknowledged": return "bg-amber-400";
    case "queued": return "bg-amber-300";
    default: return "bg-slate-600";
  }
}
