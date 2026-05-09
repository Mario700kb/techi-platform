import { fetchJson } from "../lib/api";

export interface Device {
  id: number;
  rustdesk_id: string;
  hostname?: string;
  current_user?: string;
  domain?: string;
  public_ip?: string;
  local_ip?: string;
  os_name?: string;
  os_version?: string;
  platform?: string;
  device_type: "server" | "client" | "unassigned";
  status: "online" | "offline";
  registered_at: string;
  last_seen?: string;
  client_id?: number;
  group_id?: number;
  cpu?: string;
  ram?: string;
  storage?: string;
}

export interface DeviceFilters {
  status?: "online" | "offline";
  device_type?: "server" | "client" | "unassigned";
  client_id?: number;
  group_id?: number;
  search?: string;
}

export interface DevicesResponse {
  devices: Device[];
  total: number;
}

export async function getDevices(
  filters: DeviceFilters = {},
  skip: number = 0,
  limit: number = 100
): Promise<Device[]> {
  const params = new URLSearchParams({
    skip: skip.toString(),
    limit: limit.toString(),
  });

  if (filters.status) params.append("status", filters.status);
  if (filters.device_type) params.append("device_type", filters.device_type);
  if (filters.client_id) params.append("client_id", filters.client_id.toString());
  if (filters.group_id) params.append("group_id", filters.group_id.toString());
  if (filters.search) params.append("search", filters.search);

  return fetchJson<Device[]>(`/devices?${params.toString()}`);
}

export async function getDevice(deviceId: number): Promise<Device> {
  return fetchJson<Device>(`/devices/${deviceId}`);
}

export async function createDevice(device: Omit<Device, "id" | "registered_at">): Promise<Device> {
  const response = await fetch(`${import.meta.env.VITE_API_URL || "http://localhost:8000"}/api/v1/devices`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(device),
  });

  if (!response.ok) {
    throw new Error("Failed to create device");
  }

  return response.json();
}

export async function updateDevice(deviceId: number, updates: Partial<Device>): Promise<Device> {
  const response = await fetch(`${import.meta.env.VITE_API_URL || "http://localhost:8000"}/api/v1/devices/${deviceId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    throw new Error("Failed to update device");
  }

  return response.json();
}

export async function deleteDevice(deviceId: number): Promise<void> {
  const response = await fetch(`${import.meta.env.VITE_API_URL || "http://localhost:8000"}/api/v1/devices/${deviceId}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error("Failed to delete device");
  }
}
