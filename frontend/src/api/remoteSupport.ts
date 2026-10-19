import { fetchJson } from "./client";

export type RemoteSupportStatus = "online" | "warning" | "offline";

export interface RemoteSupportDevice {
  device_id: number;
  hostname?: string;
  current_user?: string;
  domain?: string;
  techi_remote_id?: string;
  public_ip?: string;
  local_ip?: string;
  platform?: string;
  device_type?: string;
  remote_support_status: RemoteSupportStatus;
  service_status: string;
  install_status: string;
  last_seen?: string;
  app_version?: string;
  install_path?: string;
  repair_count: number;
  last_repair_at?: string;
  client_id?: number;
  group_id?: number;
}

export interface ConnectUrlResponse {
  device_id: number;
  techi_remote_id: string;
  connect_url: string;
}

export async function getRemoteSupportDevice(deviceId: number): Promise<RemoteSupportDevice> {
  return fetchJson<RemoteSupportDevice>(`/api/v1/remote-support/devices/${deviceId}`);
}

export async function getConnectUrl(deviceId: number): Promise<ConnectUrlResponse> {
  return fetchJson<ConnectUrlResponse>(`/api/v1/remote-support/devices/${deviceId}/connect-url`);
}

export interface RemoteSupportPasswordResponse {
  device_id: number;
  password: string;
  source?: string | null;
  updated_at?: string | null;
}

export async function getRemoteSupportPassword(deviceId: number): Promise<RemoteSupportPasswordResponse> {
  return fetchJson<RemoteSupportPasswordResponse>(`/api/v1/remote-support/devices/${deviceId}/password`);
}

export async function setRemoteSupportPassword(
  deviceId: number,
  password: string,
): Promise<RemoteSupportPasswordResponse> {
  return fetchJson<RemoteSupportPasswordResponse>(`/api/v1/remote-support/devices/${deviceId}/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

export async function regenerateRemoteSupportPassword(deviceId: number): Promise<RemoteSupportPasswordResponse> {
  return fetchJson<RemoteSupportPasswordResponse>(`/api/v1/remote-support/devices/${deviceId}/password/regenerate`, {
    method: "POST",
  });
}

export interface RemoteSupportPasswordStatus {
  rotation_days: number;
  per_device: number;
  legacy_shared: number;
  oldest_changed_at: string | null;
}

/** Owner/admin: how the fleet's Remote Support passwords stand. */
export async function getRemoteSupportPasswordStatus(): Promise<RemoteSupportPasswordStatus> {
  return fetchJson<RemoteSupportPasswordStatus>("/api/v1/remote-support/passwords/status");
}

/** Owner/admin: a new per-device password for every device, applied on its next heartbeat. */
export async function rotateAllRemoteSupportPasswords(): Promise<{ rotated: number }> {
  return fetchJson<{ rotated: number }>("/api/v1/remote-support/passwords/rotate-all", { method: "POST" });
}

// ── Remote Support identity: what each client reports about itself ────────

export interface RemoteSupportClient {
  id: number;
  rustdesk_id: string;
  machine_guid: string | null;
  hostname: string | null;
  username: string | null;
  os: string | null;
  version: string | null;
  source_ip: string | null;
  device_id: number | null;
  device_name: string | null;
  device_rustdesk_id: string | null;
  bound_by: string | null;
  first_seen_at: string;
  last_seen_at: string;
  note: string | null;
}

export interface RemoteSupportIdentitySummary {
  devices_with_id: number;
  confirmed_24h: number;
  unbound_clients_24h: number;
  attention_24h: number;
  agent_disagrees: number;
}

export function getRemoteSupportIdentitySummary(): Promise<RemoteSupportIdentitySummary> {
  return fetchJson<RemoteSupportIdentitySummary>("/api/v1/remote-support/identity/summary");
}

export function getRemoteSupportClients(
  state: "attention" | "unbound" | "all" = "attention",
): Promise<RemoteSupportClient[]> {
  return fetchJson<RemoteSupportClient[]>(`/api/v1/remote-support/identity/clients?state=${state}`);
}

export function bindRemoteSupportClient(clientRowId: number, deviceId: number): Promise<RemoteSupportClient> {
  return fetchJson<RemoteSupportClient>(`/api/v1/remote-support/identity/clients/${clientRowId}/bind`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId }),
  });
}
