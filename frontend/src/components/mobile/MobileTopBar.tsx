import { ChevronLeft } from "lucide-react";
import { FreshnessPill } from "./FreshnessPill";

/**
 * Mobile top bar, 52px (MOBILE-DESIGN-SPEC.md — Design System/Top Bar):
 * screen title (+ back on sub-pages), FreshnessPill on the right.
 * The global-search icon lands in Phase 3 (Implementation Note #2).
 * Desktop keeps its own Topbar untouched.
 */
export function MobileTopBar({
  title,
  showBack = false,
  onBack,
}: {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
}) {
  return (
    <header
      className="flex h-[52px] flex-none items-center justify-between gap-3 px-3 md:hidden"
      style={{
        background: "var(--th-bg-topbar)",
        borderBottom: "1px solid var(--th-border-default)",
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        {showBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="flex h-11 w-11 flex-none items-center justify-center rounded-xl"
            style={{ color: "var(--th-text-secondary)" }}
          >
            <ChevronLeft className="h-[22px] w-[22px]" />
          </button>
        )}
        <h1
          className="truncate text-[16px] font-extrabold tracking-[-0.01em]"
          style={{ color: "var(--th-text-primary)" }}
        >
          {title}
        </h1>
      </div>
      <FreshnessPill />
    </header>
  );
}
