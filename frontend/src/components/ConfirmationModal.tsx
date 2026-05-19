import { ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import clsx from "clsx";

interface ConfirmationModalProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export default function ConfirmationModal({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = true,
  loading = false,
  onConfirm,
  onClose,
}: ConfirmationModalProps) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [loading, onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex min-h-dvh items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirmation-modal-title"
      onMouseDown={() => {
        if (!loading) onClose();
      }}
    >
      <div
        className={clsx(
          "w-full max-w-md overflow-y-auto rounded-xl border p-5 shadow-2xl",
          "max-h-[calc(100dvh-2rem)]",
          destructive ? "border-red-400/30 bg-red-950/40" : ""
        )}
        style={destructive ? {} : {
          border: "1px solid var(--th-border-card)",
          background: "var(--th-bg-surface)",
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={clsx("mb-4 flex items-center gap-2", destructive ? "text-red-200" : "")}>
          <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: "var(--th-text-secondary)" }} />
          <h3 id="confirmation-modal-title" className="text-base font-semibold" style={{ color: "var(--th-text-primary)" }}>
            {title}
          </h3>
        </div>
        <div className="text-sm leading-6" style={{ color: "var(--th-text-secondary)" }}>{children}</div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg border px-4 py-2 text-sm font-semibold transition disabled:opacity-50"
            style={{
              borderColor: "var(--th-border-input)",
              background: "var(--th-bg-input)",
              color: "var(--th-text-secondary)",
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={clsx(
              "rounded-lg px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-50",
              destructive ? "bg-red-600 hover:bg-red-500" : "bg-techi-orange hover:bg-techi-orange/90"
            )}
          >
            {loading ? `${confirmLabel}…` : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
