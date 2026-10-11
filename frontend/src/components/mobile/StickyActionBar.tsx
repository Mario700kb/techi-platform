import { ReactNode } from "react";

/**
 * Device Details sticky action bar (MOBILE-DESIGN-SPEC.md — Device Details).
 * Renders above the safe area, replacing the BottomNav on this page.
 *
 * Implementation Note (docs/reference/MOBILE-DESIGN-SPEC.md — Device
 * Details): the approved mockup shows 4 slots — Connect | Restart |
 * Terminal | More. There is no per-device terminal/shell feature anywhere
 * in this app (AgentCommandsPanel is a fleet-wide desktop tool, not
 * per-device), so a working Terminal button cannot be wired without
 * inventing backend behavior. Rather than fake a non-functional button,
 * this bar ships 3 real, working slots — Connect | Restart | More — and
 * the Terminal slot is omitted.
 */
export function StickyActionBar({ children }: { children: ReactNode }) {
  return <div className="th-mactionbar md:hidden">{children}</div>;
}

export function ActionBarPrimary({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="th-mactionbar-btn" data-variant="primary">
      {children}
    </button>
  );
}

export function ActionBarSecondary({ onClick, disabled, children, danger }: { onClick: () => void; disabled?: boolean; children: ReactNode; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="th-mactionbar-btn" data-variant={danger ? "danger" : "secondary"}>
      {children}
    </button>
  );
}

export function ActionBarMore({ onClick, ariaLabel = "More actions", children }: { onClick: () => void; ariaLabel?: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={ariaLabel} className="th-mactionbar-btn" data-variant="icon">
      {children}
    </button>
  );
}
