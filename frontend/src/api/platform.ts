import { fetchJson } from "./client";

// Platform Expansion feature flags (backend GET /api/v1/platform/features).
// Every flag defaults to false; with flags off the UI renders nothing new.
export interface PlatformFeatures {
  FEATURE_PLATFORM_CORE: boolean;
  FEATURE_LINUX: boolean;
  FEATURE_VAULT: boolean;
  FEATURE_TERMINAL: boolean;
  FEATURE_MIKROTIK: boolean;
  FEATURE_STORAGE: boolean;
  FEATURE_HYPERVISOR: boolean;
  FEATURE_NOTIFICATIONS: boolean;
  FEATURE_REPORTING: boolean;
}

export async function getPlatformFeatures(): Promise<PlatformFeatures> {
  return fetchJson<PlatformFeatures>("/api/v1/platform/features");
}

// Platform Components registry metadata (GET /api/v1/platform/components).
// Read-only classification of the EXISTING packages/actions — it changes no
// file_type, URL, or manifest. Additive + versioned (schema_version). The
// frontend has a local fallback (see usePlatformComponents) so an older backend
// that lacks this endpoint never breaks the Agent Packages page.
export interface ComponentLifecycle {
  operation: string;           // install | update | reinstall | repair | restart | discover | sync
  label: string;               // display label (Install/Update/…)
  action_type: string | null;  // existing ActionType value, or null (GPO/heartbeat)
  kind: string;                // "action" | "out_of_band"
}

export interface ComponentPolicy {
  desired_source: string;      // active_package | manual | none
  policy: string;              // active_package | manual | future
  strategy: string;            // manual | future
}

export interface PlatformComponent {
  id: string;
  display_name: string;
  description: string;
  icon_key: string;
  platforms: string[];
  file_types: string[];        // existing AgentFileType string values
  lifecycle: ComponentLifecycle[];
  capabilities: string[];
  policy: ComponentPolicy;
}

export interface PlatformComponentsResponse {
  schema_version: number;
  components: PlatformComponent[];
}

export async function getPlatformComponents(): Promise<PlatformComponentsResponse> {
  return fetchJson<PlatformComponentsResponse>("/api/v1/platform/components");
}

// Per-device Desired-State (GET /devices/{id}/component-states). Read-only,
// informational — Installed/Desired/Health/Status per managed component.
export interface DeviceComponentState {
  component_id: string;
  display_name: string;
  icon_key: string;
  installed_version: string | null;
  desired_version: string | null;
  health: string;   // current | outdated | missing | unknown
  status: string;   // Current | Outdated | Missing | Unknown
}

export interface DeviceComponentStatesResponse {
  schema_version: number;
  device_id: number;
  components: DeviceComponentState[];
}

export async function getDeviceComponentStates(
  deviceId: number,
): Promise<DeviceComponentStatesResponse> {
  return fetchJson<DeviceComponentStatesResponse>(
    `/api/v1/devices/${deviceId}/component-states`,
  );
}

// Component Action API (POST /devices/{id}/components/{component}/actions).
// Triggers a component lifecycle operation, queued through the EXISTING device-
// action pipeline. `operation` is one of the ComponentLifecycle.operation values
// whose kind is "action" (out-of-band operations are not triggerable). The
// backend returns stable machine-readable error codes; fetchJson surfaces the
// human message (detail.detail) — see ComponentActionErrorCode on the backend.
export interface QueuedRemoteAction {
  id: number;
  device_id: number;
  action_type: string;
  status: string;   // queued | sent | acknowledged | running | completed | failed | ...
  created_at: string;
  created_by?: string | null;
}

export interface ComponentActionAccepted {
  component_id: string;
  operation: string;
  action_type: string;
  label: string;
  action: QueuedRemoteAction;
}

export async function queueComponentAction(
  deviceId: number,
  componentId: string,
  operation: string,
  parameters?: Record<string, unknown>,
  timeoutSeconds?: number,
): Promise<ComponentActionAccepted> {
  return fetchJson<ComponentActionAccepted>(
    `/api/v1/devices/${deviceId}/components/${componentId}/actions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, parameters, timeout_seconds: timeoutSeconds }),
    },
  );
}

// Retry a terminal component action (Operational M8). Re-validates the operation
// is still allowed for the device, then re-queues via the existing retry path.
export async function retryComponentAction(
  deviceId: number,
  actionId: number,
): Promise<ComponentActionAccepted> {
  return fetchJson<ComponentActionAccepted>(
    `/api/v1/devices/${deviceId}/components/actions/${actionId}/retry`,
    { method: "POST" },
  );
}

// Component Action History (GET /devices/{id}/components/actions). Reuses the
// EXISTING remote_actions store; each item is a queued action attributed to a
// component (operation/user/timestamp/result/duration/component). Optional
// component_id filter. Newest first.
export interface ComponentActionHistoryItem {
  id: number;
  device_id: number;
  component_id: string;
  operation: string;
  label: string;
  action_type: string;
  status: string;
  created_by?: string | null;
  created_at: string;
  result_message?: string | null;
  error_message?: string | null;
  duration_seconds?: number | null;
}

export interface ComponentActionHistoryResponse {
  schema_version: number;
  device_id: number;
  items: ComponentActionHistoryItem[];
}

export async function getComponentActionHistory(
  deviceId: number,
  opts?: { componentId?: string; limit?: number },
): Promise<ComponentActionHistoryResponse> {
  const params = new URLSearchParams();
  if (opts?.componentId) params.set("component_id", opts.componentId);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return fetchJson<ComponentActionHistoryResponse>(
    `/api/v1/devices/${deviceId}/components/actions${qs ? `?${qs}` : ""}`,
  );
}

// Bulk component actions (POST /components/actions/bulk). Multiple devices ×
// multiple components, each queued independently with per-item partial-failure
// reporting. Live progress is observable via the existing realtime action events.
export interface BulkComponentActionTarget {
  component_id: string;
  operation: string;
}

export interface BulkComponentActionItem {
  device_id: number;
  component_id: string;
  operation: string;
  ok: boolean;
  action_id?: number | null;
  action_type?: string | null;
  status?: string | null;
  error_code?: string | null;
  error?: string | null;
}

export interface BulkComponentActionResponse {
  schema_version: number;
  total: number;
  succeeded: number;
  failed: number;
  items: BulkComponentActionItem[];
}

export async function bulkComponentActions(
  deviceIds: number[],
  targets: BulkComponentActionTarget[],
  opts?: { parameters?: Record<string, unknown>; timeoutSeconds?: number },
): Promise<BulkComponentActionResponse> {
  return fetchJson<BulkComponentActionResponse>("/api/v1/components/actions/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_ids: deviceIds,
      targets,
      parameters: opts?.parameters,
      timeout_seconds: opts?.timeoutSeconds,
    }),
  });
}

// Component package status (GET /devices/{id}/components/{component}/package).
// Read-only: Installed / Desired / Available versions + Outdated detection.
export interface ComponentPackageStatus {
  schema_version: number;
  device_id: number;
  component_id: string;
  installed_version: string | null;
  desired_version: string | null;
  available_version: string | null;
  outdated: boolean;
}

export async function getComponentPackageStatus(
  deviceId: number,
  componentId: string,
): Promise<ComponentPackageStatus> {
  return fetchJson<ComponentPackageStatus>(
    `/api/v1/devices/${deviceId}/components/${componentId}/package`,
  );
}

// Registry-driven Device Drawer feed (GET /devices/{id}/drawer). Everything the
// generic renderer needs comes from the Platform / Capability / Action / Connect
// registries — no per-platform UI. CORE-gated (404 when off).
export interface DrawerAction {
  id: string;
  label: string;
  permission?: string | null;
  required_capability?: string | null;
  confirm: string;   // "none" | "confirm"
  target: string;    // "agent" | "device"
}

export interface DrawerConnectMethod {
  id: string;
  label: string;
  surface: string;
  capability?: string | null;
  priority: number;
  scheme?: string | null;
}

export interface DrawerMeta {
  platform: string;
  capabilities: string[];
  remote_support: boolean;
  terminal: boolean;
  capability_tabs: string[];
  connect_methods: DrawerConnectMethod[];
  actions: DrawerAction[];
  // Version Service — null for Windows (its classic Drawer has its own
  // separate, untouched badge). Populated for every connector platform.
  reported_version?: string | null;
  latest_version?: string | null;
  version_status?: "current" | "outdated" | "ahead" | null;
}

export async function getDrawerMeta(deviceId: number): Promise<DrawerMeta> {
  return fetchJson<DrawerMeta>(`/api/v1/devices/${deviceId}/drawer`);
}
