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
  repair_attempt_count: number;
  repair_success_count: number;
  consecutive_repair_failures: number;
  last_repair_reason?: string;
  last_repair_at?: string;
  client_id?: number;
  group_id?: number;
}

export interface ConnectUrlResponse {
  device_id: number;
  techi_remote_id: string;
  connect_url: string;
}

export interface RemoteSupportFilters {
  status?: RemoteSupportStatus;
  domain?: string;
  search?: string;
  client_id?: number;
  group_id?: number;
  skip?: number;
  limit?: number;
}

export async function getRemoteSupportDevices(
  filters: RemoteSupportFilters = {}
): Promise<RemoteSupportDevice[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.domain) params.set("domain", filters.domain);
  if (filters.search) params.set("search", filters.search);
  if (filters.client_id != null) params.set("client_id", String(filters.client_id));
  if (filters.group_id != null) params.set("group_id", String(filters.group_id));
  if (filters.skip != null) params.set("skip", String(filters.skip));
  if (filters.limit != null) params.set("limit", String(filters.limit));
  const qs = params.toString();
  return fetchJson<RemoteSupportDevice[]>(`/api/v1/remote-support/devices${qs ? `?${qs}` : ""}`);
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
  password: string
): Promise<RemoteSupportPasswordResponse> {
  return fetchJson<RemoteSupportPasswordResponse>(`/api/v1/remote-support/devices/${deviceId}/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

export async function regenerateRemoteSupportPassword(
  deviceId: number
): Promise<RemoteSupportPasswordResponse> {
  return fetchJson<RemoteSupportPasswordResponse>(
    `/api/v1/remote-support/devices/${deviceId}/password/regenerate`,
    { method: "POST" }
  );
}

export async function restartRemoteSupportService(deviceId: number): Promise<void> {
  await fetchJson(`/api/v1/remote-support/devices/${deviceId}/restart-service`, { method: "POST" });
}

export async function repairRemoteSupportConfig(deviceId: number): Promise<void> {
  await fetchJson(`/api/v1/remote-support/devices/${deviceId}/repair-config`, { method: "POST" });
}

export async function deployRemoteSupport(deviceId: number, forceReinstall = false): Promise<void> {
  const qs = forceReinstall ? "?force_reinstall=true" : "";
  await fetchJson(`/api/v1/remote-support/devices/${deviceId}/deploy${qs}`, { method: "POST" });
}
