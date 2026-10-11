import { useLayoutEffect, useRef } from "react";

/**
 * Sliding underline for a `.th-tabs` tablist. Measures the selected tab and
 * hands its box to CSS (--ind-x / --ind-y / --ind-w); the `::after` bar then
 * glides between tabs. The first placement is instant (no slide in from 0),
 * later ones animate. Re-measures when the list resizes (fonts, counts).
 */
export function useTabIndicator<T extends HTMLElement>(activeKey: unknown) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const place = () => {
      const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!tab) {
        list.removeAttribute("data-indicator");
        return;
      }
      list.style.setProperty("--ind-x", `${tab.offsetLeft}px`);
      list.style.setProperty("--ind-y", `${tab.offsetTop + tab.offsetHeight - 2}px`);
      list.style.setProperty("--ind-w", `${tab.offsetWidth}px`);
      if (!list.hasAttribute("data-indicator")) {
        list.setAttribute("data-indicator", "placed");
        // Enable the glide only after the first placement has painted.
        requestAnimationFrame(() => list.setAttribute("data-indicator", "ready"));
      }
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeKey]);

  return ref;
}
