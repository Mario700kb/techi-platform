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
