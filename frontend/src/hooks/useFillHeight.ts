import { useLayoutEffect, useRef, useState } from "react";

/**
 * The height that lets an element end at the bottom of the page area
 * (`.th-main`), so a long list scrolls inside it while everything above stays
 * put. Re-measured when the window or the content above changes. Null while
 * disabled (phones keep the page scroll) or before the first measure.
 */
export function useFillHeight<T extends HTMLElement>(enabled: boolean, min = 240) {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) {
      setHeight(null);
      return;
    }
    const page = el.closest<HTMLElement>(".th-main");
    const measure = () => {
      if (!page) {
        setHeight(Math.max(min, Math.floor(window.innerHeight - el.getBoundingClientRect().top - 20)));
        return;
      }
      // Positions inside the page's content, whatever the page's own scroll.
      const origin = page.getBoundingClientRect().top - page.scrollTop;
      const box = el.getBoundingClientRect();
      // Whatever the page holds below the element (panel padding, margins).
      let contentBottom = box.bottom - origin;
      for (const child of page.children)
        contentBottom = Math.max(contentBottom, child.getBoundingClientRect().bottom - origin);
      const below = contentBottom - (box.bottom - origin) + (parseFloat(getComputedStyle(page).paddingBottom) || 0);
      setHeight(Math.max(min, Math.floor(page.clientHeight - (box.top - origin) - below)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (page) observer.observe(page);
    if (el.parentElement) observer.observe(el.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [enabled, min]);

  return { ref, height };
}
