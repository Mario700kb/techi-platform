import { ReactNode } from "react";
import clsx from "clsx";

interface BadgeProps {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "neutral";
  className?: string;
  title?: string;
}

const variantClasses = {
  primary: "border-[var(--th-accent-border)] bg-[var(--th-accent-dim-bg)] text-[var(--th-text-primary)]",
  secondary: "border-[var(--th-accent-border)] bg-[var(--th-accent-dim-bg)] text-orange-200",
  ghost: "border-[var(--th-border-input)] bg-[var(--th-btn-secondary-bg)] text-[var(--th-text-secondary)]",
  neutral: "border-[var(--th-border-input)] bg-[var(--th-bg-input)] text-[var(--th-text-secondary)]",
};

export default function Badge({ children, variant = "primary", className, title }: BadgeProps) {
  return (
    <span className={clsx("inline-flex min-h-6 items-center rounded-full border px-3 py-1 text-xs font-semibold leading-none", variantClasses[variant], className)} title={title}>
      {children}
    </span>
  );
}
