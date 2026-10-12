import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

import { formatCount } from "../../utils/number";
import Select from "./Select";

export interface TablePaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  /** Plural noun for the count, e.g. "devices", "alerts". */
  itemLabel: string;
  loading?: boolean;
  /** Extra context after the count, e.g. "3 selected". */
  extra?: ReactNode;
}

// Page numbers with gaps: 1 … 4 5 6 … 20. Seven slots at most, so the
// control keeps one width while paging.
export function pageNumbers(page: number, totalPages: number): (number | null)[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const nums: (number | null)[] = [1];
  const lo = Math.max(2, Math.min(page - 1, totalPages - 4));
  const hi = Math.min(totalPages - 1, Math.max(page + 1, 5));
  // A gap that would hide a single page shows that page instead.
  if (lo === 3) nums.push(2);
  else if (lo > 3) nums.push(null);
  for (let p = lo; p <= hi; p++) nums.push(p);
  if (hi === totalPages - 2) nums.push(totalPages - 1);
  else if (hi < totalPages - 2) nums.push(null);
  nums.push(totalPages);
  return nums;
}

/** The one table footer: range and total, rows per page, and page controls. */
export default function TablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50],
  itemLabel,
  loading = false,
  extra,
}: TablePaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const first = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const last = Math.min(current * pageSize, total);

  return (
    <nav className="th-pagination" aria-label={`${itemLabel} pages`}>
      <div className="th-pagination-side">
        <span className="tabular-nums" aria-live="polite">
          {total === 0
            ? `No ${itemLabel}`
            : `Showing ${formatCount(first)}–${formatCount(last)} of ${formatCount(total)} ${itemLabel}`}
        </span>
        {extra && <span className="th-pagination-extra">{extra}</span>}
        {onPageSizeChange && (
          <Select
            id={`${itemLabel}-page-size`}
            aria-label="Rows per page"
            className="!h-8 w-[118px]"
            value={String(pageSize)}
            onChange={(value) => onPageSizeChange(Number(value))}
            options={pageSizeOptions.map((size) => ({ value: String(size), label: `${size} / page` }))}
          />
        )}
        {loading && (
          <Loader2
            className="h-3.5 w-3.5 animate-spin"
            style={{ color: "var(--th-text-muted)" }}
            aria-label="Loading"
          />
        )}
      </div>

      <div className="th-pagination-pages">
        <button
          type="button"
          className="th-page-btn"
          disabled={current <= 1}
          onClick={() => onPageChange(current - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        {pageNumbers(current, totalPages).map((p, i) =>
          p === null ? (
            <span key={`gap-${i}`} className="th-page-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className="th-page-btn tabular-nums"
              aria-current={p === current ? "page" : undefined}
              aria-label={`Page ${p}`}
              onClick={() => onPageChange(p)}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          className="th-page-btn"
          disabled={current >= totalPages}
          onClick={() => onPageChange(current + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </nav>
  );
}
