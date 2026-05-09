import { ReactNode } from "react";
import clsx from "clsx";

interface BadgeProps {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "neutral";
  className?: string;
}

const variantClasses = {
  primary: "bg-techi-orange text-slate-950",
  secondary: "bg-techi-pink text-slate-950",
  ghost: "bg-white/5 text-slate-200",
  neutral: "bg-slate-800 text-slate-200",
};

export default function Badge({ children, variant = "primary", className }: BadgeProps) {
  return (
    <span className={clsx("inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold", variantClasses[variant], className)}>
      {children}
    </span>
  );
}
