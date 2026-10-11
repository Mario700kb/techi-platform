import { useSyncExternalStore } from "react";

// Tailwind's md breakpoint; used where rendering both layouts would load data twice.
export const DESKTOP_QUERY = "(min-width: 768px)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
