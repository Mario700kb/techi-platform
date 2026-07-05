import { useEffect, useRef } from "react";

/**
 * Snackbar with optional action (MOBILE-DESIGN-SPEC.md — Alerts/Dismiss UNDO).
 * Positioned above the BottomNav; auto-hides after `duration` ms.
 */
export function Snackbar({
  open,
  message,
  actionLabel,
  onAction,
  onClose,
  duration = 5000,
}: {
  open: boolean;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onClose: () => void;
  duration?: number;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => onCloseRef.current(), duration);
    return () => window.clearTimeout(id);
  }, [open, duration, message]);

  if (!open) return null;

  return (
    <div
      role="status"
      className="fixed left-3 right-3 z-[80] flex items-center gap-[10px] rounded-xl px-[14px] py-[11px] text-[12.5px] font-semibold md:hidden"
      style={{
        bottom: "calc(64px + 12px + env(safe-area-inset-bottom))",
        background: "var(--th-bg-elevated)",
        border: "1px solid var(--th-border-strong)",
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.4)",
        color: "var(--th-text-primary)",
      }}
    >
      {message}
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="ml-auto min-h-[32px] px-2 text-[12.5px] font-extrabold"
          style={{ color: "var(--th-accent)" }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
