import { ReactNode } from "react";

/**
 * Mobile UI 2.0 design-system primitives (docs/reference/MOBILE-DESIGN-SPEC.md).
 * Colors come exclusively from --th-* tokens; no hardcoded hex here.
 */

export type FreshnessState = "online" | "stale" | "offline";

const STATUS_VAR: Record<FreshnessState, string> = {
  online: "var(--th-status-online)",
  stale: "var(--th-status-stale)",
  offline: "var(--th-status-offline)",
};

export function StatusDot({
  state,
  size = 11,
}: {
  state: FreshnessState;
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      className="inline-block flex-none rounded-full"
      style={{
        width: size,
        height: size,
        background: STATUS_VAR[state],
        boxShadow:
          state === "online"
            ? "0 0 6px color-mix(in srgb, var(--th-status-online) 55%, transparent)"
            : undefined,
      }}
    />
  );
}

export type MBadgeVariant =
  | "server"
  | "ws"
  | "critical"
  | "warning"
  | "info"
  | "maint"
  | "agent"
  | "offline"
  | "online";

const BADGE_VAR: Record<MBadgeVariant, string> = {
  server: "var(--th-status-agent)",
  ws: "var(--th-status-info)",
  critical: "var(--th-status-critical)",
  warning: "var(--th-status-warning)",
  info: "var(--th-status-info)",
  maint: "var(--th-status-maint)",
  agent: "var(--th-status-agent)",
  offline: "var(--th-status-offline)",
  online: "var(--th-status-online)",
};

export function MBadge({
  variant,
  children,
  title,
}: {
  variant: MBadgeVariant;
  children: ReactNode;
  title?: string;
}) {
  const c = BADGE_VAR[variant];
  return (
    <span
      title={title}
      className="inline-flex items-center rounded-md px-[7px] py-[2.5px] text-[10.5px] font-extrabold tracking-[0.03em]"
      style={{
        color: c,
        background: `color-mix(in srgb, ${c} 13%, transparent)`,
        border: `1px solid color-mix(in srgb, ${c} 26%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

export function Pill({
  active = false,
  onClick,
  children,
  color,
  ariaLabel,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  color?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      className="inline-flex min-h-[32px] flex-none items-center rounded-full px-[13px] py-[7px] text-[12px] font-bold transition-colors"
      style={{
        background: active ? "var(--th-accent-glow)" : "var(--th-chip-bg)",
        border: `1px solid ${active ? "var(--th-accent-border)" : "var(--th-border-subtle)"}`,
        color: active ? "var(--th-accent)" : (color ?? "var(--th-text-secondary)"),
      }}
    >
      {children}
    </button>
  );
}
