import { ChevronLeft } from "lucide-react";
import { FreshnessPill } from "./FreshnessPill";

/**
 * Mobile top bar (MOBILE-DESIGN-SPEC.md — Design System/Top Bar): back on
 * sub-pages, the nav section above the screen title, FreshnessPill on the
 * right. Desktop keeps its own Topbar.
 */
export function MobileTopBar({
  title,
  section,
  showBack = false,
  onBack,
}: {
  title: string;
  section?: string;
  showBack?: boolean;
  onBack?: () => void;
}) {
  return (
    <header className="th-mtop md:hidden">
      {showBack && (
        <button type="button" onClick={onBack} aria-label="Back" className="th-mtop-back">
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}
      <div className="min-w-0 flex-1">
        {section && <span className="th-mtop-section">{section}</span>}
        <h1 className="th-mtop-title">{title}</h1>
      </div>
      <FreshnessPill />
    </header>
  );
}
