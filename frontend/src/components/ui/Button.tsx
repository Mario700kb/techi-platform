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
        "inline-flex items-center justify-center rounded-2xl bg-techi-orange px-4 py-2 text-sm font-semibold text-white transition hover:bg-techi-pink",
        sizeClasses[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
