import { Metric, METRIC_THRESHOLDS, metricTone } from "../utils/deviceStatus";

interface ResourceBarProps {
  label: string;
  metric: Metric;
  percent: number | null;
}

/** A usage bar coloured by the same thresholds that open CPU/memory/disk alerts. */
export default function ResourceBar({ label, metric, percent }: ResourceBarProps) {
  const known = percent !== null && percent !== undefined;
  const clamped = known ? Math.min(100, Math.max(0, percent)) : 0;
  const tone = metricTone(metric, known ? clamped : null);
  const { warn, critical } = METRIC_THRESHOLDS[metric];
  return (
    <div title={`Warning at ${warn}%, critical at ${critical}%`}>
      <div className="mb-1 flex items-center justify-between text-[12px] font-medium">
        <span style={{ color: "var(--th-text-muted)" }}>{label}</span>
        <span
          className="font-semibold tabular-nums"
          style={{ color: known && clamped >= warn ? tone : "var(--th-text-secondary)" }}
        >
          {known ? `${clamped.toFixed(1)}%` : "—"}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--th-ring-track)" }}>
        {known && (
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${clamped}%`, background: tone }}
          />
        )}
      </div>
    </div>
  );
}
