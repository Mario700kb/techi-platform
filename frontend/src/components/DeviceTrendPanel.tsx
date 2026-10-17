import React, { useEffect, useState } from "react";
import { getDeviceTelemetryHistory } from "../api/telemetry";
import { TelemetrySnapshot } from "../types/telemetry";
import { parseUTC } from "../utils/time";
import { Sparkline } from "./mobile/Sparkline";

// A day of heartbeats at the 5-minute interval.
const POINTS = 288;

function stats(values: (number | null)[]) {
  const nums = values.filter((v): v is number => v != null);
  if (!nums.length) return null;
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return { avg: Math.round(avg), max: Math.round(Math.max(...nums)), last: Math.round(nums[nums.length - 1]) };
}

function span(points: TelemetrySnapshot[]): string {
  if (points.length < 2) return "";
  const hours =
    (parseUTC(points[points.length - 1].created_at).getTime() - parseUTC(points[0].created_at).getTime()) / 3_600_000;
  return hours >= 1 ? `last ${Math.round(hours)} h` : `last ${Math.max(1, Math.round(hours * 60))} min`;
}

/** How the device has been loaded over the last day, from its heartbeats.
 *  History only: current values live in the panel above. */
export default function DeviceTrendPanel({ deviceId, enabled }: { deviceId: number; enabled: boolean }) {
  const [points, setPoints] = useState<TelemetrySnapshot[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getDeviceTelemetryHistory(deviceId, POINTS)
      .then((rows) => {
        if (cancelled) return;
        // Oldest first, whatever order the API returns.
        setPoints([...rows].sort((a, b) => parseUTC(a.created_at).getTime() - parseUTC(b.created_at).getTime()));
      })
      .catch(() => !cancelled && setPoints([]));
    return () => {
      cancelled = true;
    };
  }, [deviceId, enabled]);

  const cpu = stats(points?.map((p) => p.cpu_percent) ?? []);
  const ram = stats(points?.map((p) => p.ram_percent) ?? []);
  const disk = stats(points?.map((p) => p.disk_percent) ?? []);
  const latency = stats(points?.map((p) => p.heartbeat_latency_ms) ?? []);

  return (
    <section className="mb-4" aria-label="Trend">
      <div className="mb-2 flex items-center justify-between">
        <p className="premium-kicker">Trend</p>
        {points && points.length > 1 && (
          <span className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
            {span(points)} · {points.length} heartbeats
          </span>
        )}
      </div>
      <div className="th-drawer-card">
        {points === null ? (
          <div
            className="h-[72px] animate-pulse rounded"
            style={{ background: "var(--th-ring-track)" }}
            aria-hidden="true"
          />
        ) : points.length < 2 ? (
          <p className="py-2 text-center text-xs" style={{ color: "var(--th-text-muted)" }}>
            No history yet. The trend fills in as heartbeats arrive.
          </p>
        ) : (
          <>
            <Sparkline
              cpu={points.map((p) => p.cpu_percent ?? 0)}
              ram={points.map((p) => p.ram_percent ?? 0)}
              width={420}
              height={56}
            />
            <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 text-[12px] tabular-nums">
              <Stat
                label="CPU"
                tone="var(--th-status-online)"
                value={cpu ? `avg ${cpu.avg}% · peak ${cpu.max}%` : "—"}
              />
              <Stat
                label="Memory"
                tone="var(--th-status-agent)"
                value={ram ? `avg ${ram.avg}% · peak ${ram.max}%` : "—"}
              />
              <Stat label="Disk" value={disk ? `${disk.last}% used` : "—"} />
              <Stat label="Latency" value={latency ? `avg ${latency.avg} ms` : "—"} />
            </dl>
          </>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="premium-kicker mb-0.5 flex items-center gap-1.5">
        {tone && <span className="inline-block h-2 w-2 rounded-full" style={{ background: tone }} aria-hidden="true" />}
        {label}
      </dt>
      <dd style={{ color: "var(--th-text-primary)" }}>{value}</dd>
    </div>
  );
}
