import { ButtonHTMLAttributes, forwardRef } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import clsx from "clsx";

export type ConnectSize = "sm" | "md" | "lg";

interface ConnectButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** sm: table rows · md: panels and drawers · lg: touch / mobile cards */
  size?: ConnectSize;
  loading?: boolean;
  /** Needs attention before connecting (e.g. a credential is missing). */
  tone?: "default" | "warning";
  label?: string;
}

/**
 * The one Connect button. Every place that opens a remote session renders
 * this, so it looks and behaves the same in tables, drawers and on mobile.
 */
const ConnectButton = forwardRef<HTMLButtonElement, ConnectButtonProps>(function ConnectButton(
  { size = "md", loading = false, tone = "default", label = "Connect", className, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={clsx("th-connect", className)}
      data-size={size}
      data-tone={tone}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 className="th-connect-icon animate-spin" /> : <ExternalLink className="th-connect-icon" />}
      {label}
    </button>
  );
});

export default ConnectButton;
