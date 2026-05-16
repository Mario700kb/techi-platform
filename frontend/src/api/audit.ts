import { fetchJson } from "./client";

export interface AuditLogEntry {
  id: number;
  operator_id: number | null;
  operator_username: string | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  details_json: string | null;
  created_at: string;
}

export interface AuditLogPage {
  total: number;
  items: AuditLogEntry[];
}

export interface AuditFilters {
  operator_username?: string;
  action?: string;
  entity_type?: string;
  from_dt?: string;
  to_dt?: string;
  limit?: number;
  offset?: number;
}

export async function getAuditLogs(filters: AuditFilters = {}): Promise<AuditLogPage> {
  const params = new URLSearchParams();
  if (filters.operator_username) params.set("operator_username", filters.operator_username);
  if (filters.action) params.set("action", filters.action);
  if (filters.entity_type) params.set("entity_type", filters.entity_type);
  if (filters.from_dt) params.set("from_dt", filters.from_dt);
  if (filters.to_dt) params.set("to_dt", filters.to_dt);
  if (filters.limit != null) params.set("limit", String(filters.limit));
  if (filters.offset != null) params.set("offset", String(filters.offset));
  const qs = params.toString();
  return fetchJson<AuditLogPage>(`/api/v1/audit${qs ? `?${qs}` : ""}`);
}

export const ACTION_LABELS: Record<string, string> = {
  login: "Login",
  operator_created: "Operator Created",
  operator_updated: "Operator Updated",
  operator_deleted: "Operator Deleted",
  operator_password_reset: "Password Reset",
  device_archived: "Device Archived",
  device_restored: "Device Restored",
  maintenance_entered: "Maintenance Enter",
  maintenance_cleared: "Maintenance Clear",
  note_created: "Note Created",
  note_updated: "Note Updated",
  note_deleted: "Note Deleted",
  action_queued: "Action Queued",
  action_cancelled: "Action Cancelled",
  action_retried: "Action Retried",
  scope_entry_added: "Scope Added",
  scope_entry_removed: "Scope Removed",
  scope_replaced: "Scope Replaced",
};

export const ENTITY_TYPE_LABELS: Record<string, string> = {
  operator: "Operator",
  device: "Device",
  remote_action: "Remote Action",
};

export const ALL_ACTIONS = Object.keys(ACTION_LABELS);
export const ALL_ENTITY_TYPES = Object.keys(ENTITY_TYPE_LABELS);
