import { useEffect, useId, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type ModalTone = "accent" | "danger" | "warning" | "info";
export type ModalSize = "sm" | "md" | "lg" | "xl";

const TONE_VAR: Record<ModalTone, string> = {
  accent: "var(--th-accent)",
  danger: "var(--th-status-critical)",
  warning: "var(--th-status-warning)",
  info: "var(--th-status-info)",
};

export interface ModalProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  tone?: ModalTone;
  size?: ModalSize;
  onClose: () => void;
  /** Actions, right-aligned in the footer. Omit for a dialog without one. */
  footer?: ReactNode;
  /** While true the dialog cannot be dismissed (scrim, Escape, close button). */
  busy?: boolean;
  /** Body without its own padding, for content that draws edge to edge. */
  flush?: boolean;
  children: ReactNode;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one dialog. Every modal in the console renders through it, so they
 * share a header (tone icon, title, subtitle, close), a scrolling body and a
 * right-aligned footer, open and close the same way, trap focus, and give
 * focus back to whatever opened them.
 */
export default function Modal({
  title,
  subtitle,
  icon: Icon,
  tone = "accent",
  size = "md",
  onClose,
  footer,
  busy = false,
  flush = false,
  children,
}: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const panel = panelRef.current;
    const first =
      panel?.querySelector<HTMLElement>("[data-autofocus]") ??
      panel?.querySelector<HTMLElement>(`.th-modal-body ${FOCUSABLE}`);
    (first ?? panel)?.focus({ preventScroll: true });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      className="th-modal-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="th-modal th-onb"
        data-size={size}
        style={{ "--modal-tone": TONE_VAR[tone] } as CSSProperties}
      >
        <header className="th-modal-head">
          {Icon && (
            <span className="th-modal-icon" aria-hidden="true">
              <Icon className="h-[18px] w-[18px]" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="th-modal-title">
              {title}
            </h3>
            {subtitle && <p className="th-modal-subtitle">{subtitle}</p>}
          </div>
          <button type="button" className="th-onb-action" onClick={onClose} disabled={busy} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className={flush ? "th-modal-body th-modal-body--flush" : "th-modal-body"}>{children}</div>
        {footer && <footer className="th-modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
