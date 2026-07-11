import { fetchJson } from "./client";

// Connect Framework (Platform Expansion Phase 7) + credential-aware method
// status (Section D/E) + per-operator default Connect method (Section G) +
// approved V3 Connect mockup metadata (categorized menu, transport labels,
// honest embedded gating).

export interface ConnectMethod {
  id: string;
  label: string;
  surface: "desktop" | "browser";
  capability: string | null;
  priority: number;
  scheme: string | null;
  requires_client_os: string | null;
  // "ready": usable now. "credential_required": the method exists for this
  // platform but no compatible Vault credential resolves yet. "unavailable":
  // the method can't work right now (operator-OS mismatch, or an embedded
  // method whose Terminal stack isn't enabled for this device) — still
  // rendered, disabled, with status_reason (never hidden).
  status: "ready" | "credential_required" | "unavailable";
  status_reason: string | null;
  // Which Vault scope tier resolved the credential that makes this method
  // Ready (device|group|client|global) — null for native methods or when
  // status !== "ready".
  credential_source: "device" | "group" | "client" | "global" | null;
  // Approved V3 Connect mockup: short transport/source label ("Agent
  // tunnel", "Backend relay · Vault", "Browser", "Desktop app"), the menu
  // section kind, and whether the method runs inside TECHI's Terminal stack.
  transport: string;
  category: "available" | "web" | "desktop_app";
  embedded: boolean;
}

export interface ConnectMethodsResponse {
  platform: string;
  methods: ConnectMethod[];
  // The operator's effective default for this device (after the 4-tier
  // hierarchy: device override > platform default > registry priority >
  // first Ready method).
  preferred_method_id: string | null;
  // What the operator actually configured, even if it isn't the effective
  // default right now (e.g. its credential isn't ready) — lets the UI say
  // "X isn't available, using Y instead".
  configured_preference_id: string | null;
}

export async function getConnectMethods(deviceId: number, clientOs?: string): Promise<ConnectMethodsResponse> {
  const query = clientOs ? `?client_os=${encodeURIComponent(clientOs)}` : "";
  return fetchJson<ConnectMethodsResponse>(`/api/v1/devices/${deviceId}/connect-methods${query}`);
}

// Batch Connect-button state for the Device Catalog's visible non-Windows
// rows (Windows rows keep their separate RustDesk check).
export interface ConnectRowStatus {
  device_id: number;
  platform: string;
  state: "ready" | "credential_required" | "unavailable";
  reason: string | null;
  preferred_method_id: string | null;
  preferred_method_label: string | null;
  method_count: number;
}

export async function getConnectStatuses(deviceIds: number[], clientOs?: string): Promise<ConnectRowStatus[]> {
  if (deviceIds.length === 0) return [];
  const params = new URLSearchParams({ device_ids: deviceIds.join(",") });
  if (clientOs) params.set("client_os", clientOs);
  return fetchJson<ConnectRowStatus[]>(`/api/v1/connect-status?${params.toString()}`);
}

// Fired whenever something that affects Connect readiness changes (a Vault
// credential created/edited/deleted, a default method pinned/reset) so every
// mounted Connect surface — menus, Catalog row buttons — refreshes
// immediately, no manual page refresh.
export const CONNECT_REFRESH_EVENT = "techi:connect-refresh";

export function emitConnectRefresh(): void {
  window.dispatchEvent(new Event(CONNECT_REFRESH_EVENT));
}

export interface ConnectLaunchResult {
  url: string;
  surface: "desktop" | "browser";
}

export async function launchConnectMethod(deviceId: number, methodId: string): Promise<ConnectLaunchResult> {
  return fetchJson<ConnectLaunchResult>(`/api/v1/devices/${deviceId}/connect-methods/${methodId}/launch`);
}

export interface ConnectPreference {
  platform: string;
  device_id: number | null;
  method_id: string;
}

// Section G: always the calling operator's own preferences — never global,
// never another operator's.
export async function listConnectPreferences(): Promise<ConnectPreference[]> {
  return fetchJson<ConnectPreference[]>("/api/v1/connect-preferences");
}

export async function setConnectPreference(
  platform: string,
  methodId: string,
  deviceId?: number,
): Promise<ConnectPreference> {
  return fetchJson<ConnectPreference>("/api/v1/connect-preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform, method_id: methodId, device_id: deviceId ?? null }),
  });
}

export async function resetConnectPreference(platform: string, deviceId?: number): Promise<void> {
  await fetchJson<void>("/api/v1/connect-preferences", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform, device_id: deviceId ?? null }),
  });
}
