import clsx from "clsx";

interface SkeletonRowsProps {
  rows?: number;
  className?: string;
}

/**
 * Placeholder rows in the shape of the list that is loading: they shimmer
 * (transform only) and fade towards the bottom, so the page keeps its layout
 * when the rows arrive instead of jumping from a "Loading…" line.
 */
export default function SkeletonRows({ rows = 5, className }: SkeletonRowsProps) {
  return (
    <div className={clsx("flex-1", className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="th-alerts-skeleton" style={{ opacity: Math.max(0.25, 1 - i * 0.15) }} />
      ))}
    </div>
  );
}
