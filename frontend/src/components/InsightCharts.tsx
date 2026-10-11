import { MouseEvent, useEffect, useRef, useState } from "react";
import { APP_TIME_ZONE, DISPLAY_LOCALE } from "../utils/time";

const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(DISPLAY_LOCALE, { day: "numeric", month: "short", timeZone: APP_TIME_ZONE });

const PAD = { top: 10, right: 4, bottom: 20, left: 34 };

/** Size of the element in CSS pixels, so the chart fills its card without distortion. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 320, h: 140 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.max(200, Math.round(width)), h: Math.max(120, Math.round(height)) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}

function useHover(count: number) {
  const [index, setIndex] = useState<number | null>(null);
  const onMove = (event: MouseEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * count;
    setIndex(Math.max(0, Math.min(count - 1, Math.floor(x))));
  };
  return { index, onMove, onLeave: () => setIndex(null) };
}

function Tooltip({ leftPct, children }: { leftPct: number; children: React.ReactNode }) {
  return (
    <div className="th-chart-tip" style={{ left: `${Math.min(88, Math.max(12, leftPct))}%` }} role="status">
      {children}
    </div>
  );
}

/** Daily fleet availability as an area line; days without known state leave a gap. */
export function AvailabilityChart({ series }: { series: { date: string; availability_pct: number | null }[] }) {
  const { index, onMove, onLeave } = useHover(series.length);
  const { ref, w: W, h: H } = useSize<HTMLDivElement>();
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const values = series.map((p) => p.availability_pct).filter((v): v is number => v != null);
  if (values.length === 0) {
    return <div ref={ref} className="flex h-full min-h-[120px] items-center justify-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>No status history yet.</div>;
  }
  // Change-over-time line: a focused domain shows the dips that matter near 100%.
  const floor = Math.max(0, Math.min(95, Math.floor((Math.min(...values) - 1) / 5) * 5));
  const y = (v: number) => PAD.top + plotH - ((v - floor) / (100 - floor)) * plotH;
  const step = plotW / Math.max(series.length - 1, 1);
  const x = (i: number) => PAD.left + i * step;

  const segments: string[] = [];
  let current = "";
  series.forEach((p, i) => {
    if (p.availability_pct == null) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    current += `${current ? "L" : "M"}${x(i).toFixed(1)},${y(p.availability_pct).toFixed(1)}`;
  });
  if (current) segments.push(current);
  const areas = segments.map((d) => {
    const xs = d.match(/[ML]([\d.]+),/g)!.map((m) => m.slice(1, -1));
    return `${d} L${xs[xs.length - 1]},${PAD.top + plotH} L${xs[0]},${PAD.top + plotH} Z`;
  });
  const ticks = [floor, (floor + 100) / 2, 100];
  const hovered = index != null ? series[index] : null;

  return (
    <div ref={ref} className="relative h-full min-h-[120px]">
      <svg width={W} height={H} className="absolute inset-0 block" role="img" aria-label="Daily fleet availability">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="th-chart-grid" />
            <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" className="th-chart-axis">{Math.round(t)}%</text>
          </g>
        ))}
        {areas.map((d, i) => <path key={i} d={d} className="th-chart-area" />)}
        {segments.map((d, i) => <path key={i} d={d} pathLength={1} className="th-chart-line" />)}
        <text x={PAD.left} y={H - 4} className="th-chart-axis">{dayLabel(series[0].date)}</text>
        <text x={W - PAD.right} y={H - 4} textAnchor="end" className="th-chart-axis">Today</text>
        {hovered && index != null && (
          <g>
            <line x1={x(index)} x2={x(index)} y1={PAD.top} y2={PAD.top + plotH} className="th-chart-cross" />
            {hovered.availability_pct != null && <circle cx={x(index)} cy={y(hovered.availability_pct)} r="4" className="th-chart-dot" />}
          </g>
        )}
        <rect x={PAD.left} y={0} width={plotW} height={H} fill="transparent" onMouseMove={onMove} onMouseLeave={onLeave} />
      </svg>
      {hovered && index != null && (
        <Tooltip leftPct={((x(index)) / W) * 100}>
          <span style={{ color: "var(--th-text-muted)" }}>{dayLabel(hovered.date)}</span>
          <strong>{hovered.availability_pct == null ? "No data" : `${hovered.availability_pct.toFixed(2)}%`}</strong>
        </Tooltip>
      )}
      <div className="sr-only"><table>
        <caption>Daily fleet availability</caption>
        <tbody>{series.map((p) => <tr key={p.date}><th>{p.date}</th><td>{p.availability_pct ?? "no data"}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

/** Alerts opened vs resolved per day, zero-based grouped bars. */
export function AlertFlowChart({ series }: { series: { date: string; opened: number; resolved: number }[] }) {
  const { index, onMove, onLeave } = useHover(series.length);
  const { ref, w: W, h: H } = useSize<HTMLDivElement>();
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const max = Math.max(1, ...series.flatMap((p) => [p.opened, p.resolved]));
  const niceMax = max <= 4 ? 4 : Math.ceil(max / 4) * 4;
  const y = (v: number) => PAD.top + plotH - (v / niceMax) * plotH;
  const band = plotW / series.length;
  const barW = Math.min(14, (band - 10) / 2);
  const hovered = index != null ? series[index] : null;

  const bar = (cx: number, v: number, cls: string) => {
    if (v <= 0) return null;
    const top = y(v);
    const base = PAD.top + plotH;
    const r = Math.min(4, barW / 2, base - top);
    return (
      <path
        className={cls}
        d={`M${cx},${base} V${top + r} Q${cx},${top} ${cx + r},${top} H${cx + barW - r} Q${cx + barW},${top} ${cx + barW},${top + r} V${base} Z`}
      />
    );
  };

  return (
    <div ref={ref} className="relative h-full min-h-[120px]">
      <svg width={W} height={H} className="absolute inset-0 block" role="img" aria-label="Alerts opened and resolved per day">
        {[0, niceMax / 2, niceMax].map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="th-chart-grid" />
            <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" className="th-chart-axis">{t}</text>
          </g>
        ))}
        {series.map((p, i) => {
          const left = PAD.left + i * band + (band - (barW * 2 + 2)) / 2;
          return (
            <g key={p.date} opacity={index == null || index === i ? 1 : 0.45} style={{ "--i": i } as React.CSSProperties}>
              {bar(left, p.opened, "th-chart-bar-1")}
              {bar(left + barW + 2, p.resolved, "th-chart-bar-2")}
              <text x={PAD.left + i * band + band / 2} y={H - 4} textAnchor="middle" className="th-chart-axis">
                {new Date(`${p.date}T12:00:00Z`).toLocaleDateString(DISPLAY_LOCALE, { weekday: "narrow", timeZone: APP_TIME_ZONE })}
              </text>
            </g>
          );
        })}
        <rect x={PAD.left} y={0} width={plotW} height={H} fill="transparent" onMouseMove={onMove} onMouseLeave={onLeave} />
      </svg>
      {hovered && index != null && (
        <Tooltip leftPct={((PAD.left + index * band + band / 2) / W) * 100}>
          <span style={{ color: "var(--th-text-muted)" }}>{dayLabel(hovered.date)}</span>
          <span className="flex items-center gap-1.5"><i className="th-legend-swatch" data-series="1" />Opened <strong>{hovered.opened}</strong></span>
          <span className="flex items-center gap-1.5"><i className="th-legend-swatch" data-series="2" />Resolved <strong>{hovered.resolved}</strong></span>
        </Tooltip>
      )}
      <div className="sr-only"><table>
        <caption>Alerts opened and resolved per day</caption>
        <tbody>{series.map((p) => <tr key={p.date}><th>{p.date}</th><td>{p.opened} opened</td><td>{p.resolved} resolved</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}
