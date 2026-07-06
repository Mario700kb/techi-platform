/**
 * Device Details Performance sparkline (MOBILE-DESIGN-SPEC.md — Device
 * Details: "sparkline 1h CPU/RAM/latency" — present in the locked mockup,
 * missing from the first implementation pass). Renders real historical
 * telemetry points (no synthetic data): CPU as the primary line, RAM as a
 * lighter secondary line, both with an emphasized endpoint per the
 * dataviz convention for a live-trending value.
 */
export function Sparkline({
  cpu,
  ram,
  width = 300,
  height = 44,
}: {
  cpu: number[];
  ram: number[];
  width?: number;
  height?: number;
}) {
  if (cpu.length < 2) return null;

  const toPoints = (series: number[]) => {
    const n = series.length;
    return series
      .map((v, i) => {
        const x = (i / (n - 1)) * (width - 4) + 2;
        const y = height - 4 - (Math.max(0, Math.min(100, v)) / 100) * (height - 8);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };

  const cpuPoints = toPoints(cpu);
  const ramPoints = ram.length === cpu.length ? toPoints(ram) : null;
  const lastCpu = cpu[cpu.length - 1];
  const lastX = width - 2;
  const lastY = height - 4 - (Math.max(0, Math.min(100, lastCpu)) / 100) * (height - 8);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label={`CPU trend, last reading ${Math.round(lastCpu)}%`}
      preserveAspectRatio="none"
    >
      {ramPoints && (
        <polyline
          points={ramPoints}
          fill="none"
          stroke="var(--th-status-agent)"
          strokeOpacity="0.45"
          strokeWidth="1.5"
        />
      )}
      <polyline points={cpuPoints} fill="none" stroke="var(--th-status-online)" strokeWidth="2" />
      <circle cx={lastX} cy={lastY} r="3" fill="var(--th-status-online)" />
    </svg>
  );
}
