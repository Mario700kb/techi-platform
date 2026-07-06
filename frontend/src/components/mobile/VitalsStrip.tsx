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
  return (
    <div
      className="flex min-w-0 flex-1 flex-col gap-[7px] rounded-[14px] p-[10px_12px]"
      style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
    >
      <span className="text-[10.5px] font-extrabold uppercase tracking-[0.07em]" style={{ color: "var(--th-text-muted)" }}>
        {label}
      </span>
      <span className="num text-[16px] font-extrabold" style={{ color: pct == null ? "var(--th-text-faint)" : "var(--th-text-primary)" }}>
        {pct == null ? "—" : `${Math.round(pct)}%`}
      </span>
      <span className="block h-[5px] overflow-hidden rounded-full" style={{ background: "var(--th-ring-track)" }}>
        <span
          className="m-anim block h-full rounded-full"
          style={{ width: `${pct ?? 0}%`, background: meterColor(pct), transition: "width 0.5s ease" }}
        />
      </span>
    </div>
  );
}

export function VitalsStrip({
  cpu,
  ram,
  disk,
}: {
  cpu: number | null;
  ram: number | null;
  disk: number | null;
}) {
  return (
    <div className="flex gap-[8px]">
      <Vital label="CPU" pct={cpu} />
      <Vital label="RAM" pct={ram} />
      <Vital label="Disk" pct={disk} />
    </div>
  );
}
