import { useSyncExternalStore } from "react";

import { getPlatformFeatures, PlatformFeatures } from "../api/platform";

const ALL_OFF: PlatformFeatures = {
  FEATURE_PLATFORM_CORE: false,
  FEATURE_LINUX: false,
  FEATURE_VAULT: false,
  FEATURE_TERMINAL: false,
  FEATURE_MIKROTIK: false,
  FEATURE_STORAGE: false,
  FEATURE_HYPERVISOR: false,
  FEATURE_NOTIFICATIONS: false,
  FEATURE_REPORTING: false,
};

interface FeaturesSnapshot {
  features: PlatformFeatures;
  loading: boolean;
}

// Module-level store (mirrors sessionStore.ts's useSyncExternalStore pattern)
// so every consumer — Sidebar, RequireFeature route guards, panels — shares
// one in-flight fetch and one resolved snapshot. Before this, each mounting
// consumer called usePlatformFeatures() independently and started its own
// fetch from ALL_OFF: a route guard mounting after the Sidebar had already
// resolved would still start from ALL_OFF/loading, treat the flag as off,
// and redirect to "/" before its own fetch completed.
// The last flags this browser was told, so the Sidebar paints its full menu
// on a reload instead of dropping Reports, Vault… until the fetch returns.
// Display only: route guards still wait for the fetch (loading stays true)
// and the backend enforces every flag itself.
const STORAGE_KEY = "techi.platform-features";

function readStored(): PlatformFeatures | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next = { ...ALL_OFF };
    (Object.keys(ALL_OFF) as (keyof PlatformFeatures)[]).forEach((key) => {
      next[key] = parsed[key] === true;
    });
    return next;
  } catch {
    return null;
  }
}

function writeStored(features: PlatformFeatures): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(features));
  } catch {
    // Storage blocked: the menu fills in when the fetch returns, as before.
  }
}

let snapshot: FeaturesSnapshot = { features: readStored() ?? ALL_OFF, loading: true };
let fetchPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(next: FeaturesSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function ensureFetch(): void {
  if (fetchPromise) return;
  fetchPromise = getPlatformFeatures()
    .then((f) => {
      writeStored(f);
      emit({ features: f, loading: false });
    })
    .catch(() => {
      // Keep the last known flags for display (all off when there are none).
      emit({ features: readStored() ?? ALL_OFF, loading: false });
      // Don't cache a failure (e.g. a 401 fetched before login completes) —
      // allow the next mount/subscribe to retry.
      fetchPromise = null;
    });
}

function subscribe(listener: () => void): () => void {
  ensureFetch();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): FeaturesSnapshot {
  return snapshot;
}

/**
 * Platform Expansion feature flags, fetched once (shared across all
 * consumers) after auth. Defaults to all-off so the UI is bit-identical to
 * today until the backend reports a flag on — a failed/absent fetch never
 * reveals expansion surfaces.
 */
export function usePlatformFeatures(): PlatformFeatures {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).features;
}

// True until the shared fetch above resolves (success or failure). Route
// guards must render a loading state while this is true instead of treating
// an unresolved flag as off — see RequireFeature in routes/AppRoutes.tsx.
export function usePlatformFeaturesLoading(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).loading;
}
