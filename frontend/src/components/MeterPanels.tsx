import { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { Boxes, Cpu, HardDrive, Monitor, Network, Printer, Server } from "lucide-react";

import { TERMS } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";

// Panels shared by the Dashboard and the client profile: a segmented ring with
// its legend, and one-line meters (mark, name, bar, count, share) that line up
// across cards. Styles: .th-cp-* in index.css.

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

export const CATEGORY_ICONS: Record<string, typeof Monitor> = {
  clientpc: Monitor,
  servers: Server,
  network: Network,
  storage: HardDrive,
  hypervisors: Boxes,
  printers: Printer,
  iot: Cpu,
};

export interface RingSegment {
  key: string;
  label: string;
  value: number;
  tone: string;
  /** Shown instead of the share, for a figure that is not part of the total. */
  share?: string;
}

export function percent(value: number, total: number): string {
  if (total <= 0) return "0%";
  const pct = (value / total) * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

/** A donut split into segments; each draws in, then glides to a new value. */
export function SegmentRing({
  segments,
  total,
  center,
  caption,
  size = 128,
}: {
  segments: RingSegment[];
  total: number;
  center: string;
  caption: string;
  /** 128 on the client profile; the Dashboard's denser cards use 108. */
  size?: number;
}) {
  const stroke = size >= 120 ? 12 : 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const shown = total > 0 ? segments.filter((segment) => segment.value > 0) : [];
  const gap = shown.length > 1 ? 3 : 0;
  const starts = shown.map((_, i) => shown.slice(0, i).reduce((sum, seg) => sum + (seg.value / total) * c, 0));
  return (
    <div className="th-cp-ring" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-90" aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          style={{ stroke: "var(--th-ring-track)" }}
        />
        {shown.map((segment, i) => (
          <circle
            key={segment.key}
            className="th-cp-ring-seg"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            style={
              {
                stroke: segment.tone,
                strokeDasharray: `${Math.max((segment.value / total) * c - gap, 1.5)} ${c}`,
                strokeDashoffset: -starts[i],
                "--c": c,
                "--i": i,
              } as CSSProperties
            }
          />
        ))}
      </svg>
      <div className="th-cp-ring-center">
        <span key={center} className="th-share-count text-[22px] font-semibold leading-7 tabular-nums">
          {center}
        </span>
        <span className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
          {caption}
        </span>
      </div>
    </div>
  );
}

/** The ring's legend: one row per segment, count and share; a row can filter. */
export function RingLegend({
  segments,
  total,
  onSelect,
}: {
  segments: RingSegment[];
  total: number;
  onSelect?: (key: string) => void;
}) {
  return (
    <ul className="th-cp-legend">
      {segments.map((segment, index) => (
        <li key={segment.key} className="th-share-row" style={{ "--i": index } as CSSProperties}>
          <button type="button" onClick={() => onSelect?.(segment.key)} disabled={!onSelect}>
            <i style={{ background: segment.tone }} aria-hidden="true" />
            <span className="truncate">{segment.label}</span>
            <strong key={segment.value} className="th-share-count tabular-nums">
              {formatCount(segment.value)}
            </strong>
            <small className="tabular-nums">{segment.share ?? percent(segment.value, total)}</small>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * One line per item — mark, name, share bar, count, share — the same grid in
 * every overview card, so the four cards read as one table.
 */
export function MeterRow({
  index,
  mark,
  label,
  count,
  total,
  segments,
  tone = "var(--th-accent)",
  share,
  selected = false,
  onClick,
  to,
  title,
}: {
  index: number;
  mark?: React.ReactNode;
  label: string;
  count: number;
  total: number;
  segments?: RingSegment[];
  tone?: string;
  /** Replaces the share column, e.g. with when the item was last seen. */
  share?: string;
  selected?: boolean;
  onClick?: () => void;
  /** A page to open: the row is a link (new tab, copy address) instead of a button. */
  to?: string;
  title?: string;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  const parts = segments?.filter((segment) => segment.value > 0) ?? [];
  const body = (
    <>
      <span className="th-cp-meter-name">
        {mark}
        <span className="truncate">{label}</span>
      </span>
      <span className="th-cp-meter-track">
        <span className="th-share-fill flex h-full gap-[2px]" style={{ width: `${pct}%` }}>
          {parts.length > 0 ? (
            parts.map((segment) => (
              <span
                key={segment.key}
                className="h-full min-w-[2px] rounded-full"
                style={{ flex: `${segment.value} 1 0`, background: segment.tone }}
              />
            ))
          ) : (
            <span className="h-full w-full rounded-full" style={{ background: tone }} />
          )}
        </span>
      </span>
      <strong key={count} className="th-share-count tabular-nums">
        {formatCount(count)}
      </strong>
      <small className="tabular-nums">{share ?? percent(count, total)}</small>
    </>
  );
  return (
    <li className="th-share-row" style={{ "--i": index } as CSSProperties}>
      {to ? (
        <Link to={to} className="th-cp-meter" title={title}>
          {body}
        </Link>
      ) : (
        <button
          type="button"
          className="th-cp-meter"
          data-selected={selected || undefined}
          aria-pressed={selected || undefined}
          onClick={onClick}
          title={title}
        >
          {body}
        </button>
      )}
    </li>
  );
}

export function SubHead({ children }: { children: React.ReactNode }) {
  return <div className="th-cp-subhead">{children}</div>;
}

export function QuietLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-5 py-3 text-[12px]" style={{ color: "var(--th-text-faint)" }}>
      {children}
    </p>
  );
}
