import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

// Card header shared by the pages built on the th-onb card system.

export function CardHead({
  icon: Icon,
  tone,
  title,
  subtitle,
  aside,
}: {
  icon: LucideIcon;
  tone: string;
  title: string;
  subtitle?: string;
  aside?: ReactNode;
}) {
  return (
    <div className="th-onb-card-head">
      <div className="th-onb-card-title">
        <span className="th-onb-icon" style={{ "--onb-tone": tone } as CSSProperties}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate">{title}</span>
          {subtitle && <small className="truncate">{subtitle}</small>}
        </span>
      </div>
      {aside}
    </div>
  );
}
