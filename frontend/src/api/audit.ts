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

export interface AuditFacet {
  value: string;
  count: number;
}

export interface AuditFacets {
  actions: AuditFacet[];
  entity_types: AuditFacet[];
  operators: AuditFacet[];
}

/** What the log actually holds, with counts — the source for the filters. */
export async function getAuditFacets(): Promise<AuditFacets> {
  return fetchJson<AuditFacets>("/api/v1/audit/facets");
}

export const ACTION_LABELS: Record<string, string> = {
  remote_connect: "Remote connect",
  terminal_session_opened: "Terminal opened",
  terminal_session_closed: "Terminal closed",
  terminal_session_denied: "Terminal denied",
  terminal_session_expired: "Terminal expired",
  ssh_session_started: "SSH session started",
  ssh_session_ended: "SSH session ended",
  ssh_connection_failed: "SSH connection failed",
  ssh_credential_resolved: "SSH credential used",
  enrollment_token_deployment_viewed: "Token commands viewed",
  enrollment_token_updated: "Token updated",
  enrollment_token_deleted: "Token deleted",
  enrollment_token_regenerated: "Token regenerated",
  bootstrap_script_served: "Bootstrap served",
  agent_package_activated: "Package activated",
  agent_package_deactivated: "Package deactivated",
  agent_package_deleted: "Package deleted",
  report_generated: "Report generated",
  report_downloaded: "Report downloaded",
  report_run_deleted: "Report deleted",
  team_updated: "Team updated",
  team_access_updated: "Team access updated",
  team_member_added: "Team member added",
  device_deleted: "Device deleted",
  nightly_cleanup: "Nightly cleanup",
  login: "Login",
  operator_created: "Operator created",
  operator_updated: "Operator updated",
  operator_deleted: "Operator deleted",
  operator_password_reset: "Password reset",
  device_archived: "Device archived",
  device_restored: "Device restored",
  maintenance_entered: "Maintenance started",
  maintenance_cleared: "Maintenance cleared",
  note_created: "Note created",
  note_updated: "Note updated",
  note_deleted: "Note deleted",
  action_queued: "Action queued",
  action_cancelled: "Action cancelled",
  action_retried: "Action retried",
  scope_entry_added: "Scope added",
  scope_entry_removed: "Scope removed",
  scope_replaced: "Scope replaced",
};

export const ENTITY_TYPE_LABELS: Record<string, string> = {
  operator: "Operator",
  device: "Device",
  remote_action: "Remote action",
  terminal_session: "Terminal session",
  enrollment_token: "Enrollment token",
  vault_credential: "Vault credential",
  agent_package: "Agent package",
  team: "Team",
  report_run: "Report",
  report_schedule: "Report schedule",
  bootstrap: "Bootstrap",
};
