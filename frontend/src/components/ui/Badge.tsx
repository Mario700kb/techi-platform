import { ReactNode } from "react";
import clsx from "clsx";

interface BadgeProps {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "neutral";
  className?: string;
  title?: string;
}

const variantClasses = {
  primary: "th-btn-primary border-orange-300/25 bg-gradient-to-r from-techi-orange to-techi-pink text-white shadow-[0_0_18px_rgba(255,85,63,0.18)]",
  secondary: "border-red-300/25 bg-techi-pink/15 text-red-100",
  ghost: "border-white/[0.12] bg-white/[0.07] text-slate-100",
  neutral: "border-slate-500/50 bg-slate-900/85 text-slate-100",
};

export default function Badge({ children, variant = "primary", className, title }: BadgeProps) {
  return (
    <span className={clsx("inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold", variantClasses[variant], className)} title={title}>
      {children}
    </span>
  );
}
