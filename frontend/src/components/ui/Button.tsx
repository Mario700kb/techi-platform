import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  size?: "sm" | "md" | "lg";
}

export default function Button({ children, className, size = "md", ...props }: ButtonProps) {
  const sizeClasses = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2 text-sm",
    lg: "px-6 py-3 text-base",
  };

  return (
    <button
      className={clsx(
        "th-btn-primary inline-flex items-center justify-center rounded-lg border border-orange-300/20 bg-gradient-to-r from-techi-orange to-techi-pink px-4 py-2 text-sm font-semibold text-white shadow-[0_0_24px_rgba(255,85,63,0.2)] transition hover:border-orange-200/40 hover:shadow-[0_0_30px_rgba(255,63,50,0.24)] focus:outline-none focus:ring-2 focus:ring-techi-orange/40",
        sizeClasses[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
