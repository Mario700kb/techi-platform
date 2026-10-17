import { useId, type ReactNode } from "react";
import { formatLocalDateTime } from "../../utils/time";

/** "14:05" (or "14:05:09") in the app's time zone. */
export function clock(ms: number, seconds = false): string {
  return formatLocalDateTime(new Date(ms).toISOString(), {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
}

export function duration(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** One side-panel section: the same heading, spacing and border everywhere. */
export function PanelSection({
  title,
  action,
  children,
  className = "",
  bodyClassName = "",
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`ps-section flex min-h-0 flex-col ${className}`}>
      <div className="ps-section-head">
        <h3 id={id} className="ps-section-title">
          {title}
        </h3>
        {action}
      </div>
      <div className={`min-h-0 ${bodyClassName}`}>{children}</div>
    </section>
  );
}
