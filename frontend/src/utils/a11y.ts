import type { KeyboardEvent } from "react";

/**
 * Props that make a non-button element (a card, a tree row) operable from the
 * keyboard the same way it is with a mouse: focusable, announced as a button,
 * activated by Enter or Space. Use only where a real <button> cannot wrap the
 * content, e.g. because the element already contains other buttons.
 */
export function activateProps(onActivate: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate();
      }
    },
  };
}

/** Stops a click inside a clickable row from also activating the row. */
export const stopRowClick = {
  role: "presentation" as const,
  onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
};
