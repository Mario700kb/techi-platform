import { fetchJson } from "./client";

export interface Device {
  id: number;
  agent_id?: string | null;
  rustdesk_id: string;
  hostname?: string;
  current_user?: string;
  user_source?: string;
  user_session_state?: string;
  domain?: string;
  public_ip?: string;
  local_ip?: string;
  os_name?: string;
  os_version?: string;
  platform?: string;
  device_type: "server" | "client" | "unassigned";
  status: "online" | "offline";
  freshness_state?: "online" | "stale" | "offline";
  registered_at: string;
  last_seen?: string;
  last_enrollment_at?: string | null;
  enrollment_count?: number;
  reenrolled_from_agent_id?: string | null;
  client_id?: number;
  group_id?: number;
  client_name?: string | null;
  group_name?: string | null;
  cpu?: string;
  ram?: string;
  storage?: string;
  rustdesk_install_status: string;
  rustdesk_status: string;
  rustdesk_version?: string;
  rustdesk_install_path?: string;
  rustdesk_last_seen_at?: string;
  rustdesk_synced_at?: string;
  rustdesk_sync_state: string;
  rustdesk_sync_message?: string;
  rustdesk_verified_at?: string;
  rustdesk_manual_override: boolean;
  rustdesk_conflict_detected: boolean;
  rustdesk_last_repair_at?: string | null;
  rustdesk_repair_count?: number;
  auto_assigned?: boolean;
  assignment_source?: string;
  resolved_client_id?: number | null;
  resolved_client_name?: string | null;
  resolved_group?: string | null;
  resolved_assignment_source?: string;
  resolved_device_category?: "servers" | "clientpc" | "unassigned" | "other" | string;
  is_archived?: boolean;
  archived_at?: string | null;
  archived_by?: string | null;
  duplicate_candidate?: boolean;
  duplicate_of_device_id?: number | null;
  duplicate_score?: number | null;
  is_in_maintenance?: boolean;
  maintenance_started_at?: string | null;
  maintenance_ends_at?: string | null;
  maintenance_note?: string | null;
  maintenance_started_by?: string | null;
}

export interface DeviceFilters {
  status?: "online" | "offline";
  freshness_state?: "online" | "stale" | "offline";
  device_type?: "server" | "client" | "unassigned";
  client_id?: number;
  group_id?: number;
  assignment_source?: "auto" | "manual" | "token" | "unassigned";
  lifecycle_state?: "active" | "archived" | "all";
  search?: string;
  duplicate_candidates?: boolean;
  maintenance_state?: "maintenance" | "normal";
  smart_folder?: "windows_server" | "windows_workstation" | "laptop" | "domain" | "workgroup" | "unassigned" | "offline" | "rustdesk_missing";
}

const assignmentSourceParam = (source?: DeviceFilters["assignment_source"]) => {
  if (source === "auto") return "system_auto";
  if (source === "token") return "enrollment_token";
  if (source === "unassigned") return "unassigned";
  return source;
};

const allowedStatuses = new Set(["online", "offline"]);
const allowedFreshnessStates = new Set(["online", "stale", "offline"]);
const allowedDeviceTypes = new Set(["server", "client", "unassigned"]);
const allowedAssignmentSources = new Set(["system_auto", "manual", "legacy_manual", "trusted_domain", "enrollment_token", "auto_os", "unassigned"]);
const allowedLifecycleStates = new Set(["active", "archived", "all"]);
const allowedMaintenanceStates = new Set(["maintenance", "normal"]);
const allowedSmartFolders = new Set(["windows_server", "windows_workstation", "laptop", "domain", "workgroup", "unassigned", "offline", "rustdesk_missing"]);

function appendIfAllowed(params: URLSearchParams, key: string, value: string | undefined, allowed: Set<string>) {
  if (value && allowed.has(value)) {
    params.append(key, value);
  }
}

function appendDeviceFilterParams(params: URLSearchParams, filters: DeviceFilters) {
  appendIfAllowed(params, "status", filters.status, allowedStatuses);
  appendIfAllowed(params, "freshness_state", filters.freshness_state, allowedFreshnessStates);
  appendIfAllowed(params, "device_type", filters.device_type, allowedDeviceTypes);
  if (typeof filters.client_id === "number" && Number.isFinite(filters.client_id)) {
    params.append("client_id", String(filters.client_id));
  }
  if (typeof filters.group_id === "number" && Number.isFinite(filters.group_id)) {
    params.append("group_id", String(filters.group_id));
  }
  appendIfAllowed(params, "assignment_source", assignmentSourceParam(filters.assignment_source), allowedAssignmentSources);
  appendIfAllowed(params, "lifecycle_state", filters.lifecycle_state, allowedLifecycleStates);
  if (filters.search?.trim()) params.append("search", filters.search.trim());
  if (filters.duplicate_candidates === true) params.append("duplicate_candidates", "true");
  appendIfAllowed(params, "maintenance_state", filters.maintenance_state, allowedMaintenanceStates);
  appendIfAllowed(params, "smart_folder", filters.smart_folder, allowedSmartFolders);
}

export interface DevicesResponse {
  devices: Device[];
  total: number;
}

export interface RustDeskHealth {
  device_id: number;
  rustdesk_id: string;
  install_status: string;
  status: string;
  version?: string;
  install_path?: string;
  sync_state: string;
  sync_message?: string;
  last_update?: string;
  verified_at?: string;
  manual_override: boolean;
  conflict_detected: boolean;
}

export interface RustDeskVerifyResponse {
  valid: boolean;
  normalized_rustdesk_id?: string;
  message?: string;
  conflict_device_id?: number;
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

  appendDeviceFilterParams(params, filters);

  return fetchJson<Device[]>(`/api/v1/devices/?${params.toString()}`);
}

export async function getDevicesCount(filters: DeviceFilters = {}): Promise<number> {
  const params = new URLSearchParams();
  appendDeviceFilterParams(params, filters);

  const response = await fetchJson<{ count: number }>(`/api/v1/devices/count?${params.toString()}`);
  return response.count;
}

export async function getDevice(deviceId: number): Promise<Device> {
  return fetchJson<Device>(`/api/v1/devices/${deviceId}`);
}

export async function createDevice(device: Omit<Device, "id" | "registered_at">): Promise<Device> {
  return fetchJson<Device>("/api/v1/devices/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(device),
  });
}

export async function updateDevice(deviceId: number, updates: Partial<Device>): Promise<Device> {
  return fetchJson<Device>(`/api/v1/devices/${deviceId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updates),
  });
}

export async function deleteDevice(deviceId: number, confirmDelete = false): Promise<void> {
  const suffix = confirmDelete ? "?confirm_delete=true" : "";
  await fetchJson<Device>(`/api/v1/devices/${deviceId}${suffix}`, { method: "DELETE" });
}

export async function archiveDevice(deviceId: number): Promise<Device> {
  return fetchJson<Device>(`/api/v1/devices/${deviceId}/archive`, { method: "PUT" });
}

export async function restoreDevice(deviceId: number): Promise<Device> {
  return fetchJson<Device>(`/api/v1/devices/${deviceId}/restore`, { method: "PUT" });
}

export async function verifyRustDeskId(rustdeskId: string, deviceId?: number): Promise<RustDeskVerifyResponse> {
  const path = deviceId ? `/api/v1/devices/${deviceId}/rustdesk/verify` : "/api/v1/devices/rustdesk/verify";
  return fetchJson<RustDeskVerifyResponse>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rustdesk_id: rustdeskId }),
  });
}

export async function updateDeviceRustDeskId(deviceId: number, rustdeskId: string, reason?: string): Promise<Device> {
  return fetchJson<Device>(`/api/v1/devices/${deviceId}/rustdesk`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rustdesk_id: rustdeskId, reason }),
  });
}

export async function getDeviceRustDeskHealth(deviceId: number): Promise<RustDeskHealth> {
  return fetchJson<RustDeskHealth>(`/api/v1/devices/${deviceId}/rustdesk/health`);
}

export async function assignDeviceClient(deviceId: number, clientId: number | null): Promise<Device> {
  return fetchJson<Device>(`/api/v1/devices/${deviceId}/assign-client`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
}

export async function assignDeviceGroup(deviceId: number, groupId: number | null): Promise<Device> {
  return fetchJson<Device>(`/api/v1/devices/${deviceId}/assign-group`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_id: groupId }),
  });
}

export interface MaintenanceEnterPayload {
  duration_minutes?: number | null;
  note?: string | null;
  started_by?: string | null;
}

export async function enterDeviceMaintenance(deviceId: number, payload: MaintenanceEnterPayload): Promise<Device> {
  return fetchJson<Device>(`/api/v1/devices/${deviceId}/maintenance`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function clearDeviceMaintenance(deviceId: number): Promise<Device> {
  return fetchJson<Device>(`/api/v1/devices/${deviceId}/maintenance/clear`, {
    method: "PUT",
  });
}
