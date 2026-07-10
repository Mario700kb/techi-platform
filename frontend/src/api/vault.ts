import { fetchJson } from "./client";

export type VaultCredentialType =
  | "password"
  | "ssh_key"
  | "api_token"
  | "snmp"
  | "winbox"
  | "certificate";

export type VaultScopeType = "global" | "client" | "group" | "device";

export interface VaultCredential {
  id: number;
  name: string;
  credential_type: VaultCredentialType;
  scope_type: VaultScopeType;
  client_id: number | null;
  group_id: number | null;
  device_id: number | null;
  username: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  rotated_at: string | null;
  last_used_at: string | null;
  secret_hint: string | null;
}

export interface VaultCredentialCreate {
  name: string;
  credential_type: VaultCredentialType;
  scope_type?: VaultScopeType;
  client_id?: number | null;
  group_id?: number | null;
  device_id?: number | null;
  username?: string | null;
  secret: string;
  notes?: string | null;
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

export async function deleteVaultCredential(id: number, force = false): Promise<void> {
  const query = force ? "?force=true" : "";
  await fetchJson<void>(`/api/v1/vault/${id}${query}`, { method: "DELETE" });
}

export async function revealVaultCredential(
  id: number,
  reason: string,
): Promise<{ id: number; name: string; username: string | null; secret: string }> {
  return fetchJson(`/api/v1/vault/${id}/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
}

export async function getVaultUsage(id: number): Promise<VaultUsage[]> {
  return fetchJson<VaultUsage[]>(`/api/v1/vault/${id}/usage`);
}
