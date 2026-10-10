import { HealthState } from "../types/telemetry";

interface HealthBadgeProps {
  state: HealthState;
  score?: number | null;
  showLabel?: boolean;
  size?: "sm" | "xs";
}

const CONFIG: Record<HealthState, { dot: string; label: string; text: string }> = {
  healthy: { dot: "bg-emerald-400", label: "Healthy", text: "text-emerald-400" },
  warning: { dot: "bg-amber-400", label: "Warning", text: "text-amber-400" },
  critical: { dot: "bg-red-400 shadow-[0_0_5px_color-mix(in_srgb,var(--th-status-critical)_70%,transparent)]", label: "Critical", text: "text-red-400" },
};

export default function HealthBadge({ state, score, showLabel = false, size = "sm" }: HealthBadgeProps) {
  const cfg = CONFIG[state];
  const dotSize = size === "xs" ? "h-1.5 w-1.5" : "h-2 w-2";
  const textSize = size === "xs" ? "text-[11px]" : "text-xs";

  return (
    <span className={`inline-flex items-center gap-1.5 ${textSize} ${cfg.text}`}>
      <span className={`inline-block flex-none rounded-full ${dotSize} ${cfg.dot}`} />
      {showLabel && `${cfg.label}${score != null ? ` ${score}` : ""}`}
    </span>
  );
}
