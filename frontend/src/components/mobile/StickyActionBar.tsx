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
  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 flex gap-2 px-3 py-[10px] md:hidden"
      style={{
        background: "var(--th-bg-topbar)",
        borderTop: "1px solid var(--th-border-default)",
        paddingBottom: "max(env(safe-area-inset-bottom), 10px)",
      }}
    >
      {children}
    </div>
  );
}

export function ActionBarPrimary({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-11 flex-[1.4] items-center justify-center gap-[7px] rounded-xl text-[13.5px] font-extrabold text-white disabled:opacity-45"
      style={{ background: "var(--th-accent)" }}
    >
      {children}
    </button>
  );
}

export function ActionBarSecondary({
  onClick,
  disabled,
  children,
  danger,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-11 flex-1 items-center justify-center gap-[6px] rounded-xl text-[12.5px] font-bold disabled:opacity-45"
      style={{
        background: "var(--th-bg-card)",
        border: `1px solid ${danger ? "color-mix(in srgb, var(--th-status-critical) 30%, transparent)" : "var(--th-border-subtle)"}`,
        color: danger ? "var(--th-status-critical)" : "var(--th-text-primary)",
      }}
    >
      {children}
    </button>
  );
}

export function ActionBarMore({
  onClick,
  ariaLabel = "More actions",
  children,
}: {
  onClick: () => void;
  ariaLabel?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="flex h-11 w-11 flex-none items-center justify-center rounded-xl"
      style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-subtle)", color: "var(--th-text-primary)" }}
    >
      {children}
    </button>
  );
}
