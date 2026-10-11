import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Card header and dialog shell shared by the pages built on the th-onb card
// system (Onboarding, Reports, Audit Log, Clients).

export function CardHead({ icon: Icon, tone, title, subtitle, aside }: { icon: LucideIcon; tone: string; title: string; subtitle?: string; aside?: ReactNode }) {
  return (
    <div className="th-onb-card-head">
      <div className="th-onb-card-title">
        <span className="th-onb-icon" style={{ "--onb-tone": tone } as CSSProperties}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate">{title}</span>
          {subtitle && <small className="truncate">{subtitle}</small>}
        </span>
      </div>
      {aside}
    </div>
  );
}

export function ModalShell({ title, subtitle, icon, width = "max-w-lg", onClose, footer, children }: { title: string; subtitle?: string; icon: LucideIcon; width?: string; onClose: () => void; footer?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return createPortal(
    <div className="th-modal-scrim fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title} onMouseDown={onClose}>
      <div
        className={`th-modal th-onb flex max-h-[calc(100dvh-2rem)] w-full ${width} flex-col overflow-hidden rounded-xl shadow-2xl`}
        style={{ border: "1px solid var(--th-border-card)", background: "var(--th-bg-surface)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <CardHead
          icon={icon}
          tone="var(--th-accent)"
          title={title}
          subtitle={subtitle}
          aside={<button type="button" className="th-onb-action" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>}
        />
        <div className="th-onb-body min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-5 py-4" style={{ borderTop: "1px solid var(--th-border-subtle)" }}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
