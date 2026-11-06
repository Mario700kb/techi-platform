import { ReactNode, useState } from "react";
import { ChevronDown } from "lucide-react";

/**
 * On a phone a long form or filter panel waits behind one row, so the page
 * opens on its data. From md up the toggle is gone and the content stays in
 * the layout exactly as if this wrapper were not there.
 */
export function MobileCollapse({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="th-mcollapse" data-open={open || undefined}>
      <button type="button" className="th-mcollapse-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {hint && <small>{hint}</small>}
        <ChevronDown className="th-mcollapse-chevron" aria-hidden="true" />
      </button>
      <div className="th-mcollapse-body">{children}</div>
    </div>
  );
}
