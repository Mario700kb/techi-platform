import { useCallback, useRef } from "react";
import type { MutableRefObject, Ref, RefCallback } from "react";

import { motion, motionAllowed } from "../utils/motion";

/** Longest exit animation (index.css `.th-leaving` rules) plus a margin. */
const EXIT_LIMIT_MS = 400;

/** Exit animations are off in unit tests (jsdom) and for reduced motion. */
export const exitAnimations = motion;

/**
 * Plays the exit animation of an element its parent simply stopped
 * rendering. While the element is still in place, its position and the
 * scroll offsets inside it are noted; once React has removed it, an inert copy
 * goes back in the same place with `th-leaving`, animates out (index.css) and
 * removes itself. Callers keep rendering `{open && <Menu />}` as before.
 */
export function playExit(node: HTMLElement): void {
  if (!motionAllowed()) return;
  const parent = node.parentNode;
  const next = node.nextSibling;
  const scrolled: Array<[number, number, number]> = [];
  node.querySelectorAll<HTMLElement>("*").forEach((el, index) => {
    if (el.scrollTop || el.scrollLeft) scrolled.push([index, el.scrollTop, el.scrollLeft]);
  });
  const ghost = node.cloneNode(true) as HTMLElement;
  queueMicrotask(() => {
    // Still in the page: the ref was only detached, nothing left.
    if (node.isConnected || !parent?.isConnected) return;
    ghost.classList.add("th-leaving");
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    ghost.removeAttribute("id");
    ghost.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    parent.insertBefore(ghost, next?.parentNode === parent ? next : null);
    if (scrolled.length) {
      const all = ghost.querySelectorAll<HTMLElement>("*");
      for (const [index, top, left] of scrolled) {
        const el = all[index];
        if (el) {
          el.scrollTop = top;
          el.scrollLeft = left;
        }
      }
    }
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      ghost.remove();
    };
    ghost.addEventListener("animationend", (event) => {
      if (event.target === ghost) remove();
    });
    window.setTimeout(remove, EXIT_LIMIT_MS);
  });
}

/**
 * A ref for an element that is mounted and unmounted conditionally: when it
 * leaves, it animates out instead of vanishing. Pass `also` to keep the
 * component's own ref working on the same element.
 */
export function useExitAnimation<T extends HTMLElement>(also?: Ref<T>): RefCallback<T> {
  const last = useRef<T | null>(null);
  const alsoRef = useRef(also);
  alsoRef.current = also;
  return useCallback((node: T | null) => {
    const other = alsoRef.current;
    if (typeof other === "function") other(node);
    else if (other) (other as MutableRefObject<T | null>).current = node;
    if (node) {
      last.current = node;
      return;
    }
    const gone = last.current;
    last.current = null;
    if (gone) playExit(gone);
  }, []);
}
