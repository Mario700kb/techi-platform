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
}

export async function getPlatformFeatures(): Promise<PlatformFeatures> {
  return fetchJson<PlatformFeatures>("/api/v1/platform/features");
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
