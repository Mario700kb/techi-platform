import type { ReactNode } from "react";

/**
 * One header for every section of the device Overview: the title on the
 * left, a short muted fact on the right ("Live · every 3 s", "1 active"),
 * and an optional action after it.
 */
export default function SectionHeader({
  title,
  meta,
  metaTitle,
  action,
}: {
  title: string;
  meta?: ReactNode;
  /** Tooltip for the meta, when it shortens something longer. */
  metaTitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="th-section-head">
      <h3 className="premium-kicker">{title}</h3>
      {(meta || action) && (
        <div className="th-section-head-side">
          {meta && (
            <span className="th-section-meta" title={metaTitle}>
              {meta}
            </span>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
