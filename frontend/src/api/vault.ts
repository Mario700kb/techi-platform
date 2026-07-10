import { fetchJson } from "./client";

export type VaultCredentialType =
  | "password"
  | "ssh_key"
  | "api_token"
  | "snmp"
  | "winbox"
  | "certificate"
  | "ssh_password"
  | "ssh_private_key"
  | "windows_admin"
  | "webfig"
  | "smtp"
  | "webhook_secret"
  | "snmp_v2"
  | "snmp_v3"
  | "generic_username_password";

export type VaultScopeType = "global" | "client" | "group" | "device";
export type VaultCredentialStatus = "active" | "disabled";
export type VaultLifecycleStatus = "active" | "disabled" | "expiring_soon" | "expired" | "validation_failed";
export type VaultConsumerStatus = "stored_only" | "assigned_to_client" | "assigned_to_device" | "no_active_consumer";

export interface VaultFieldSpec {
  key: string;
  label: string;
  required: boolean;
  kind: "text" | "password" | "textarea" | "number" | "select";
  options: string[] | null;
  default: string | null;
  placeholder: string | null;
}

export interface VaultCredentialTypeDescriptor {
  id: VaultCredentialType;
  label: string;
  icon: string;
  category: "ssh" | "windows" | "network" | "api" | "notifications" | "snmp" | "generic";
  metadata_fields: VaultFieldSpec[];
  secret_fields: VaultFieldSpec[];
  requires_username: boolean;
  requires_secret: boolean;
  future_consumers: string[];
  legacy: boolean;
}

export interface VaultCredential {
  id: number;
  name: string;
  credential_type: VaultCredentialType;
  scope_type: VaultScopeType;
  client_id: number | null;
  group_id: number | null;
  device_id: number | null;
  purpose: string | null;
  username: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  rotated_at: string | null;
  last_used_at: string | null;
  status: VaultCredentialStatus;
  expires_at: string | null;
  rotation_due_at: string | null;
  last_tested_at: string | null;
  last_test_status: "success" | "failed" | null;
  credential_metadata: Record<string, string>;
  secret_hint: string | null;
  lifecycle_status: VaultLifecycleStatus;
  is_referenced: boolean;
  reference_count: number;
  references: string[];
  consumer_status: VaultConsumerStatus;
  future_consumers: string[];
  // Real, live usage — populated once a real connection (Embedded SSH
  // Connect) has actually authenticated with this credential, as opposed to
  // future_consumers (a static "meant for" hint). Optional so existing test
  // fixtures/mocks predating this field don't need updating.
  used_by?: string[];
}

export interface VaultCredentialCreate {
  name: string;
  credential_type: VaultCredentialType;
  scope_type?: VaultScopeType;
  client_id?: number | null;
  group_id?: number | null;
  device_id?: number | null;
  purpose?: string | null;
  username?: string | null;
  secret?: string;
  secret_fields?: Record<string, string>;
  metadata?: Record<string, string>;
  notes?: string | null;
  expires_at?: string | null;
  rotation_due_at?: string | null;
}

export interface VaultCredentialUpdate {
  name?: string;
  username?: string | null;
  purpose?: string | null;
  notes?: string | null;
  metadata?: Record<string, string>;
  expires_at?: string | null;
  rotation_due_at?: string | null;
  status?: VaultCredentialStatus;
  secret?: string;
  secret_fields?: Record<string, string>;
}

export interface VaultUsage {
  id: number;
  credential_id: number;
  operator_username: string | null;
  device_id: number | null;
  action: string;
  reason: string | null;
  created_at: string;
}

export interface VaultAssignment {
  id: number;
  credential_id: number;
  client_id: number | null;
  client_name: string | null;
  device_id: number | null;
  device_name: string | null;
  created_by: string | null;
  created_at: string;
}

export interface VaultTestResult {
  status: "success" | "failed" | "unsupported";
  message: string;
}

export async function listVaultCredentialTypes(): Promise<VaultCredentialTypeDescriptor[]> {
  return fetchJson<VaultCredentialTypeDescriptor[]>("/api/v1/vault/types");
}

export async function listVaultCredentials(): Promise<VaultCredential[]> {
  return fetchJson<VaultCredential[]>("/api/v1/vault");
}

export async function createVaultCredential(
  payload: VaultCredentialCreate,
): Promise<VaultCredential> {
  return fetchJson<VaultCredential>("/api/v1/vault", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateVaultCredential(
  id: number,
  payload: VaultCredentialUpdate,
): Promise<VaultCredential> {
  return fetchJson<VaultCredential>(`/api/v1/vault/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function setVaultCredentialStatus(
  id: number,
  status: VaultCredentialStatus,
): Promise<VaultCredential> {
  return fetchJson<VaultCredential>(`/api/v1/vault/${id}/status?status=${status}`, { method: "POST" });
}

export async function deleteVaultCredential(id: number, force = false): Promise<void> {
  const query = force ? "?force=true" : "";
  await fetchJson<void>(`/api/v1/vault/${id}${query}`, { method: "DELETE" });
}

export async function revealVaultCredential(
  id: number,
  reason: string,
): Promise<{ id: number; name: string; username: string | null; secret_fields: Record<string, string> }> {
  return fetchJson(`/api/v1/vault/${id}/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
}

export async function testVaultCredential(id: number): Promise<VaultTestResult> {
  return fetchJson<VaultTestResult>(`/api/v1/vault/${id}/test`, { method: "POST" });
}

export async function getVaultUsage(id: number): Promise<VaultUsage[]> {
  return fetchJson<VaultUsage[]>(`/api/v1/vault/${id}/usage`);
}

export async function listVaultAssignments(id: number): Promise<VaultAssignment[]> {
  return fetchJson<VaultAssignment[]>(`/api/v1/vault/${id}/assignments`);
}

export async function addVaultAssignment(
  id: number,
  payload: { client_id?: number | null; device_id?: number | null },
): Promise<VaultAssignment> {
  return fetchJson<VaultAssignment>(`/api/v1/vault/${id}/assignments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function removeVaultAssignment(id: number, assignmentId: number): Promise<void> {
  await fetchJson<void>(`/api/v1/vault/${id}/assignments/${assignmentId}`, { method: "DELETE" });
}
