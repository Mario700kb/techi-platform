import { useEffect, useState } from "react";

import { getPlatformFeatures, PlatformFeatures } from "../api/platform";

const ALL_OFF: PlatformFeatures = {
  FEATURE_PLATFORM_CORE: false,
  FEATURE_LINUX: false,
  FEATURE_VAULT: false,
  FEATURE_TERMINAL: false,
  FEATURE_MIKROTIK: false,
  FEATURE_STORAGE: false,
  FEATURE_HYPERVISOR: false,
};

/**
 * Platform Expansion feature flags, fetched once after auth. Defaults to
 * all-off so the UI is bit-identical to today until the backend reports a
 * flag on — a failed/absent fetch never reveals expansion surfaces.
 */
export function usePlatformFeatures(): PlatformFeatures {
  const [features, setFeatures] = useState<PlatformFeatures>(ALL_OFF);

  useEffect(() => {
    let active = true;
    getPlatformFeatures()
      .then((f) => {
        if (active) setFeatures(f);
      })
      .catch(() => {
        if (active) setFeatures(ALL_OFF);
      });
    return () => {
      active = false;
    };
  }, []);

  return features;
}
