import { fetchJson } from "./client";
import type { StandardGroup } from "../types/groups";
import type { PatchStatus } from "./inventory";
import type { DeviceHealthSummary } from "../types/telemetry";

export type OfflineReason =
  | "site_outage"
  | "network_lost"
  | "agent_stopped"
  | "remote_support_stopped"
  | "stale_heartbeat"
  | "possibly_power_off"
  | "unknown";

export interface DeviceOfflineAnalysis {
  reason: OfflineReason | null;
  confidence: "high" | "medium" | "low" | null;
  explanation: string;
  evidence: string[];
}

export interface Device {
  id: number;
  agent_id?: string | null;
  rustdesk_id: string;
  hostname?: string;
  display_name?: string | null;
  current_user?: string;
  user_source?: string;
  user_session_state?: string;
  domain?: string;
  public_ip?: string;
  local_ip?: string;
  // Operator-set Connect target. Null falls back to the reported addresses —
  // public_ip first for network gear (a router is its own NAT device),
  // local_ip first for everything else.
  connect_host?: string | null;
  connect_port?: number | null;
  os_name?: string;
  os_version?: string;
  os_caption?: string | null;
  // Windows: "10.0.26200"; with os_caption it names the release (25H2).
  os_build?: string | null;
  // Windows ProductType: 1 workstation, 2 domain controller, 3 server.
  windows_product_type?: number | null;
  platform?: string;
  // Platform Expansion: capabilities reported by platform-aware agents
  // (Linux+). Absent for Windows. UI renders capability-gated surfaces.
  capabilities?: Record<string, string> | null;
  kernel_version?: string | null;
  architecture?: string | null;
  mac_address?: string | null;
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
  // The client's site the device is at: by a location rule, or placed by hand ("manual").
  location_id?: number | null;
  location_name?: string | null;
  location_city?: string | null;
  location_country?: string | null;
  location_source?: "rule" | "manual" | null;
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
  // The agent's live channel is open now (agents from 2.1.27).
  live?: boolean;
  // When that channel dropped, while the backend waits for it to return.
  live_lost_at?: string | null;
  // Offline reason engine
  offline_reason?: string | null;
  offline_confidence?: string | null;
  last_boot_time?: string | null;
  last_shutdown_time?: string | null;
  network_disconnect_time?: string | null;
  is_in_maintenance?: boolean;
  maintenance_started_at?: string | null;
  maintenance_ends_at?: string | null;
  maintenance_note?: string | null;
  maintenance_started_by?: string | null;
  agent_version?: string | null;
  agent_sha256?: string | null;
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
  smart_folder?:
    | "windows_server"
    | "windows_workstation"
    | "laptop"
    | "domain"
    | "workgroup"
    | "unassigned"
    | "offline"
    | "rustdesk_missing";
  agent_update_state?: "outdated";
  // Platform Expansion: additive platform filter (e.g. "windows", "linux").
  platform?: string;
  // Phase 7: platform-class tree category (network|storage|hypervisors).
  category?: string;
  // Server-side quick filter: the list and its count use the same condition.
  quick_filter?: DeviceQuickFilter;
  // Restrict to these devices (the operator's favorites); [] matches none.
  ids?: number[];
  // "unknown" selects devices that report no agent version.
  agent_version?: string;
  // Explorer location (one id) or city (several); -1 is "no location".
  location_ids?: number[];
  hide_offline_days?: number;
  sort?: DeviceSortKey;
  order?: "asc" | "desc";
}

export type DeviceQuickFilter =
  | "online"
  | "stale"
  | "offline"
  | "servers"
  | "workstations"
  | "maintenance"
  | "critical"
  | "warnings"
  | "healthy"
  | "needs_updates"
  | "reboot_required"
  | "needs_attention"
  | "low_health"
  | "rustdesk_issues"
  | "needs_agent_update";

export type DeviceSortKey = "hostname" | "client_name" | "last_seen" | "health";

export interface DeviceQuickCounts {
  counts: Record<"all" | DeviceQuickFilter | "favorites", number>;
  agent_versions: Record<string, number>;
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
const allowedAssignmentSources = new Set([
  "system_auto",
  "manual",
  "legacy_manual",
  "trusted_domain",
  "enrollment_token",
  "auto_os",
  "unassigned",
]);
const allowedLifecycleStates = new Set(["active", "archived", "all"]);
const allowedMaintenanceStates = new Set(["maintenance", "normal"]);
const allowedSmartFolders = new Set([
  "windows_server",
  "windows_workstation",
  "laptop",
  "domain",
  "workgroup",
  "unassigned",
  "offline",
  "rustdesk_missing",
]);
const allowedAgentUpdateStates = new Set(["outdated"]);

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
  appendIfAllowed(
    params,
    "assignment_source",
    assignmentSourceParam(filters.assignment_source),
    allowedAssignmentSources,
  );
  appendIfAllowed(params, "lifecycle_state", filters.lifecycle_state, allowedLifecycleStates);
  if (filters.search?.trim()) params.append("search", filters.search.trim());
  if (filters.duplicate_candidates === true) params.append("duplicate_candidates", "true");
  appendIfAllowed(params, "maintenance_state", filters.maintenance_state, allowedMaintenanceStates);
  appendIfAllowed(params, "smart_folder", filters.smart_folder, allowedSmartFolders);
  appendIfAllowed(params, "agent_update_state", filters.agent_update_state, allowedAgentUpdateStates);
  if (filters.platform?.trim()) params.append("platform", filters.platform.trim().toLowerCase());
  if (filters.category?.trim()) params.append("category", filters.category.trim().toLowerCase());
  if (filters.quick_filter) params.append("quick_filter", filters.quick_filter);
  if (filters.ids) params.append("ids", filters.ids.join(","));
  if (filters.agent_version?.trim()) params.append("agent_version", filters.agent_version.trim());
  if (filters.hide_offline_days) params.append("hide_offline_days", String(filters.hide_offline_days));
  if (filters.location_ids) params.append("location_ids", filters.location_ids.join(","));
  if (filters.sort) params.append("sort", filters.sort);
  if (filters.order) params.append("order", filters.order);
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
  limit: number = 20,
  signal?: AbortSignal,
): Promise<DevicesResponse> {
  const params = new URLSearchParams({
    skip: skip.toString(),
    limit: limit.toString(),
  });

  appendDeviceFilterParams(params, filters);

  return fetchJson<DevicesResponse>(`/api/v1/devices/?${params.toString()}`, signal ? { signal } : undefined);
}

export interface DeviceDirectoryEntry {
  id: number;
  hostname: string | null;
  rustdesk_id: string | null;
  client_id: number | null;
  group_id: number | null;
  freshness_state: "online" | "stale" | "offline";
}

/** Every active device in scope, with only what a picker needs. */
export async function getDeviceDirectory(): Promise<DeviceDirectoryEntry[]> {
  return fetchJson<DeviceDirectoryEntry[]>("/api/v1/devices/directory");
}

export interface DeviceStats {
  total: number;
  online: number;
  stale: number;
  offline: number;
}

export interface DevicesSummary {
  devices: Device[];
  stats: DeviceStats;
  health: DeviceHealthSummary[];
  patches: PatchStatus[];
  tree_counts: {
    total: number;
    unassigned: number;
    by_client: Record<string, number>;
    by_client_category?: Record<string, Record<string, number>>;
    // Platform Expansion: {clientId: {category: {platform: count}}} (empty when FEATURE_LINUX off).
    by_client_category_platform?: Record<string, Record<string, Record<string, number>>>;
  };
  loaded_at: string;
}

export interface TreeLocation {
  id: number;
  client_id: number;
  name: string;
  kind: string;
  country: string;
  city: string;
}

export interface TreeLocationCounts extends DeviceStats {
  // {category: {platform: count}}
  by_category_platform: Record<string, Record<string, number>>;
}

export interface DeviceFleetOverview {
  stats: DeviceStats;
  tree_counts: {
    total: number;
    unassigned: number;
    by_client: Record<string, number>;
    by_client_category?: Record<string, Record<string, number>>;
    // Fleet-wide counts per category by freshness, devices without a client included.
    by_category?: Record<string, DeviceStats>;
    // Per client by freshness (the Explorer's status ring).
    by_client_status?: Record<string, DeviceStats>;
    // Platform Expansion: {clientId: {category: {platform: count}}} (empty when FEATURE_LINUX off).
    by_client_category_platform?: Record<string, Record<string, Record<string, number>>>;
    // Client sites: each client's locations, and {clientId: {locationId, or 0 for none: counts}}.
    locations?: TreeLocation[];
    by_client_location?: Record<string, Record<string, TreeLocationCounts>>;
  };
  critical: number;
  warnings: number;
  average_health: number | null;
  needs_updates: number;
  agents_outdated: number;
  active_agent_version: string | null;
  active_agent_sha256: string | null;
  active_connector_versions?: Record<string, string>;
  active_agent_versions?: Record<string, string>;
  // The next time a count changes by time alone (a heartbeat turning 6 or 25
  // minutes old): the overview is refreshed then, not polled.
  next_change_at?: string | null;
  loaded_at: string;
}

export interface FleetInsights {
  availability: {
    days: number;
    series: { date: string; availability_pct: number | null }[];
    overall_pct: number | null;
    coverage_pct: number | null;
    device_count: number;
  };
  alerts: {
    days: number;
    series: { date: string; opened: number; resolved: number }[];
    opened_total: number;
    resolved_total: number;
    open_now: number;
    mean_time_to_resolve_hours: number | null;
  };
  problem_devices: {
    device_id: number;
    name: string;
    client_name: string | null;
    offline_events: number;
    alerts: number;
    freshness_state: string;
  }[];
  generated_at: string;
}

export async function getFleetInsights(days = 30, clientId?: number): Promise<FleetInsights> {
  const client = clientId != null ? `&client_id=${clientId}` : "";
  return fetchJson<FleetInsights>(`/api/v1/devices/insights?days=${days}${client}`);
}

// Counts for every status tab and quick filter over one selection — the same
// conditions the list uses, so a chip's number equals the rows it opens.
export async function getDeviceQuickCounts(
  filters: DeviceFilters = {},
  favoriteIds: number[] = [],
  signal?: AbortSignal,
): Promise<DeviceQuickCounts> {
  const params = new URLSearchParams();
  const { quick_filter: _quick, ids: _ids, sort: _sort, order: _order, ...base } = filters;
  appendDeviceFilterParams(params, base);
  if (favoriteIds.length > 0) params.append("favorite_ids", favoriteIds.join(","));
  return fetchJson<DeviceQuickCounts>(`/api/v1/devices/quick-counts?${params.toString()}`, { signal });
}

export async function getDevicesOverview(): Promise<DeviceFleetOverview> {
  return fetchJson<DeviceFleetOverview>("/api/v1/devices/overview");
}

export interface DeviceTableDetails {
  health: DeviceHealthSummary[];
  patches: PatchStatus[];
}

export async function getDeviceTableDetails(deviceIds: number[]): Promise<DeviceTableDetails> {
  const ids = deviceIds.join(",");
  return fetchJson<DeviceTableDetails>(`/api/v1/devices/table-details?ids=${encodeURIComponent(ids)}`);
}

export async function getDevicesSummary(): Promise<DevicesSummary> {
  return fetchJson<DevicesSummary>("/api/v1/devices/summary");
}

export interface DeviceTreeCounts {
  total: number;
  unassigned: number;
  by_client: Record<string, number>;
}

export async function getDeviceTree(): Promise<DeviceTreeCounts> {
  return fetchJson<DeviceTreeCounts>("/api/v1/devices/tree");
}

export async function getDeviceStats(): Promise<DeviceStats> {
  const stats = await fetchJson<DeviceStats>("/api/v1/devices/stats");
  if (
    !Number.isFinite(stats.total) ||
    !Number.isFinite(stats.online) ||
    !Number.isFinite(stats.stale) ||
    !Number.isFinite(stats.offline)
  ) {
    throw new Error("Invalid device stats response");
  }
  return stats;
}

export async function getDevicesCount(filters: DeviceFilters = {}): Promise<number> {
  const params = new URLSearchParams();
  appendDeviceFilterParams(params, filters);

  const response = await fetchJson<{ count: number }>(`/api/v1/devices/count?${params.toString()}`);
  return response.count;
}

export async function getDeviceStatsWithFallback(): Promise<DeviceStats> {
  try {
    return await getDeviceStats();
  } catch {
    const [total, online, stale, offline] = await Promise.all([
      getDevicesCount(),
      getDevicesCount({ freshness_state: "online" }),
      getDevicesCount({ freshness_state: "stale" }),
      getDevicesCount({ freshness_state: "offline" }),
    ]);
    return { total, online, stale, offline };
  }
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

export async function assignDeviceStandardGroup(deviceId: number, name: StandardGroup): Promise<Device> {
  return fetchJson<Device>(`/api/v1/devices/${deviceId}/assign-group`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_name: name }),
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

export async function getDeviceOfflineAnalysis(deviceId: number): Promise<DeviceOfflineAnalysis> {
  return fetchJson<DeviceOfflineAnalysis>(`/api/v1/devices/${deviceId}/offline-analysis`);
}
