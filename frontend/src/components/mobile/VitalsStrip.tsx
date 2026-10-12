/**
 * Device Details vitals strip (MOBILE-DESIGN-SPEC.md — Device Details):
 * live CPU/RAM/Disk meters, theme-aware, thresholded coloring.
 */

function meterColor(pct: number | null): string {
  if (pct == null) return "var(--th-text-faint)";
  if (pct >= 90) return "var(--th-status-critical)";
  if (pct >= 75) return "var(--th-status-warning)";
  return "var(--th-status-online)";
}

function Vital({ label, pct }: { label: string; pct: number | null }) {
  const tone = meterColor(pct);
  return (
    <div className="th-onb-card th-mvital" style={{ "--meter-tone": tone } as React.CSSProperties}>
      <span className="text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
        {label}
      </span>
      <span
        className="text-[18px] font-semibold leading-6 tabular-nums"
        style={{ color: pct == null ? "var(--th-text-faint)" : "var(--th-text-primary)" }}
      >
        {pct == null ? "—" : `${Math.round(pct)}%`}
      </span>
      <span
        className="th-mvital-track"
        role="meter"
        aria-label={`${label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct == null ? undefined : Math.round(pct)}
      >
        <i className="m-anim" style={{ width: `${pct ?? 0}%` }} />
      </span>
    </div>
  );
}

export function VitalsStrip({ cpu, ram, disk }: { cpu: number | null; ram: number | null; disk: number | null }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <Vital label="CPU" pct={cpu} />
      <Vital label="RAM" pct={ram} />
      <Vital label="Disk" pct={disk} />
    </div>
  );
}
