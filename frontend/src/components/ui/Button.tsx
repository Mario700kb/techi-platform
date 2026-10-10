import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "secondary" | "danger" | "ghost";
}

export default function Button({ children, className, size = "md", variant = "primary", ...props }: ButtonProps) {
  const sizeClasses = {
    sm: "min-h-8 px-3 py-1.5 text-[13px]",
    md: "min-h-9 px-3.5 py-2 text-[13px]",
    lg: "min-h-10 px-4 py-2 text-sm",
  };
  const variantClasses = {
    primary: "th-btn-primary",
    secondary: "th-btn-secondary",
    danger: "th-btn-danger",
    ghost: "th-btn-ghost",
  };

  return (
    <button
      className={clsx(
        "th-btn inline-flex items-center justify-center gap-2 border transition duration-150 focus:outline-none focus:ring-2 focus:ring-techi-orange/25",
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
