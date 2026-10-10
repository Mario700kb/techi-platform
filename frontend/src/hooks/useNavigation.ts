import { useMemo } from "react";
import { useAuth } from "../auth/AuthContext";
import { usePlatformFeatures } from "./usePlatformFeatures";
import { NAV_SECTIONS, NavItem, NavSection } from "../components/navigation";

/** Navigation filtered to what the signed-in operator may open. */
export function useVisibleNav(): { sections: NavSection[]; canSee: (item: NavItem) => boolean } {
  const { hasPermission } = useAuth();
  const features = usePlatformFeatures();

  return useMemo(() => {
    const canSee = (item: NavItem) =>
      (item.permission === null || hasPermission(item.permission)) && (!item.feature || features[item.feature]);
    const sections = NAV_SECTIONS
      .map((section) => ({ ...section, items: section.items.filter(canSee) }))
      .filter((section) => section.items.length > 0);
    return { sections, canSee };
  }, [hasPermission, features]);
}
