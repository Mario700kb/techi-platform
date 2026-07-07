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
}

export async function getPlatformFeatures(): Promise<PlatformFeatures> {
  return fetchJson<PlatformFeatures>("/api/v1/platform/features");
}
