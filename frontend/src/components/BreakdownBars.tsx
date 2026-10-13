import { Link } from "react-router-dom";
import { TERMS } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";

export const CATEGORY_LABELS: Record<string, string> = {
  servers: TERMS.servers,
  clientpc: TERMS.clientPcs,
  network: "Network",
  storage: "Storage",
  hypervisors: "Hypervisors",
  printers: "Printers",
  iot: "IoT",
  other: "Other",
  unassigned: "Unclassified",
};

export interface BreakdownSegment {
  label: string;
  value: number;
  tone: string;
}

export interface BreakdownRow {
  key: string;
  label: string;
  count: number;
  to: string;
  /** Splits the bar (and adds a caption), e.g. a category's devices by status. */
  segments?: BreakdownSegment[];
}

/**
 * Ranked counts as share-of-total bars, the same look as "Devices by client".
 * The list spreads over the card's height, so a card beside a taller one
 * leaves no empty block at the bottom.
 */
export default function BreakdownBars({ rows, total, unit }: { rows: BreakdownRow[]; total: number; unit: string }) {
  return (
    <ul className="flex flex-1 flex-col justify-between gap-1 px-5 pb-3">
      {rows.map((row, index) => {
        const pct = total > 0 ? (row.count / total) * 100 : 0;
        const share = pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
        const parts = row.segments?.filter((segment) => segment.value > 0) ?? [];
        const caption = parts.map((segment) => `${formatCount(segment.value)} ${segment.label}`).join(" · ");
        return (
          <li key={row.key} className="th-share-row text-[13px]" style={{ "--i": index } as React.CSSProperties}>
            <Link
              to={row.to}
              title={`${row.label}: ${formatCount(row.count)} ${row.count === 1 ? unit : `${unit}s`} (${share})${caption ? `, ${caption}` : ""}`}
              className="-mx-2 block rounded-md px-2 py-1 transition-colors hover:bg-[var(--th-sidebar-nav-hover)]"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="truncate" style={{ color: "var(--th-text-secondary)" }}>
                  {row.label}
                </span>
                <span className="flex items-baseline gap-2 tabular-nums">
                  <span
                    key={row.count}
                    className="th-share-count font-semibold"
                    style={{ color: "var(--th-text-primary)" }}
                  >
                    {formatCount(row.count)}
                  </span>
                  <span className="w-9 text-right text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                    {share}
                  </span>
                </span>
              </div>
              <div
                className={`mt-1.5 overflow-hidden rounded-full ${parts.length > 0 ? "h-2" : "h-1.5"}`}
                style={{ background: "var(--th-ring-track)" }}
              >
                <div className="th-share-fill flex h-full gap-[2px]" style={{ width: `${pct}%` }}>
                  {parts.length > 0 ? (
                    parts.map((segment) => (
                      <span
                        key={segment.label}
                        className="h-full min-w-[2px] rounded-full"
                        style={{ flex: `${segment.value} 1 0`, background: segment.tone }}
                      />
                    ))
                  ) : (
                    <span className="h-full w-full rounded-full" style={{ background: "var(--th-accent)" }} />
                  )}
                </div>
              </div>
              {parts.length > 0 && (
                <p
                  className="mt-1.5 flex flex-wrap gap-x-3 text-[12px] tabular-nums"
                  style={{ color: "var(--th-text-muted)" }}
                >
                  {parts.map((segment) => (
                    <span key={segment.label} className="flex items-center gap-1.5">
                      <i className="h-1.5 w-1.5 rounded-full" style={{ background: segment.tone }} />
                      <span>
                        <span style={{ color: "var(--th-text-secondary)" }}>{formatCount(segment.value)}</span>{" "}
                        {segment.label}
                      </span>
                    </span>
                  ))}
                </p>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
