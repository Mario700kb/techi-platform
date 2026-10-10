import { ReactNode, useState } from "react";
import { ChevronRight } from "lucide-react";

/**
 * Device Details accordion section (MOBILE-DESIGN-SPEC.md — Device Details):
 * lazy-mounts its body only once opened (mirrors the lazy-tab behavior the
 * existing desktop DeviceDrawer already relies on for its tabs).
 */
export function AccordionSection({
  icon,
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [everOpened, setEverOpened] = useState(defaultOpen);

  const toggle = () => {
    setOpen((v) => !v);
    if (!everOpened) setEverOpened(true);
  };

  return (
    <div
      className="overflow-hidden rounded-[14px]"
      style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex min-h-[48px] w-full items-center gap-[10px] px-4 py-[13px] text-left text-[14px] font-bold"
        style={{ color: "var(--th-text-primary)" }}
      >
        <span className="flex-none" style={{ color: "var(--th-text-secondary)" }}>{icon}</span>
        {title}
        {badge && <span className="ml-1">{badge}</span>}
        <ChevronRight
          className="ml-auto h-[14px] w-[14px] flex-none transition-transform"
          style={{ color: "var(--th-text-muted)", transform: open ? "rotate(90deg)" : undefined }}
        />
      </button>
      {everOpened && (
        <div
          className={open ? "flex flex-col gap-[10px] px-4 pb-4 text-[13px]" : "hidden"}
          style={{ borderTop: "1px solid var(--th-border-subtle)", paddingTop: 12, color: "var(--th-text-secondary)" }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
