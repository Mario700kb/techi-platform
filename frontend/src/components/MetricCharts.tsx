import React, { MouseEvent, ReactNode, useEffect, useState } from "react";
import type { CoverageSegment, MetricPoint, MetricsRange } from "../api/monitoring";
import { formatLocalDateTime, parseUTC } from "../utils/time";

// Hand-written SVG charts for a device's metrics (Monitoring tab and the
// Overview "Last 24 hours" card). They measure their box, so text never
// stretches, and draw in theme tokens only.

const RES_MS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "1h": 3_600_000, "1d": 86_400_000 };

export const RANGE_LABEL: Record<MetricsRange, string> = {
  "1h": "1 h",
  "24h": "24 h",
  "7d": "7 days",
  "30d": "30 days",
  "13mo": "13 months",
};

export const RESOLUTION_WORD: Record<string, string> = {
  "1m": "1-minute",
  "5m": "5-minute",
  "1h": "hourly",
  "1d": "daily",
};

export function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${Math.round(v)}%`;
}

/** "14:05" for short ranges, "12 Oct" for days, "Oct 26" for months. */
export function axisTime(iso: string, range: MetricsRange): string {
  if (range === "1h" || range === "24h") return formatLocalDateTime(iso, { hour: "2-digit", minute: "2-digit" });
  if (range === "13mo") return formatLocalDateTime(iso, { month: "short", year: "2-digit" });
  return formatLocalDateTime(iso, { day: "numeric", month: "short" });
}

function tipTime(iso: string, range: MetricsRange): string {
  if (range === "13mo") return formatLocalDateTime(iso, { day: "numeric", month: "short", year: "numeric" });
  if (range === "30d")
    return formatLocalDateTime(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return formatLocalDateTime(iso);
}

/** Size of the element in CSS pixels, so the chart fills its card without distortion. */
function useWidth<T extends HTMLElement>(fallback = 480) {
  const [el, ref] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setWidth(Math.max(200, w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return { ref, width };
}

/** A round top for the y axis: 1, 2 or 5 times a power of ten. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export interface ChartSeries {
  key: string;
  label: string;
  /** CSS colour (a token). */
  tone: string;
  avg: (p: MetricPoint) => number | null;
  /** The highest value in each bucket, drawn as a band above the line. */
  max?: (p: MetricPoint) => number | null;
}

interface TimeChartProps {
  label: string;
  points: MetricPoint[];
  start: string;
  end: string;
  range: MetricsRange;
  resolution: string;
  series: ChartSeries[];
  /** Fixed top of the y axis (100 for percentages); otherwise rounded from the data. */
  domainMax?: number;
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
  threshold?: { value: number; label: string } | null;
  /** Time the device was off, shaded. */
  off?: Array<{ start: string; end: string }>;
  /** Moments marked with a vertical line (restarts). */
  markers?: Array<{ t: string; label: string }>;
  /** Stretches an alert was open, tinted behind the lines. */
  bands?: ChartBand[];
  /** More lines in the tooltip for the hovered point (e.g. its top processes). */
  tipExtra?: (p: MetricPoint) => ReactNode;
  height?: number;
}

export interface ChartBand {
  start: string;
  /** Null while still open. */
  end: string | null;
  label: string;
  tone: string;
}

const PAD = { top: 10, right: 6, bottom: 20, left: 48 };

/** Line (average) + shaded band (highest sample) over time; gaps stay gaps. */
export function TimeChart({
  label,
  points,
  start,
  end,
  range,
  resolution,
  series,
  domainMax,
  format,
  axisFormat = format,
  threshold,
  off = [],
  markers = [],
  bands = [],
  tipExtra,
  height = 120,
}: TimeChartProps) {
  const { ref, width: W } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = height;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const t0 = parseUTC(start).getTime();
  const t1 = Math.max(t0 + 1, parseUTC(end).getTime());
  const times = points.map((p) => parseUTC(p.t).getTime());
  const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * plotW;

  const peak = Math.max(
    0,
    ...points.flatMap((p) => series.flatMap((s) => [s.avg(p) ?? 0, s.max?.(p) ?? 0])),
    threshold?.value ?? 0,
  );
  const top = domainMax ?? niceMax(peak * 1.05);
  const y = (v: number) => PAD.top + plotH - (Math.min(Math.max(v, 0), top) / top) * plotH;

  // A gap longer than a few steps (agent stopped, device off) breaks the line.
  const diffs = times.slice(1).map((t, i) => t - times[i]);
  const median = diffs.length ? [...diffs].sort((a, b) => a - b)[Math.floor(diffs.length / 2)] : 0;
  const gapMs = Math.max(RES_MS[resolution] ?? 60_000, median) * 2.5;

  const runs = (get: (p: MetricPoint) => number | null) => {
    const out: number[][] = [];
    let cur: number[] = [];
    points.forEach((p, i) => {
      const v = get(p);
      if (v == null || (i > 0 && times[i] - times[i - 1] > gapMs)) {
        if (cur.length) out.push(cur);
        cur = [];
      }
      if (v != null) cur.push(i);
    });
    if (cur.length) out.push(cur);
    return out;
  };

  const onMove = (event: MouseEvent<SVGRectElement>) => {
    if (!points.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const t = t0 + ((event.clientX - rect.left) / rect.width) * (t1 - t0);
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    const best = lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t) ? lo - 1 : lo;
    setHover(best);
  };

  const hovered = hover != null ? points[hover] : null;
  const midIso = new Date((t0 + t1) / 2).toISOString();

  return (
    <div ref={ref} className="relative" style={{ height: H }}>
      <svg width={W} height={H} className="absolute inset-0 block" role="img" aria-label={label}>
        {off.map((o, i) => {
          const a = Math.max(PAD.left, x(parseUTC(o.start).getTime()));
          const b = Math.min(PAD.left + plotW, x(parseUTC(o.end).getTime()));
          if (b - a < 1) return null;
          return (
            <g key={`off-${i}`}>
              <rect
                x={a}
                y={PAD.top}
                width={b - a}
                height={plotH}
                fill="var(--th-chip-bg)"
                stroke="var(--th-border-subtle)"
                strokeDasharray="2 3"
              />
              {b - a > 56 && (
                <text x={(a + b) / 2} y={PAD.top + 12} textAnchor="middle" className="th-chart-axis">
                  Device off
                </text>
              )}
            </g>
          );
        })}
        {bands.map((band, i) => {
          const a = Math.max(PAD.left, x(parseUTC(band.start).getTime()));
          const b = Math.min(PAD.left + plotW, x(band.end ? parseUTC(band.end).getTime() : t1));
          if (b - a < 0.5) return null;
          return (
            <rect
              key={`band-${i}`}
              data-testid="chart-alert-band"
              x={a}
              y={PAD.top}
              width={Math.max(2, b - a)}
              height={plotH}
              fill={`color-mix(in srgb, ${band.tone} 13%, transparent)`}
            >
              <title>{band.label}</title>
            </rect>
          );
        })}
        {[0, top / 2, top].map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} className="th-chart-grid" />
            <text x={PAD.left - 6} y={y(tick) + 3} textAnchor="end" className="th-chart-axis">
              {axisFormat(tick)}
            </text>
          </g>
        ))}
        {threshold && threshold.value <= top && (
          <g>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(threshold.value)}
              y2={y(threshold.value)}
              stroke="var(--th-status-critical)"
              strokeOpacity={0.7}
              strokeDasharray="4 4"
            />
            <text
              x={W - PAD.right - 2}
              y={y(threshold.value) - 4}
              textAnchor="end"
              className="th-chart-axis"
              style={{ fill: "var(--th-text-muted)" }}
            >
              {threshold.label}
            </text>
          </g>
        )}
        {series.map((s) => (
          <g key={s.key} data-series={s.key}>
            {s.max &&
              runs((p) => (s.max!(p) != null && s.avg(p) != null ? s.max!(p) : null)).map((run, i) => {
                if (run.length < 2) return null;
                const upper = run.map((k) => `${x(times[k]).toFixed(1)},${y(s.max!(points[k])!).toFixed(1)}`);
                const lower = [...run]
                  .reverse()
                  .map((k) => `${x(times[k]).toFixed(1)},${y(s.avg(points[k])!).toFixed(1)}`);
                return (
                  <polygon
                    key={`band-${i}`}
                    points={[...upper, ...lower].join(" ")}
                    fill={`color-mix(in srgb, ${s.tone} 22%, transparent)`}
                  />
                );
              })}
            {runs(s.avg).map((run, i) =>
              run.length === 1 ? (
                <circle key={`dot-${i}`} cx={x(times[run[0]])} cy={y(s.avg(points[run[0]])!)} r={2} fill={s.tone} />
              ) : (
                <polyline
                  key={`line-${i}`}
                  points={run.map((k) => `${x(times[k]).toFixed(1)},${y(s.avg(points[k])!).toFixed(1)}`).join(" ")}
                  fill="none"
                  stroke={s.tone}
                  strokeWidth={1.75}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ),
            )}
          </g>
        ))}
        {markers.map((m, i) => {
          const at = x(parseUTC(m.t).getTime());
          if (at < PAD.left || at > PAD.left + plotW) return null;
          return (
            <g key={`marker-${i}`} data-testid="chart-marker">
              <line
                x1={at}
                x2={at}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke="var(--th-status-info)"
                strokeOpacity={0.8}
                strokeDasharray="3 3"
              />
              <circle cx={at} cy={PAD.top} r={2.5} fill="var(--th-status-info)" />
              <title>{m.label}</title>
            </g>
          );
        })}
        <text x={PAD.left} y={H - 4} className="th-chart-axis">
          {axisTime(start, range)}
        </text>
        <text x={PAD.left + plotW / 2} y={H - 4} textAnchor="middle" className="th-chart-axis">
          {axisTime(midIso, range)}
        </text>
        <text x={W - PAD.right} y={H - 4} textAnchor="end" className="th-chart-axis">
          now
        </text>
        {hovered && hover != null && (
          <g>
            <line
              x1={x(times[hover])}
              x2={x(times[hover])}
              y1={PAD.top}
              y2={PAD.top + plotH}
              className="th-chart-cross"
            />
            {series.map((s) => {
              const v = s.avg(hovered);
              return v == null ? null : (
                <circle key={s.key} cx={x(times[hover])} cy={y(v)} r={3.5} fill={s.tone} stroke="var(--th-bg-card)" />
              );
            })}
          </g>
        )}
        <rect
          x={PAD.left}
          y={0}
          width={Math.max(0, plotW)}
          height={H}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
      {hovered && hover != null && (
        <div
          className="th-chart-tip"
          style={{ left: `${Math.min(84, Math.max(16, (x(times[hover]) / W) * 100))}%` }}
          role="status"
        >
          <span style={{ color: "var(--th-text-muted)" }}>{tipTime(hovered.t, range)}</span>
          {series.map((s) => {
            const avg = s.avg(hovered);
            const max = s.max?.(hovered);
            return (
              <span key={s.key} className="flex items-center gap-1.5">
                {series.length > 1 && (
                  <i className="inline-block h-2 w-2 rounded-sm" style={{ background: s.tone }} aria-hidden="true" />
                )}
                {series.length > 1 ? `${s.label} ` : "avg "}
                <strong>{avg == null ? "no data" : format(avg)}</strong>
                {max != null && (
                  <span style={{ color: "var(--th-text-muted)" }}>
                    · peak <strong style={{ color: "var(--th-text-primary)" }}>{format(max)}</strong>
                  </span>
                )}
              </span>
            );
          })}
          {hovered.expected > 0 && hovered.samples < hovered.expected && (
            <span style={{ color: "var(--th-text-muted)" }}>
              {hovered.samples} of {hovered.expected} samples
            </span>
          )}
          {bands
            .filter((band) => {
              const t = times[hover];
              return parseUTC(band.start).getTime() <= t && (!band.end || parseUTC(band.end).getTime() >= t);
            })
            .map((band, i) => (
              <span key={`tip-band-${i}`} className="flex items-center gap-1.5" style={{ color: band.tone }}>
                <i className="inline-block h-2 w-2 rounded-sm" style={{ background: band.tone }} aria-hidden="true" />
                {band.label}
              </span>
            ))}
          {markers
            .filter((m) => Math.abs(parseUTC(m.t).getTime() - times[hover]) <= Math.max(gapMs, 120_000))
            .map((m, i) => (
              <span key={`tip-marker-${i}`} style={{ color: "var(--th-status-info)" }}>
                {m.label}
              </span>
            ))}
          {tipExtra?.(hovered)}
        </div>
      )}
    </div>
  );
}

// ── Coverage ────────────────────────────────────────────────────────────────

export const COVERAGE_KINDS: Array<{ kind: CoverageSegment["kind"]; label: string; tone: string }> = [
  { kind: "received", label: "Received", tone: "var(--th-status-online)" },
  { kind: "late", label: "Arrived late", tone: "var(--th-status-info)" },
  { kind: "missing", label: "Agent stopped", tone: "var(--th-status-critical)" },
  { kind: "off", label: "Device off", tone: "var(--th-ring-track)" },
];

const KIND_TONE = Object.fromEntries(COVERAGE_KINDS.map((k) => [k.kind, k.tone])) as Record<string, string>;
const KIND_LABEL = Object.fromEntries(COVERAGE_KINDS.map((k) => [k.kind, k.label])) as Record<string, string>;

/** What the platform holds for each stretch of the range, as one bar. */
export function CoverageBar({
  segments,
  start,
  end,
  height = 10,
}: {
  segments: CoverageSegment[];
  start: string;
  end: string;
  height?: number;
}) {
  const t0 = parseUTC(start).getTime();
  const span = Math.max(1, parseUTC(end).getTime() - t0);
  return (
    <div
      className="relative w-full overflow-hidden rounded-full"
      style={{ height, background: "var(--th-chip-bg)", boxShadow: "inset 0 0 0 1px var(--th-border-subtle)" }}
      role="img"
      aria-label="Data coverage over the range"
      data-testid="coverage-bar"
    >
      {segments.map((s, i) => {
        const a = Math.max(0, (parseUTC(s.start).getTime() - t0) / span);
        const b = Math.min(1, (parseUTC(s.end).getTime() - t0) / span);
        if (b <= a) return null;
        return (
          <span
            key={i}
            data-kind={s.kind}
            title={`${KIND_LABEL[s.kind] ?? s.kind} · ${formatLocalDateTime(s.start)} – ${formatLocalDateTime(s.end)}`}
            className="absolute inset-y-0"
            style={{ left: `${a * 100}%`, width: `max(2px, ${(b - a) * 100}%)`, background: KIND_TONE[s.kind] }}
          />
        );
      })}
    </div>
  );
}

// ── Small pieces ────────────────────────────────────────────────────────────

/** A tiny line of daily values (oldest first), no axes. */
export function Sparkline({
  values,
  tone,
  label,
  min,
  max,
}: {
  values: number[];
  tone: string;
  label: string;
  min?: number;
  max?: number;
}) {
  if (values.length < 2) return null;
  const lo = min ?? Math.min(...values);
  const hi = Math.max(max ?? Math.max(...values), lo + 1);
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(22 - ((v - lo) / (hi - lo)) * 20).toFixed(2)}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="block h-6 w-full" role="img" aria-label={label}>
      <polyline
        points={pts}
        fill="none"
        stroke={tone}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Skeleton({ height, className = "" }: { height: number; className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-md ${className}`}
      style={{ height, background: "var(--th-ring-track)", opacity: 0.6 }}
      aria-hidden="true"
    />
  );
}

/** Coloured state chip: OK / Watch / Firing / Unknown. */
export const MONITOR_STATE: Record<string, { label: string; tone: string }> = {
  ok: { label: "OK", tone: "var(--th-status-online)" },
  watch: { label: "Watch", tone: "var(--th-status-warning)" },
  firing: { label: "Firing", tone: "var(--th-status-critical)" },
  unknown: { label: "Unknown", tone: "var(--th-text-faint)" },
  off: { label: "Off", tone: "var(--th-ring-track)" },
};

export function StateChip({ state }: { state: string }) {
  const s = MONITOR_STATE[state] ?? MONITOR_STATE.unknown;
  return (
    <span className="th-status-chip !h-6 flex-none" style={{ "--chip-tone": s.tone } as React.CSSProperties}>
      <i />
      {s.label}
    </span>
  );
}

// ── Availability ────────────────────────────────────────────────────────────

const AVAILABILITY_KINDS = [
  { key: "on", label: "On", tone: "var(--th-status-online)" },
  { key: "off", label: "Off", tone: "var(--th-ring-track)" },
  { key: "missing", label: "No data", tone: "var(--th-status-warning)" },
] as const;

function availabilityKind(kind: CoverageSegment["kind"]): "on" | "off" | "missing" {
  return kind === "received" || kind === "late" ? "on" : kind === "off" ? "off" : "missing";
}

/**
 * When the device was on, off or silent over the range, aligned with the
 * charts below (same left edge), with its restarts marked.
 */
export function AvailabilityStrip({
  segments,
  restarts,
  start,
  end,
}: {
  segments: CoverageSegment[];
  restarts: string[];
  start: string;
  end: string;
}) {
  const t0 = parseUTC(start).getTime();
  const span = Math.max(1, parseUTC(end).getTime() - t0);
  const at = (iso: string) => Math.min(1, Math.max(0, (parseUTC(iso).getTime() - t0) / span));
  return (
    <div className="relative" style={{ paddingLeft: PAD.left, paddingRight: PAD.right }}>
      <div
        className="relative h-3 w-full overflow-hidden rounded-[4px]"
        style={{ background: "var(--th-chip-bg)", boxShadow: "inset 0 0 0 1px var(--th-border-subtle)" }}
        role="img"
        aria-label="When the device was on, off or without data"
        data-testid="availability-strip"
      >
        {segments.map((seg, i) => {
          const a = at(seg.start);
          const b = at(seg.end);
          if (b <= a) return null;
          const kind = AVAILABILITY_KINDS.find((k) => k.key === availabilityKind(seg.kind))!;
          return (
            <span
              key={i}
              data-kind={kind.key}
              title={`${kind.label} · ${formatLocalDateTime(seg.start)} – ${formatLocalDateTime(seg.end)}`}
              className="absolute inset-y-0"
              style={{ left: `${a * 100}%`, width: `max(2px, ${(b - a) * 100}%)`, background: kind.tone }}
            />
          );
        })}
      </div>
      {restarts.map((r) => (
        <span
          key={r}
          className="absolute top-[-3px] h-[18px] w-[2px] rounded-full"
          style={{
            left: `calc(${PAD.left}px + (100% - ${PAD.left + PAD.right}px) * ${at(r)})`,
            background: "var(--th-status-info)",
          }}
          title={`Restarted ${formatLocalDateTime(r)}`}
          data-testid="availability-restart"
        />
      ))}
    </div>
  );
}

export { AVAILABILITY_KINDS, availabilityKind };
