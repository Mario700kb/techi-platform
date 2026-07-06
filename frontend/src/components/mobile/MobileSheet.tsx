import { ReactNode, useEffect, useRef } from "react";
import { X } from "lucide-react";

/**
 * Bottom-sheet base (MOBILE-DESIGN-SPEC.md — Design System/Bottom Sheets).
 * Renders ABOVE the BottomNav (z-60 vs z-50), locks body scroll, traps focus,
 * and closes on: scrim tap, ✕, Escape, and hardware/browser Back.
 */
export function MobileSheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Body scroll lock
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Browser/hardware Back closes the sheet instead of leaving the page.
  // Deliberately does NOT call history.back() on programmatic close (X,
  // backdrop, Apply): a sheet action that itself navigates — e.g.
  // FilterSheet's Apply, which updates the URL via setSearchParams — races
  // with React Router's own history write, and history.back() can revert
  // that navigation out from under it (confirmed: Apply's ?filter= param
  // was silently undone). The one harmless trade-off is a inert duplicate
  // history entry if the sheet is closed without any other navigation —
  // pressing Back then just consumes it silently (same URL) before the
  // next real Back takes effect.
  useEffect(() => {
    if (!open) return;
    const onPop = () => onCloseRef.current();
    window.history.pushState({ mSheet: true }, "");
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
    };
  }, [open]);

  // Focus management + Escape + minimal focus trap
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreFocusRef.current?.focus();
    };
  }, [open]);

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="m-anim fixed inset-0 z-[60] md:hidden"
        style={{
          background: "var(--th-scrim)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 250ms ease",
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="m-anim fixed bottom-0 left-0 right-0 z-[70] flex max-h-[78%] flex-col rounded-t-[20px] outline-none md:hidden"
        style={{
          background: "var(--th-bg-surface)",
          borderTop: "1px solid var(--th-border-strong)",
          boxShadow: "0 -10px 30px rgba(0, 0, 0, 0.4)",
          transform: open ? "translateY(0)" : "translateY(102%)",
          transition: "transform 260ms cubic-bezier(0.32, 0.72, 0, 1)",
          paddingBottom: footer ? undefined : "max(env(safe-area-inset-bottom), 12px)",
        }}
      >
        <div
          aria-hidden="true"
          className="mx-auto mb-[2px] mt-[9px] h-1 w-9 flex-none rounded-full opacity-50"
          style={{ background: "var(--th-text-muted)" }}
        />
        <div
          className="flex flex-none items-center justify-between px-4 pb-[10px] pt-2"
          style={{ borderBottom: "1px solid var(--th-border-subtle)" }}
        >
          <span className="text-[14px] font-extrabold" style={{ color: "var(--th-text-primary)" }}>
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-xl"
            style={{ color: "var(--th-text-muted)" }}
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-[14px]">{children}</div>
        {footer && (
          <div
            className="flex flex-none gap-2 px-4 py-3"
            style={{
              borderTop: "1px solid var(--th-border-subtle)",
              paddingBottom: "max(env(safe-area-inset-bottom), 12px)",
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </>
  );
}
