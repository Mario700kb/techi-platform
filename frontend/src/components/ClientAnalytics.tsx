// Client profile → Analytics: how the client's devices worked over a period,
// from the monitoring pipeline (1-minute agent data on 2.1.29+, the 5-minute
// heartbeat for older agents), plus the 30-day status and alert history.
import { CSSProperties, KeyboardEvent, MouseEvent, ReactNode, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BellRing,
  ChevronRight,
  Cpu,
  Gauge,
  HardDrive,
  HeartPulse,
  Info,
  MemoryStick,
  Monitor,
  RefreshCcw,
  ServerOff,
} from "lucide-react";

import { FleetInsights, getFleetInsights } from "../api/devices";
import {
  AttentionItem,
  ClientDeviceRow,
  ClientMonitoring,
  Coverage,
  formatDuration,
  getClientMonitoring,
  HeatmapRow,
  MetricsRange,
  TrendPoint,
} from "../api/monitoring";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { appCache } from "../store/appCache";
import { TERMS, TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { APP_TIME_ZONE, DISPLAY_LOCALE, parseUTC } from "../utils/time";
import { AlertFlowChart, AvailabilityChart } from "./InsightCharts";
import { Button, EmptyState } from "./ui";
import "./ClientAnalytics.css";

export type AnalyticsRange = Exclude<MetricsRange, "1h">;

export const ANALYTICS_RANGES: { key: AnalyticsRange; label: string; period: string }[] = [
  { key: "24h", label: "24 h", period: "24 hours" },
  { key: "7d", label: "7 days", period: "7 days" },
  { key: "30d", label: "30 days", period: "30 days" },
  { key: "13mo", label: "13 months", period: "13 months" },
];

/** The first agent that sends 1-minute data and reports coverage. */
export const ONE_MINUTE_AGENT = "2.1.29";
const HEATMAP_ROWS = 12;
const DEVICE_ROWS = 15;

// ─── Loading ─────────────────────────────────────────────────────────────────

export const monitoringKey = (clientId: number, range: AnalyticsRange) => `page.client.${clientId}.monitoring:${range}`;
export const insightsKey = (clientId: number) => `page.client.${clientId}.insights`;

const inFlight = new Map<string, Promise<unknown>>();

/** One request per key at a time: the background start on the profile and the
 *  tab opening share it instead of measuring the client twice. */
function shared<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const request = fetcher()
    .then((value) => {
      appCache.set(key, value);
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

const loadMonitoring = (clientId: number, range: AnalyticsRange) =>
  shared(monitoringKey(clientId, range), () => getClientMonitoring(clientId, range));
const loadInsights = (clientId: number) => shared(insightsKey(clientId), () => getFleetInsights(30, clientId));

/** Analytics costs the server a moment the first time a client is measured;
 *  the profile starts it once it is on screen so the tab opens with its data. */
export function preloadClientAnalytics(clientId: number, range: AnalyticsRange): void {
  if (!appCache.peek(monitoringKey(clientId, range))) void loadMonitoring(clientId, range).catch(() => undefined);
  if (!appCache.peek(insightsKey(clientId))) void loadInsights(clientId).catch(() => undefined);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const pct = (value: number | null | undefined) => (value == null ? "—" : `${Math.round(value)}%`);

/** Coverage keeps one decimal: 99.7% and 100% read differently. */
const coveragePct = (value: number | null | undefined) =>
  value == null ? "—" : value >= 100 ? "100%" : `${(Math.floor(value * 10) / 10).toFixed(1)}%`;

const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

function kindLabel(kind: string): string {
  // The console's device category (older backends sent server/client).
  if (kind === "servers" || kind === "server") return TERMS.server;
  if (kind === "clientpc" || kind === "client") return TERMS.clientPc;
  if (kind === "network") return "Network device";
  if (kind === "storage") return "Storage";
  if (kind === "hypervisors") return "Hypervisor";
  if (kind === "printers") return "Printer";
  if (kind === "iot") return "IoT device";
  if (kind === "other") return "Other";
  return "Unclassified";
}

function loadTone(value: number | null | undefined): string | undefined {
  if (value == null) return undefined;
  if (value >= 90) return TONE.critical;
  if (value >= 75) return TONE.warning;
  return undefined;
}

const SEVERITY_TONE: Record<AttentionItem["severity"], string> = {
  critical: TONE.critical,
  warning: TONE.warning,
  info: TONE.info,
};

const ATTENTION_ICON: Record<AttentionItem["kind"], typeof Monitor> = {
  disk_forecast: HardDrive,
  cpu_sustained: Cpu,
  mem_sustained: MemoryStick,
  not_seen: ServerOff,
  gaps: Activity,
  monitor: BellRing,
};

function formatter(options: Intl.DateTimeFormatOptions) {
  const format = new Intl.DateTimeFormat(DISPLAY_LOCALE, { timeZone: APP_TIME_ZONE, ...options });
  return (iso: string) => format.format(parseUTC(iso));
}

/** Axis and tooltip labels for a trend point, by how long the range is. */
const TIME_LABELS: Record<AnalyticsRange, { axis: (iso: string) => string; tip: (iso: string) => string }> = {
  "24h": {
    axis: formatter({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    tip: formatter({ weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  },
  "7d": {
    axis: formatter({ weekday: "short", day: "numeric" }),
    tip: formatter({
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }),
  },
  "30d": {
    axis: formatter({ day: "numeric", month: "short" }),
    tip: formatter({ weekday: "short", day: "numeric", month: "short" }),
  },
  "13mo": {
    axis: formatter({ month: "short", year: "numeric" }),
    tip: formatter({ day: "numeric", month: "short", year: "numeric" }),
  },
};

function resolutionNote(data: ClientMonitoring): string {
  const step = data.range === "24h" || data.range === "7d" ? "hourly averages" : "daily averages";
  if (data.devices_total === 0) return step;
  if (data.one_minute_devices === 0) return `5-minute heartbeat data · ${step}`;
  if (data.one_minute_devices >= data.devices_total) return `All devices on 1-minute data · ${step}`;
  return `${formatCount(data.one_minute_devices)} of ${formatCount(data.devices_total)} devices on 1-minute data · ${step}`;
}

/** Open a device from a table row with the keyboard, like a click. */
function rowKeys(open: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      open();
    }
  };
}

// ─── Building blocks ─────────────────────────────────────────────────────────

function Card({
  title,
  action,
  footer,
  children,
  index,
  label,
}: {
  title: string;
  action?: ReactNode;
  /** Pinned to the bottom, so cards side by side end on one line. */
  footer?: ReactNode;
  children: ReactNode;
  index: number;
  label?: string;
}) {
  return (
    <section
      className="premium-card th-onb-enter flex h-full min-w-0 flex-col p-0"
      style={{ "--i": index } as CSSProperties}
      aria-label={label}
    >
      <div className="th-panel-head">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {footer && <div className="th-panel-foot th-cp-foot th-ca-foot">{footer}</div>}
    </section>
  );
}

function Stat({
  index,
  icon: Icon,
  tone,
  label,
  value,
  hint,
  className,
}: {
  index: number;
  icon: typeof Monitor;
  tone: string;
  label: string;
  value: string;
  hint: string;
  className?: string;
}) {
  return (
    <div
      className={`th-onb-card th-onb-stat th-onb-enter th-cp-kpi ${className ?? ""}`}
      style={{ "--i": index, "--onb-tone": tone } as CSSProperties}
    >
      <span className="th-onb-icon">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="truncate text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
          {label}
        </div>
        <div className="text-[24px] font-semibold leading-8 tabular-nums" style={{ color: "var(--th-text-primary)" }}>
          <span key={value} className="th-share-count">
            {value}
          </span>
        </div>
        <div className="truncate text-[12px]" style={{ color: "var(--th-text-faint)" }} title={hint}>
          {hint}
        </div>
      </div>
    </div>
  );
}

function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="px-5 pb-4" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.15 }} />
      ))}
    </div>
  );
}

/** Size of the element in CSS pixels, so a chart fills its card without distortion. */
function useSize<T extends HTMLElement>() {
  const [el, ref] = useState<T | null>(null);
  const [size, setSize] = useState({ w: 480, h: 220 });
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.max(200, Math.round(width)), h: Math.max(140, Math.round(height)) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return { ref, ...size };
}

// ─── Heatmap ─────────────────────────────────────────────────────────────────

/** Green → amber → red, stronger as the hour gets busier; grey when off. */
function heatColor(value: number | null): string {
  if (value == null) return "var(--th-ca-off)";
  const tone = value >= 75 ? TONE.critical : value >= 50 ? TONE.warning : TONE.online;
  const strength = Math.round(Math.min(100, 18 + Math.max(0, value) * 0.9));
  return `color-mix(in srgb, ${tone} ${strength}%, transparent)`;
}

const AXIS_HOURS = [0, 6, 12, 18, 23];

function Heatmap({ rows, onOpenDevice }: { rows: HeatmapRow[]; onOpenDevice: (id: number) => void }) {
  const [all, setAll] = useState(false);
  const [tip, setTip] = useState<{ left: number; top: number; name: string; hour: number; value: number | null }>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const shown = all ? rows : rows.slice(0, HEATMAP_ROWS);

  const showTip = (event: MouseEvent<HTMLElement>, name: string, hour: number, value: number | null) => {
    const box = wrapRef.current?.getBoundingClientRect();
    const cell = event.currentTarget.getBoundingClientRect();
    if (!box) return;
    setTip({ left: cell.left - box.left + cell.width / 2, top: cell.top - box.top - 4, name, hour, value });
  };

  return (
    <div className="th-ca-heat px-5 pb-4">
      <div ref={wrapRef} className="relative" onMouseLeave={() => setTip(undefined)}>
        {shown.map((row, index) => (
          <button
            key={row.device_id}
            type="button"
            className="th-ca-heat-row"
            style={{ "--row": index } as CSSProperties}
            aria-label={`Open ${row.name}, peak CPU ${pct(row.peak)}`}
            onClick={() => onOpenDevice(row.device_id)}
          >
            <span className="th-ca-heat-name" title={row.name}>
              {row.name}
            </span>
            {row.cells.map((value, hour) => (
              <span
                key={hour}
                className="th-ca-heat-cell"
                data-off={value == null || undefined}
                style={{ "--cell": heatColor(value) } as CSSProperties}
                onMouseEnter={(event) => showTip(event, row.name, hour, value)}
              />
            ))}
            <span className="th-ca-heat-peak tabular-nums">{pct(row.peak)}</span>
          </button>
        ))}
        <div className="th-ca-heat-axis" aria-hidden="true">
          {AXIS_HOURS.map((hour) => (
            <span
              key={hour}
              style={{ gridColumn: hour + 2, justifySelf: hour === 23 ? "end" : "start" } as CSSProperties}
            >
              {String(hour).padStart(2, "0")}
            </span>
          ))}
          <span className="th-ca-heat-peak" style={{ gridColumn: 26 }}>
            peak
          </span>
        </div>
        {tip && (
          <div className="th-chart-tip" style={{ left: tip.left, top: tip.top }} role="status">
            <span style={{ color: "var(--th-text-muted)" }}>
              {tip.name} · {hourLabel(tip.hour)}
            </span>
            <strong>{tip.value == null ? "Off or no data" : `CPU ${pct(tip.value)}`}</strong>
          </div>
        )}
      </div>
      {rows.length > HEATMAP_ROWS && (
        <button type="button" className="th-link-btn mt-2" onClick={() => setAll((v) => !v)}>
          {all ? "Show the busiest" : `Show all ${formatCount(rows.length)} devices`}
        </button>
      )}
      <div className="sr-only">
        <table>
          <caption>Average CPU by hour of day</caption>
          <tbody>
            {rows.map((row) => (
              <tr key={row.device_id}>
                <th>{row.name}</th>
                {row.cells.map((value, hour) => (
                  <td key={hour}>{value == null ? "off" : `${hourLabel(hour)} ${pct(value)}`}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HeatLegend() {
  return (
    <span className="th-ca-legend">
      <span>
        Low
        <i style={{ "--cell": heatColor(10) } as CSSProperties} />
        <i style={{ "--cell": heatColor(45) } as CSSProperties} />
        <i style={{ "--cell": heatColor(65) } as CSSProperties} />
        <i style={{ "--cell": heatColor(95) } as CSSProperties} />
        High
      </span>
      <span>
        <i style={{ "--cell": heatColor(null) } as CSSProperties} />
        Off or no data
      </span>
    </span>
  );
}

// ─── Needs attention ─────────────────────────────────────────────────────────

function AttentionList({ items, onOpenDevice }: { items: AttentionItem[]; onOpenDevice: (id: number) => void }) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<HeartPulse className="h-5 w-5" />}
        title="Nothing needs attention"
        description="No disk filling up, no sustained load and no gaps in this period."
      />
    );
  }
  return (
    <div className="th-ca-scroll">
      <ul className="th-ca-attn">
        {items.map((item, index) => {
          const Icon = ATTENTION_ICON[item.kind] ?? AlertTriangle;
          return (
            <li key={`${item.device_id}-${item.kind}-${index}`}>
              <button
                type="button"
                className="th-ca-attn-item"
                data-severity={item.severity}
                style={{ "--tone": SEVERITY_TONE[item.severity], "--row": index } as CSSProperties}
                onClick={() => onOpenDevice(item.device_id)}
              >
                <span className="th-ca-attn-icon" aria-hidden="true">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="th-ca-attn-title">{item.title}</span>
                  <span className="th-ca-attn-detail">{item.detail}</span>
                </span>
                <span className="th-ca-attn-open">
                  <span className="th-ca-attn-open-label">Open</span>
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Trend ───────────────────────────────────────────────────────────────────

const PAD = { top: 10, right: 8, bottom: 22, left: 36 };

function linePaths(values: Array<number | null>, x: (i: number) => number, y: (v: number) => number): string[] {
  const paths: string[] = [];
  let current = "";
  values.forEach((value, i) => {
    if (value == null) {
      if (current) paths.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${x(i).toFixed(1)},${y(value).toFixed(1)}`;
  });
  if (current) paths.push(current);
  return paths;
}

/** The p95 band: from the average up to the busiest device, one shape per unbroken run. */
function bandPaths(points: TrendPoint[], x: (i: number) => number, y: (v: number) => number): string[] {
  const paths: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) {
      const top = run.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(points[i].cpu_p95!).toFixed(1)}`);
      const bottom = [...run].reverse().map((i) => `L${x(i).toFixed(1)},${y(points[i].cpu_avg!).toFixed(1)}`);
      paths.push(`${top.join("")}${bottom.join("")}Z`);
    }
    run = [];
  };
  points.forEach((p, i) => (p.cpu_avg != null && p.cpu_p95 != null ? run.push(i) : flush()));
  flush();
  return paths;
}

function TrendChart({ points, range }: { points: TrendPoint[]; range: AnalyticsRange }) {
  const { ref, w: W, h: H } = useSize<HTMLDivElement>();
  const [index, setIndex] = useState<number | null>(null);
  const n = points.length;
  if (!points.some((p) => p.cpu_avg != null || p.mem_avg != null)) {
    return (
      <div
        ref={ref}
        className="flex h-full min-h-[140px] items-center justify-center text-[13px]"
        style={{ color: "var(--th-text-muted)" }}
      >
        No CPU or memory data in this period.
      </div>
    );
  }
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v: number) => PAD.top + plotH - (Math.max(0, Math.min(100, v)) / 100) * plotH;
  const labels = TIME_LABELS[range];
  const ticks = [0, 50, 100];
  const axisAt = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : n === 2 ? [0, 1] : [0];
  const hovered = index != null ? points[index] : null;

  const onMove = (event: MouseEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    setIndex(Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1)))));
  };

  return (
    <div ref={ref} className="relative h-full min-h-[140px]">
      <svg
        width={W}
        height={H}
        className="absolute inset-0 block"
        role="img"
        aria-label="Average CPU, busiest device CPU and average memory across the client's devices"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="th-chart-grid" />
            <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" className="th-chart-axis">
              {t}%
            </text>
          </g>
        ))}
        {bandPaths(points, x, y).map((d, i) => (
          <path key={`b${i}`} d={d} className="th-ca-band" />
        ))}
        {linePaths(
          points.map((p) => p.mem_avg),
          x,
          y,
        ).map((d, i) => (
          <path key={`m${i}`} d={d} pathLength={1} className="th-chart-line th-ca-line-mem" />
        ))}
        {linePaths(
          points.map((p) => p.cpu_avg),
          x,
          y,
        ).map((d, i) => (
          <path key={`c${i}`} d={d} pathLength={1} className="th-chart-line th-ca-line-cpu" />
        ))}
        {axisAt.map((i, k) => (
          <text
            key={i}
            x={x(i)}
            y={H - 5}
            textAnchor={k === 0 ? "start" : k === axisAt.length - 1 ? "end" : "middle"}
            className="th-chart-axis"
          >
            {labels.axis(points[i].t)}
          </text>
        ))}
        {hovered && index != null && (
          <g>
            <line x1={x(index)} x2={x(index)} y1={PAD.top} y2={PAD.top + plotH} className="th-chart-cross" />
            {hovered.mem_avg != null && (
              <circle cx={x(index)} cy={y(hovered.mem_avg)} r="4" className="th-chart-dot th-ca-dot-mem" />
            )}
            {hovered.cpu_avg != null && <circle cx={x(index)} cy={y(hovered.cpu_avg)} r="4" className="th-chart-dot" />}
          </g>
        )}
        <rect
          x={PAD.left}
          y={0}
          width={plotW}
          height={H}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setIndex(null)}
        />
      </svg>
      {hovered && index != null && (
        <div
          className="th-chart-tip"
          style={{ left: `${Math.min(86, Math.max(14, (x(index) / W) * 100))}%` }}
          role="status"
        >
          <span style={{ color: "var(--th-text-muted)" }}>{labels.tip(hovered.t)}</span>
          <span className="flex items-center gap-1.5">
            <i className="th-legend-swatch" data-series="2" />
            CPU avg <strong>{pct(hovered.cpu_avg)}</strong>
          </span>
          <span className="flex items-center gap-1.5">
            <i className="th-legend-swatch th-ca-swatch-band" />
            Busiest device <strong>{pct(hovered.cpu_p95)}</strong>
          </span>
          <span className="flex items-center gap-1.5">
            <i className="th-legend-swatch" data-series="1" />
            Memory avg <strong>{pct(hovered.mem_avg)}</strong>
          </span>
        </div>
      )}
      <div className="sr-only">
        <table>
          <caption>CPU and memory across the client</caption>
          <tbody>
            {points.map((p) => (
              <tr key={p.t}>
                <th>{labels.tip(p.t)}</th>
                <td>CPU {pct(p.cpu_avg)}</td>
                <td>busiest {pct(p.cpu_p95)}</td>
                <td>memory {pct(p.mem_avg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function mean(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v != null);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

// ─── Coverage ────────────────────────────────────────────────────────────────

function CoverageBody({ coverage, oneMinute }: { coverage: Coverage; oneMinute: number }) {
  const total = coverage.received + coverage.missing_minutes;
  if (oneMinute === 0 || coverage.pct == null || total === 0) {
    return (
      <EmptyState
        icon={<Gauge className="h-5 w-5" />}
        title="No coverage yet"
        description={`Coverage arrives as devices update to agent ${ONE_MINUTE_AGENT}.`}
      />
    );
  }
  const onTime = Math.max(0, coverage.received - coverage.late);
  const parts = [
    { key: "ontime", label: "Received on time", minutes: onTime, tone: TONE.online },
    { key: "late", label: "Received late, from the device buffer", minutes: coverage.late, tone: TONE.info },
    {
      key: "missing",
      label: "Agent stopped while the PC was on",
      minutes: coverage.missing_minutes,
      tone: TONE.warning,
    },
  ];
  return (
    <div className="flex flex-1 flex-col gap-4 px-5 pb-5">
      <div>
        <div className="th-ca-big tabular-nums">{coveragePct(coverage.pct)}</div>
        <p className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
          Of every minute a device was on, received or accounted for.
        </p>
      </div>
      <div className="th-ca-stack" aria-hidden="true">
        {parts
          .filter((p) => p.minutes > 0)
          .map((p) => (
            <span key={p.key} style={{ flexGrow: p.minutes, "--tone": p.tone } as CSSProperties} />
          ))}
      </div>
      <dl className="th-ca-cov">
        {parts.map((p) => (
          <div key={p.key}>
            <dt>
              <i style={{ "--tone": p.tone } as CSSProperties} />
              {p.label}
            </dt>
            <dd className="tabular-nums">
              <strong>{coveragePct((p.minutes / total) * 100)}</strong>
              <small>{p.minutes ? formatDuration(p.minutes * 60) : "none"}</small>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ─── Devices ─────────────────────────────────────────────────────────────────

function Spark({ values, name }: { values: Array<number | null>; name: string }) {
  const known = values.filter((v): v is number => v != null);
  if (known.length < 2) return <span className="th-ca-muted">No data</span>;
  const W = 120;
  const H = 28;
  const x = (i: number) => 1 + (i / Math.max(1, values.length - 1)) * (W - 2);
  const y = (v: number) => H - 2 - (Math.max(0, Math.min(100, v)) / 100) * (H - 4);
  return (
    <svg
      className="th-ca-spark"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${name} CPU, average ${pct(mean(values))}`}
    >
      {linePaths(values, x, y).map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

function Load({ value }: { value: number | null }) {
  const tone = loadTone(value);
  return (
    <span className="th-ca-load tabular-nums">
      {tone && <i style={{ "--tone": tone } as CSSProperties} aria-hidden="true" />}
      {pct(value)}
    </span>
  );
}

function MonitorsCell({ device }: { device: ClientDeviceRow }) {
  if (device.monitors_firing > 0) {
    return (
      <span className="th-status-chip" style={{ "--chip-tone": TONE.critical } as CSSProperties}>
        <i />
        {formatCount(device.monitors_firing)} firing
      </span>
    );
  }
  if (!device.one_minute) return <span className="th-ca-muted">Needs {ONE_MINUTE_AGENT}</span>;
  return (
    <span className="th-status-chip" style={{ "--chip-tone": TONE.online } as CSSProperties}>
      <i />
      All OK
    </span>
  );
}

const mobileLabel = (text: string) => <span className="th-ca-mlabel">{text} </span>;

function DevicesTable({
  devices,
  period,
  onOpenDevice,
}: {
  devices: ClientDeviceRow[];
  period: string;
  onOpenDevice: (id: number) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? devices : devices.slice(0, DEVICE_ROWS);
  return (
    <>
      <table className="th-alerts-table th-cp-attn-table th-ca-devices" data-mobile="cards">
        <colgroup>
          <col className="w-[24%]" />
          <col className="w-[20%]" />
          <col className="w-[10%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
          <col className="w-[10%]" />
          <col className="w-[14%]" />
        </colgroup>
        <thead>
          <tr>
            <th>Device</th>
            <th>CPU · {period}</th>
            <th className="text-right">Peak CPU</th>
            <th className="text-right">Peak memory</th>
            <th className="text-right">Fullest disk</th>
            <th className="text-right">Coverage</th>
            <th className="text-right">Monitors</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((device, index) => {
            const open = () => onOpenDevice(device.device_id);
            return (
              <tr
                key={device.device_id}
                className="th-alerts-row th-cp-row"
                style={{ "--row": index } as CSSProperties}
                tabIndex={0}
                aria-label={`Open ${device.name}`}
                onClick={open}
                onKeyDown={rowKeys(open)}
              >
                <td>
                  <span className="th-alerts-primary">{device.name}</span>
                  <span className="th-alerts-secondary">
                    {kindLabel(device.kind)} · {device.agent_version ? `agent ${device.agent_version}` : "no agent"}
                  </span>
                </td>
                <td className="th-ca-spark-cell">
                  <Spark values={device.spark} name={device.name} />
                </td>
                <td className="text-right">
                  {mobileLabel("Peak CPU")}
                  <Load value={device.cpu_peak} />
                </td>
                <td className="text-right">
                  {mobileLabel("Memory")}
                  <Load value={device.mem_peak} />
                </td>
                <td className="text-right">
                  {mobileLabel("Disk")}
                  <span className="th-ca-load tabular-nums">
                    {loadTone(device.disk_worst_pct) && (
                      <i style={{ "--tone": loadTone(device.disk_worst_pct) } as CSSProperties} aria-hidden="true" />
                    )}
                    {device.disk_worst_pct == null
                      ? "—"
                      : `${device.disk_worst ? `${device.disk_worst} ` : ""}${pct(device.disk_worst_pct)}`}
                  </span>
                </td>
                <td className="text-right">
                  {mobileLabel("Coverage")}
                  {device.one_minute ? (
                    <span className="tabular-nums">{coveragePct(device.coverage_pct)}</span>
                  ) : (
                    <span className="th-ca-muted">5-min only</span>
                  )}
                </td>
                <td className="text-right">
                  <MonitorsCell device={device} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {devices.length > DEVICE_ROWS && (
        <div className="th-panel-foot th-ca-foot">
          <button type="button" className="th-link-btn" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${formatCount(devices.length)} devices`}
          </button>
        </div>
      )}
    </>
  );
}

// ─── History (status and alerts, last 30 days) ───────────────────────────────

function History({
  data,
  error,
  onRetry,
}: {
  data: FleetInsights | undefined;
  error: string | null;
  onRetry: () => void;
}) {
  if (!data && error) {
    return (
      <section className="premium-card p-0">
        <EmptyState
          icon={<BarChart3 className="h-5 w-5" />}
          title="Couldn't load the status history"
          description={error}
          action={
            <Button size="sm" variant="secondary" onClick={onRetry}>
              <RefreshCcw className="h-3.5 w-3.5" />
              Try again
            </Button>
          }
        />
      </section>
    );
  }
  const { availability, alerts } = data ?? {};
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card
        title="Availability"
        index={8}
        action={<span className="th-cp-chart-meta">Daily · last 30 days</span>}
        footer={
          availability ? (
            <span>
              <strong className="th-ca-strong">{coveragePct(availability.overall_pct)}</strong> online ·{" "}
              {formatCount(availability.device_count)} devices
              {availability.coverage_pct != null && ` · ${Math.round(availability.coverage_pct)}% measured`}
            </span>
          ) : (
            <span>&nbsp;</span>
          )
        }
      >
        <div className="flex-1 px-5 pb-4">
          {availability ? (
            <div className="th-cp-chart">
              <AvailabilityChart series={availability.series} />
            </div>
          ) : (
            <div className="th-cp-chart th-alerts-skeleton !m-0 !border-0" />
          )}
        </div>
      </Card>
      <Card
        title="Alerts opened and resolved"
        index={9}
        action={
          <span className="th-cp-chart-meta">
            <span>
              <i className="th-legend-swatch" data-series="1" />
              Opened
            </span>
            <span>
              <i className="th-legend-swatch" data-series="2" />
              Resolved
            </span>
          </span>
        }
        footer={
          alerts ? (
            <span>
              <strong className="th-ca-strong">{formatCount(alerts.opened_total)}</strong> opened ·{" "}
              {formatCount(alerts.resolved_total)} resolved in 30 days
              {alerts.mean_time_to_resolve_hours != null &&
                ` · ${alerts.mean_time_to_resolve_hours.toFixed(1)} h to resolve on average`}
            </span>
          ) : (
            <span>&nbsp;</span>
          )
        }
      >
        <div className="flex-1 px-5 pb-4">
          {alerts ? (
            <div className="th-cp-chart">
              <AlertFlowChart series={alerts.series} />
            </div>
          ) : (
            <div className="th-cp-chart th-alerts-skeleton !m-0 !border-0" />
          )}
        </div>
      </Card>
    </div>
  );
}

// ─── The tab ─────────────────────────────────────────────────────────────────

function RangeSwitch({ range, onChange }: { range: AnalyticsRange; onChange: (range: AnalyticsRange) => void }) {
  const index = ANALYTICS_RANGES.findIndex((r) => r.key === range);
  return (
    <div
      className="th-segmented th-ca-range"
      role="radiogroup"
      aria-label="Time range"
      data-thumb
      style={{ "--seg-n": ANALYTICS_RANGES.length, "--seg-i": index } as CSSProperties}
    >
      {ANALYTICS_RANGES.map((r) => (
        <button key={r.key} type="button" role="radio" aria-checked={r.key === range} onClick={() => onChange(r.key)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

function LoadingShape() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading analytics">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={`th-onb-card th-onb-stat th-cp-kpi ${i === 4 ? "sm:max-xl:col-span-2" : ""}`}>
            <div className="th-alerts-skeleton !m-0 w-full !border-0" />
          </div>
        ))}
      </div>
      <div className="th-ca-row">
        <Card title="CPU by device and hour" index={0}>
          <Skeleton rows={4} />
        </Card>
        <Card title="Needs attention" index={1}>
          <Skeleton rows={4} />
        </Card>
      </div>
      <div className="th-ca-row">
        <Card title="Across the client" index={2}>
          <div className="px-5 pb-4">
            <div className="th-cp-chart th-alerts-skeleton !m-0 !border-0" />
          </div>
        </Card>
        <Card title="Data coverage" index={3}>
          <Skeleton rows={4} />
        </Card>
      </div>
      <Card title="Devices" index={4}>
        <Skeleton rows={5} />
      </Card>
    </div>
  );
}

export default function ClientAnalytics({
  clientId,
  range,
  onRangeChange,
  onOpenDevice,
}: {
  clientId: number;
  range: AnalyticsRange;
  onRangeChange: (range: AnalyticsRange) => void;
  onOpenDevice: (id: number) => void;
}) {
  const query = useCachedQuery(monitoringKey(clientId, range), () => loadMonitoring(clientId, range));
  const history = useCachedQuery(insightsKey(clientId), () => loadInsights(clientId));

  // While another range loads, the last one stays on screen (dimmed) instead
  // of the page collapsing to a skeleton and back.
  const [previous, setPrevious] = useState<{ clientId: number; data: ClientMonitoring }>();
  if (query.data && previous?.data !== query.data) setPrevious({ clientId, data: query.data });
  const data = query.data ?? (query.loading && previous?.clientId === clientId ? previous.data : undefined);
  const stale = data !== undefined && data !== query.data;
  const period = ANALYTICS_RANGES.find((r) => r.key === range)?.period ?? range;

  let body: ReactNode;
  if (!data && query.loading) {
    body = <LoadingShape />;
  } else if (!data) {
    body = (
      <section className="premium-card p-0">
        <EmptyState
          icon={<BarChart3 className="h-5 w-5" />}
          title="Couldn't load analytics"
          description={query.error ?? undefined}
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.reload()}>
              <RefreshCcw className="h-3.5 w-3.5" />
              Try again
            </Button>
          }
        />
      </section>
    );
  } else if (data.devices_total === 0) {
    body = (
      <section className="premium-card p-0">
        <EmptyState
          icon={<Monitor className="h-5 w-5" />}
          title="No devices yet"
          description="Analytics appear once this client has devices."
        />
      </section>
    );
  } else {
    body = <Figures data={data} period={period} onOpenDevice={onOpenDevice} />;
  }

  return (
    <div className="space-y-4">
      <div className="th-ca-toolbar">
        <RangeSwitch range={range} onChange={onRangeChange} />
        {data && <span className="th-ca-note">{resolutionNote(data)}</span>}
      </div>
      <div className="th-ca-body space-y-4" data-stale={stale || undefined} aria-busy={stale || undefined}>
        {body}
      </div>
      <History data={history.data} error={history.error} onRetry={() => void history.reload()} />
    </div>
  );
}

function Figures({
  data,
  period,
  onOpenDevice,
}: {
  data: ClientMonitoring;
  period: string;
  onOpenDevice: (id: number) => void;
}) {
  const range = data.range as AnalyticsRange;
  const notReporting = Math.max(0, data.devices_total - data.devices_reporting);
  const resolved = Math.max(0, data.monitor_alerts - data.monitor_alerts_open);
  const firstDisk = data.attention.find((a) => a.kind === "disk_forecast");
  const cpuAvg = mean(data.trend.map((p) => p.cpu_avg));
  const memAvg = mean(data.trend.map((p) => p.mem_avg));

  const figures = [
    {
      label: "Devices reporting",
      value: `${formatCount(data.devices_reporting)} / ${formatCount(data.devices_total)}`,
      hint: notReporting ? `${formatCount(notReporting)} not seen in 24 h` : "All seen in the last 24 h",
      icon: Monitor,
      tone: notReporting ? TONE.warning : TONE.online,
    },
    {
      label: "Data coverage",
      value: data.one_minute_devices ? coveragePct(data.coverage_pct) : "—",
      hint: data.one_minute_devices
        ? `${formatCount(data.one_minute_devices)} on 1-minute data`
        : `Arrives with agent ${ONE_MINUTE_AGENT}`,
      icon: Gauge,
      tone: data.coverage_pct != null && data.coverage_pct < 95 ? TONE.warning : TONE.info,
    },
    {
      label: "Monitor alerts",
      value: formatCount(data.monitor_alerts),
      hint: data.monitor_alerts
        ? `${formatCount(data.monitor_alerts_open)} open · ${formatCount(resolved)} resolved`
        : "None in this period",
      icon: BellRing,
      tone: data.monitor_alerts_open ? TONE.critical : data.monitor_alerts ? TONE.warning : TONE.online,
    },
    {
      label: "CPU across the client",
      value: pct(data.cpu_avg),
      hint:
        data.busiest_hour == null
          ? "No CPU data yet"
          : `Busiest hour ${hourLabel(data.busiest_hour)} · ${pct(data.busiest_hour_cpu)}`,
      icon: Cpu,
      tone: TONE.maintenance,
    },
    {
      label: "Disks at risk",
      value: formatCount(data.disks_at_risk),
      hint: data.disks_at_risk && firstDisk ? firstDisk.title : "None reaching 90% within 14 days",
      icon: HardDrive,
      tone: data.disks_at_risk ? TONE.critical : TONE.online,
    },
  ];

  return (
    <>
      {data.one_minute_devices === 0 && (
        <div className="th-ca-callout" role="note">
          <Info className="h-4 w-4 flex-none" aria-hidden="true" />
          <span>
            1-minute data and coverage arrive as devices update to agent {ONE_MINUTE_AGENT}. Until then these figures
            come from the 5-minute heartbeat.
          </span>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {figures.map((item, index) => (
          <Stat key={item.label} index={index} className={index === 4 ? "sm:max-xl:col-span-2" : ""} {...item} />
        ))}
      </div>
      <div className="th-ca-row">
        <Card
          title="CPU by device and hour"
          index={5}
          label="CPU load by device and hour"
          action={<span className="th-cp-chart-meta max-sm:hidden">Average day · {period}</span>}
          footer={<HeatLegend />}
        >
          {data.heatmap.length ? (
            <Heatmap rows={data.heatmap} onOpenDevice={onOpenDevice} />
          ) : (
            <EmptyState icon={<Cpu className="h-5 w-5" />} title="No CPU data in this period" />
          )}
        </Card>
        <Card
          title="Needs attention"
          index={6}
          label="Needs attention"
          action={
            data.attention.length > 0 && (
              <span className="th-cp-chart-meta tabular-nums">{formatCount(data.attention.length)}</span>
            )
          }
        >
          <AttentionList items={data.attention} onOpenDevice={onOpenDevice} />
        </Card>
      </div>
      <div className="th-ca-row">
        <Card
          title="Across the client"
          index={7}
          label="Client trend"
          action={<span className="th-cp-chart-meta max-sm:hidden">{period}</span>}
          footer={
            <span className="th-ca-legend">
              <span>
                <i className="th-legend-swatch" data-series="2" />
                CPU avg <strong className="th-ca-strong tabular-nums">{pct(cpuAvg)}</strong>
              </span>
              <span>
                <i className="th-legend-swatch th-ca-swatch-band" />
                Busiest device (p95)
              </span>
              <span>
                <i className="th-legend-swatch" data-series="1" />
                Memory avg <strong className="th-ca-strong tabular-nums">{pct(memAvg)}</strong>
              </span>
            </span>
          }
        >
          <div className="flex-1 px-5 pb-4">
            <div className="th-cp-chart th-ca-trend">
              <TrendChart points={data.trend} range={range} />
            </div>
          </div>
        </Card>
        <Card
          title="Data coverage"
          index={8}
          label="Data coverage"
          footer={<span>Device-off time is not counted as missing.</span>}
        >
          <CoverageBody coverage={data.coverage_breakdown} oneMinute={data.one_minute_devices} />
        </Card>
      </div>
      <Card
        title="Devices"
        index={9}
        label="Devices"
        action={<span className="th-cp-chart-meta">Busiest first · {period}</span>}
      >
        <DevicesTable devices={data.devices} period={period} onOpenDevice={onOpenDevice} />
      </Card>
    </>
  );
}
