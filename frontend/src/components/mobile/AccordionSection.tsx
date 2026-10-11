import { ReactNode, useState } from "react";
import { ChevronRight } from "lucide-react";

/**
 * Device Details accordion section (MOBILE-DESIGN-SPEC.md — Device Details):
 * lazy-mounts its body only once opened (mirrors the lazy-tab behavior the
 * desktop DeviceDrawer relies on for its tabs). `onFirstOpen` runs once,
 * from the tap, for sections that load their data on demand.
 */
export function AccordionSection({
  icon,
  title,
  subtitle,
  badge,
  tone = "var(--th-text-secondary)",
  defaultOpen = false,
  onFirstOpen,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  tone?: string;
  defaultOpen?: boolean;
  onFirstOpen?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [everOpened, setEverOpened] = useState(defaultOpen);

  const toggle = () => {
    setOpen((v) => !v);
    if (!everOpened) {
      setEverOpened(true);
      onFirstOpen?.();
    }
  };

  return (
    <section className="th-onb-card th-macc">
      <button type="button" onClick={toggle} aria-expanded={open} className="th-macc-head">
        <span className="th-onb-icon !h-8 !w-8" style={{ "--onb-tone": tone } as React.CSSProperties}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold" style={{ color: "var(--th-text-primary)" }}>{title}</span>
          {subtitle && <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>{subtitle}</span>}
        </span>
        {badge}
        <ChevronRight className="th-onb-chevron h-4 w-4 flex-none" data-open={open || undefined} style={{ color: "var(--th-text-faint)" }} />
      </button>
      {everOpened && <div className={open ? "th-macc-body th-onb-reveal" : "hidden"}>{children}</div>}
    </section>
  );
}
