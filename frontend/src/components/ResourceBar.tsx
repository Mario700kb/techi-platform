interface ResourceBarProps {
  label: string;
  percent: number | null;
  warnAt?: number;
  criticalAt?: number;
}

function barColor(percent: number, warnAt: number, criticalAt: number): string {
  if (percent >= criticalAt) return "bg-red-500";
  if (percent >= warnAt) return "bg-amber-400";
  return "bg-emerald-500";
}

function textColor(percent: number, warnAt: number, criticalAt: number): string {
  if (percent >= criticalAt) return "text-red-400";
  if (percent >= warnAt) return "text-amber-400";
  return "text-slate-300";
}

export default function ResourceBar({ label, percent, warnAt = 75, criticalAt = 90 }: ResourceBarProps) {
  if (percent === null || percent === undefined) {
    return (
      <div>
        <div className="mb-1 flex items-center justify-between text-[11px] font-medium">
          <span className="text-slate-400">{label}</span>
          <span className="text-slate-500">—</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-white/5" />
      </div>
    );
  }

  const clamped = Math.min(100, Math.max(0, percent));
  const fill = barColor(clamped, warnAt, criticalAt);
  const valColor = textColor(clamped, warnAt, criticalAt);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] font-medium">
        <span className="text-slate-400">{label}</span>
        <span className={`font-semibold ${valColor}`}>{clamped.toFixed(1)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className={`h-full rounded-full transition-all duration-500 ${fill}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
