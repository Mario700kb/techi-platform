import type { CSSProperties } from "react";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";

import { useExitAnimation } from "../hooks/useExitAnimation";
import { dismissToast, type ToastItem, useToasts } from "../services/toast";

const ICON = { success: CheckCircle2, error: TriangleAlert, info: Info } as const;
const TONE = {
  success: "var(--th-status-online)",
  error: "var(--th-status-critical)",
  info: "var(--th-status-info)",
} as const;

function ToastCard({ item }: { item: ToastItem }) {
  const ref = useExitAnimation<HTMLDivElement>();
  const Icon = ICON[item.tone];
  return (
    <div
      ref={ref}
      className="th-toast th-toaster-card"
      role={item.tone === "error" ? "alert" : "status"}
      data-tone={item.tone}
      style={{ "--toast-tone": TONE[item.tone], "--toast-ms": `${item.durationMs}ms` } as CSSProperties}
    >
      <Icon className="th-toaster-icon" aria-hidden="true" />
      <p className="th-toaster-message">{item.message}</p>
      {item.action && (
        <button
          type="button"
          className="th-toaster-action"
          onClick={() => {
            item.action?.onClick();
            dismissToast(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="th-toaster-close" aria-label="Dismiss" onClick={() => dismissToast(item.id)}>
        <X className="h-3.5 w-3.5" />
      </button>
      {/* Its running out is the timer: it pauses with the pointer or focus on the toast. */}
      <span className="th-toaster-time" aria-hidden="true" onAnimationEnd={() => dismissToast(item.id)} />
    </div>
  );
}

/** The one place toasts appear (services/toast.ts); mounted once at the root. */
export default function Toaster() {
  const items = useToasts();
  return (
    <section className="th-toaster" aria-label="Notifications" aria-live="polite">
      {items.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </section>
  );
}
