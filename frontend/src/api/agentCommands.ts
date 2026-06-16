import { fetchJson } from "./client";

export type BulkCommandTarget = "all" | "client" | "group" | "devices";

export type BulkCommandType =
  | "ping"
  | "restart_agent"
  | "restart_device"
  | "reboot_pc"
  | "collect_inventory"
  | "sync_rustdesk"
  | "restart_rustdesk"
  | "set_remote_password"
  | "change_heartbeat_interval"
  | "run_powershell"
  | "register_protocol";

export const BULK_COMMAND_LABELS: Record<BulkCommandType, string> = {
  ping: "Ping",
  restart_agent: "Restart Agent",
  restart_device: "Restart Device",
  reboot_pc: "Reboot PC",
  collect_inventory: "Collect Inventory",
  sync_rustdesk: "Sync TECHI Remote",
  restart_rustdesk: "Restart TECHI Remote",
  set_remote_password: "Set Remote Password",
  change_heartbeat_interval: "Change Heartbeat Interval",
  run_powershell: "Run PowerShell Script",
  register_protocol: "Register Protocol",
};

export const BULK_COMMAND_TYPES: BulkCommandType[] = [
  "ping",
  "restart_agent",
  "restart_device",
  "reboot_pc",
  "collect_inventory",
  "sync_rustdesk",
  "restart_rustdesk",
  "set_remote_password",
  "change_heartbeat_interval",
  "run_powershell",
  "register_protocol",
];

/** Commands that require a destructive confirmation dialog (2-step for reboot_pc) */
export const DESTRUCTIVE_BULK_COMMANDS = new Set<BulkCommandType>([
  "restart_device",
  "restart_agent",
  "reboot_pc",
  "run_powershell",
]);

/** Commands that require a hard 2-step confirmation (type device count) */
export const TWO_STEP_CONFIRM_COMMANDS = new Set<BulkCommandType>(["reboot_pc"]);

/** Commands only available to admin/owner */
export const ADMIN_ONLY_BULK_COMMANDS = new Set<BulkCommandType>([
  "set_remote_password",
  "reboot_pc",
  "run_powershell",
]);

/** Commands only available to owner */
export const OWNER_ONLY_BULK_COMMANDS = new Set<BulkCommandType>(["run_powershell"]);

export type CommandStatus = "queued" | "delivered" | "executing" | "completed" | "failed" | "timeout";

export interface BulkCommandCreate {
  command_type: BulkCommandType;
  payload?: Record<string, unknown>;
  target: BulkCommandTarget;
  client_id?: number;
  group_id?: number;
  device_ids?: number[];
  timeout_seconds?: number;
}

export interface BatchCreateResponse {
  batch_id: string;
  device_count: number;
  created_at: string;
}

export interface DeviceCommandStatus {
  device_id: number;
  hostname: string | null;
  status: CommandStatus;
  output: string | null;
  error: string | null;
}

export interface BatchProgressResponse {
  batch_id: string;
  command_type: string;
  total: number;
  queued: number;
  delivered: number;
  executing: number;
  completed: number;
  failed: number;
  timeout: number;
  percent: number;
  devices: DeviceCommandStatus[];
  created_at: string;
  finished: boolean;
}

export interface BatchSummary {
  batch_id: string;
  command_type: string;
  target: string;
  total: number;
  completed: number;
  failed: number;
  timeout: number;
  finished: boolean;
  created_at: string;
}

export async function sendBulkCommand(payload: BulkCommandCreate): Promise<BatchCreateResponse> {
  return fetchJson<BatchCreateResponse>("/api/v1/commands/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getBatchProgress(batchId: string): Promise<BatchProgressResponse> {
  return fetchJson<BatchProgressResponse>(`/api/v1/commands/${batchId}/progress`);
}

export async function getCommandHistory(limit = 20, skip = 0): Promise<BatchSummary[]> {
  return fetchJson<BatchSummary[]>(`/api/v1/commands/history?limit=${limit}&skip=${skip}`);
}

export async function cancelBatch(batchId: string): Promise<{ cancelled: number }> {
  return fetchJson<{ cancelled: number }>(`/api/v1/commands/${batchId}`, { method: "DELETE" });
}

export function commandStatusColor(status: CommandStatus): string {
  switch (status) {
    case "completed": return "text-emerald-400";
    case "failed": return "text-red-400";
    case "timeout": return "text-slate-500";
    case "executing": return "text-sky-400";
    case "delivered": return "text-amber-400";
    case "queued": return "text-amber-300";
    default: return "text-slate-400";
  }
}

export function commandStatusDot(status: CommandStatus): string {
  switch (status) {
    case "completed": return "bg-emerald-400";
    case "failed": return "bg-red-400";
    case "executing": return "bg-sky-400 shadow-[0_0_4px_rgba(56,189,248,0.6)]";
    case "delivered": return "bg-amber-400";
    case "queued": return "bg-amber-300";
    case "timeout": return "bg-slate-500";
    default: return "bg-slate-600";
  }
}

export const COMMAND_STATUS_LABELS: Record<CommandStatus, string> = {
  queued: "Queued",
  delivered: "Delivered",
  executing: "Executing",
  completed: "Completed",
  failed: "Failed",
  timeout: "Timeout",
};
