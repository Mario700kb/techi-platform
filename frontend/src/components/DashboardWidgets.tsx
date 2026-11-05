import { useId } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight, ChevronRight, Minus } from "lucide-react";

import { formatCount } from "../utils/number";
import { TONE } from "../utils/deviceStatus";

/** Tone for a 0–100 score: good at or above `good`, warning at or above `warn`. */
export function scoreTone(value: number | null, good: number, warn: number): string {
  if (value == null) return TONE.neutral;
  if (value >= good) return TONE.online;
  if (value >= warn) return TONE.warning;
  return TONE.critical;
}

/** Share of `part` in `whole` as 0–100, or null without a whole. Clamped. */
export function shareOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

/**
 * Mean of the last `days` known values against the `days` before them, in
 * percentage points. Null when either window has no known value.
 */
export function windowDelta(values: (number | null)[], days = 7): number | null {
  const mean = (list: (number | null)[]) => {
    const known = list.filter((v): v is number => v != null);
    return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  };
  const recent = mean(values.slice(-days));
  const before = mean(values.slice(-2 * days, -days));
  return recent == null || before == null ? null : recent - before;
}

/** Section label between dashboard rows: what the cards below answer. */
export function DashSection({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="th-dash-section">
      <p className="th-dash-eyebrow">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </p>
      {children}
    </div>
  );
}

/** A trend line with a soft area under it; days without a value leave a gap. */
export function Sparkline({
  values,
  tone,
  label,
  height = 44,
}: {
  values: (number | null)[];
  tone: string;
  label: string;
  height?: number;
}) {
  const gradientId = useId();
  const known = values.filter((v): v is number => v != null);
  if (known.length < 2) {
    return <div className="th-spark" style={{ height }} aria-hidden="true" />;
  }
  const W = 200;
  const H = height;
  const min = Math.min(...known);
  const max = Math.max(...known);
  const span = max - min || 1;
  const x = (i: number) => (values.length === 1 ? 0 : (i / (values.length - 1)) * W);
  const y = (v: number) => H - 4 - ((v - min) / span) * (H - 8);
  const runs: { i: number; v: number }[][] = [];
  values.forEach((v, i) => {
    if (v == null) {
      runs.push([]);
      return;
    }
    if (runs.length === 0) runs.push([]);
    runs[runs.length - 1].push({ i, v });
  });
  const lines = runs.filter((run) => run.length > 0);
  const lastRun = lines[lines.length - 1];
  const last = lastRun[lastRun.length - 1];
  return (
    <svg
      className="th-spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ height, "--spark-tone": tone } as CSSProperties}
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity="0.28" />
          <stop offset="100%" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      {lines.map((run, k) => {
        const path = run.map((p, j) => `${j ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
        const area = `${path} L${x(run[run.length - 1].i).toFixed(1)},${H} L${x(run[0].i).toFixed(1)},${H} Z`;
        return (
          <g key={k}>
            <path d={area} fill={`url(#${gradientId})`} />
            <path d={path} className="th-spark-line" fill="none" stroke={tone} vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
      <circle cx={x(last.i)} cy={y(last.v)} r="3" fill={tone} className="th-spark-dot" />
    </svg>
  );
}

/** "▲ 0.4 pts" / "▼ 1.2 pts" / "no change" against the window before. */
export function DeltaChip({ delta, unit = "pts", caption }: { delta: number | null; unit?: string; caption: string }) {
  if (delta == null) return null;
  const flat = Math.abs(delta) < 0.05;
  const up = delta > 0;
  const tone = flat ? TONE.neutral : up ? TONE.online : TONE.critical;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="th-delta" style={{ "--delta-tone": tone } as CSSProperties} title={caption}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {flat ? "no change" : `${up ? "+" : "−"}${Math.abs(delta).toFixed(1)} ${unit}`}
      <span className="th-delta-caption">{caption}</span>
    </span>
  );
}

/** A 0–100 gauge: the fleet's average health in the hero. */
export function HealthRing({ value, size = 120 }: { value: number | null; size?: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const tone = scoreTone(value, 80, 50);
  return (
    <div
      className="th-dash-ring relative flex-none"
      style={{ width: size, height: size, "--ring-tone": tone } as CSSProperties}
      role="img"
      aria-label={value == null ? "No health score" : `Average health ${value} of 100`}
    >
      <svg viewBox="0 0 88 88" className="h-full w-full -rotate-90">
        <circle cx="44" cy="44" r={r} fill="none" strokeWidth="7" style={{ stroke: "var(--th-ring-track)" }} />
        <circle
          cx="44"
          cy="44"
          r={r}
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          className="th-ring-value"
          style={{ stroke: tone }}
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="th-dash-ring-value">{value ?? "—"}</span>
        <span className="text-[11px]" style={{ color: "var(--th-text-faint)" }}>
          of 100
        </span>
      </span>
    </div>
  );
}

export interface BriefingItem {
  key: string;
  text: string;
  tone: string;
  to: string;
}

/** The few things worth saying first, as links to where they are handled. */
export function Briefing({ items, loading }: { items: BriefingItem[]; loading: boolean }) {
  if (loading) return <div className="th-briefing" aria-busy="true" />;
  return (
    <ul className="th-briefing" aria-label="Briefing">
      {items.map((item, index) => (
        <li key={item.key} style={{ "--i": index } as CSSProperties}>
          <Link to={item.to} className="th-briefing-item" style={{ "--brief-tone": item.tone } as CSSProperties}>
            <i aria-hidden="true" />
            {item.text}
            <ChevronRight className="h-3 w-3 flex-none opacity-60" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** One quality measure of the fleet as a small gauge with its share. */
export function ScoreTile({
  label,
  value,
  display,
  caption,
  tone,
  to,
  index,
}: {
  label: string;
  value: number | null;
  display: string;
  caption: string;
  tone: string;
  to: string;
  index: number;
}) {
  const r = 18;
  const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <Link
      to={to}
      className="th-dscore"
      style={{ "--score-tone": tone, "--i": index } as CSSProperties}
      aria-label={`${label}: ${display}. ${caption}`}
    >
      <svg viewBox="0 0 44 44" className="th-dscore-ring" aria-hidden="true">
        <circle cx="22" cy="22" r={r} fill="none" strokeWidth="4.5" style={{ stroke: "var(--th-ring-track)" }} />
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          transform="rotate(-90 22 22)"
          className="th-ring-value"
          style={{ stroke: tone }}
        />
      </svg>
      <span className="min-w-0">
        <span className="th-dscore-label">{label}</span>
        <span className="th-dscore-value">{display}</span>
        <span className="th-dscore-caption">{caption}</span>
      </span>
    </Link>
  );
}

export interface ClientRow {
  id: string;
  name: string;
  count: number;
  online?: number;
  stale?: number;
  offline?: number;
}

/** Devices per client, each bar split by status when the counts are known. */
export function ClientStatusList({ rows, total }: { rows: ClientRow[]; total: number }) {
  return (
    <ul className="th-client-list">
      {rows.map((row, index) => {
        const hasMix = row.online != null && row.count > 0;
        const onlineShare = hasMix ? Math.round(((row.online ?? 0) / row.count) * 100) : null;
        const to =
          row.id === "none"
            ? "/devices?folder=unassigned"
            : row.id === "other"
              ? "/clients"
              : `/devices?folder=client-${row.id}`;
        return (
          <li key={row.id} className="th-share-row" style={{ "--i": index } as CSSProperties}>
            <Link
              to={to}
              className="th-client-row"
              data-muted={row.id === "none" || undefined}
              title={
                hasMix
                  ? `${formatCount(row.online ?? 0)} online · ${formatCount(row.stale ?? 0)} stale · ${formatCount(row.offline ?? 0)} offline`
                  : undefined
              }
            >
              <span className="th-client-name">{row.name}</span>
              <span className="th-client-count">{formatCount(row.count)}</span>
              <span className="th-client-share">{onlineShare != null ? `${onlineShare}% online` : ""}</span>
              <span className="th-client-track">
                <span
                  className="th-share-fill flex h-full gap-[2px]"
                  style={{ width: `${total ? (row.count / total) * 100 : 0}%` }}
                >
                  {hasMix ? (
                    (
                      [
                        ["online", row.online ?? 0, TONE.online],
                        ["stale", row.stale ?? 0, TONE.stale],
                        ["offline", row.offline ?? 0, TONE.offline],
                      ] as const
                    )
                      .filter(([, value]) => value > 0)
                      .map(([key, value, tone]) => (
                        <span
                          key={key}
                          className="h-full min-w-[2px] rounded-full"
                          style={{ flex: `${value} 1 0`, background: tone }}
                        />
                      ))
                  ) : (
                    <span
                      className="h-full w-full rounded-full"
                      style={{ background: row.id === "none" ? TONE.neutral : "var(--th-accent)" }}
                    />
                  )}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
