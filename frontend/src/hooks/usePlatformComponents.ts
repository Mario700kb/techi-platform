import { useEffect, useState } from "react";

import { getPlatformComponents, PlatformComponent } from "../api/platform";

// Local fallback that mirrors the backend Component Registry's classification of
// the 7 existing file_types. Used as the initial state AND whenever the registry
// endpoint is unavailable (e.g. production still on an older backend commit that
// lacks GET /platform/components). This is the progressive-enhancement safety net
// the review requires: the Agent Packages page must never depend on the endpoint.
export const FALLBACK_COMPONENTS: PlatformComponent[] = [
  {
    id: "agent",
    display_name: "TECHI Agent",
    description: "",
    icon_key: "agent",
    platforms: ["windows", "linux"],
    file_types: ["msi", "agent_binary", "agent_update_msi"],
    lifecycle: [],
    capabilities: [],
    policy: { desired_source: "active_package", policy: "active_package", strategy: "manual" },
  },
  {
    id: "remote_support",
    display_name: "TECHI Remote Support",
    description: "",
    icon_key: "remote_support",
    platforms: ["windows", "darwin"],
    file_types: [
      "remote_support_msi",
      "remote_support_bundle",
      "remote_support_dmg",
      "remote_support_pkg",
    ],
    lifecycle: [],
    capabilities: ["remote_support"],
    policy: { desired_source: "active_package", policy: "active_package", strategy: "manual" },
  },
];

export interface ComponentsState {
  components: PlatformComponent[];
  source: "api" | "fallback";
}

/** The component that owns a given file_type, or undefined if unclassified. */
export function componentForFileType(
  components: PlatformComponent[],
  fileType: string,
): PlatformComponent | undefined {
  return components.find((component) => component.file_types.includes(fileType));
}

/**
 * Platform Components registry metadata. Starts from the local fallback so the
 * page renders immediately and correctly, then upgrades to the live registry on
 * success. A failed/absent endpoint keeps the fallback — it never throws and
 * never blocks the Agent Packages page.
 */
export function usePlatformComponents(): ComponentsState {
  const [state, setState] = useState<ComponentsState>({
    components: FALLBACK_COMPONENTS,
    source: "fallback",
  });

  useEffect(() => {
    let alive = true;
    getPlatformComponents()
      .then((resp) => {
        if (alive && resp?.components?.length) {
          setState({ components: resp.components, source: "api" });
        }
      })
      .catch(() => {
        // Registry unavailable (older backend / transient error): keep the
        // local fallback. Controlled warning, not a fatal UI error.
        if (alive) {
          console.warn(
            "[platform-components] registry endpoint unavailable; using local fallback",
          );
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
