import { ReactNode } from "react";
import clsx from "clsx";

interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Centered "nothing here yet" block: icon, one line of context, one next step. */
export default function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={clsx("flex flex-col items-center gap-2 px-6 py-10 text-center", className)}>
      {icon && (
        <span
          className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl border"
          style={{ borderColor: "var(--th-border-default)", background: "var(--th-chip-bg)", color: "var(--th-text-muted)" }}
        >
          {icon}
        </span>
      )}
      <p className="text-[14px] font-semibold" style={{ color: "var(--th-text-primary)" }}>{title}</p>
      {description && (
        <p className="max-w-sm text-[13px]" style={{ color: "var(--th-text-muted)" }}>{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
