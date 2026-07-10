import { fetchJson } from "./client";

// Connect Framework (Platform Expansion Phase 7) + credential-aware method
// status (Section D/E) + per-operator default Connect method (Section G).

export interface ConnectMethod {
  id: string;
  label: string;
  surface: "desktop" | "browser";
  capability: string | null;
  priority: number;
  scheme: string | null;
  requires_client_os: string | null;
  // "ready": usable now. "credential_required": the method exists for this
  // platform but no compatible Vault credential resolves yet.
  status: "ready" | "credential_required";
  status_reason: string | null;
  // Which Vault scope tier resolved the credential that makes this method
  // Ready (device|group|client|global) — null for native methods or when
  // status !== "ready".
  credential_source: "device" | "group" | "client" | "global" | null;
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

export async function getConnectMethods(deviceId: number): Promise<ConnectMethodsResponse> {
  return fetchJson<ConnectMethodsResponse>(`/api/v1/devices/${deviceId}/connect-methods`);
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
