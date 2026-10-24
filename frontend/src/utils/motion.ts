/**
 * Motion that JavaScript drives (exit copies, number tweens, change flashes).
 * Off in unit tests, so assertions see final values at once, and for anyone
 * who asked the system for reduced motion.
 */
export const motion = { enabled: import.meta.env.MODE !== "test" };

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function motionAllowed(): boolean {
  return motion.enabled && !prefersReducedMotion();
}

/** How long a changed value stays highlighted (index.css th-flash). */
export const FLASH_MS = 1400;
