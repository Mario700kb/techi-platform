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
    <div role="status" className="th-msnack md:hidden">
      <span className="min-w-0 flex-1">{message}</span>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction} className="th-msnack-action">
          {actionLabel}
        </button>
      )}
    </div>
  );
}
