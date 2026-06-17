import { CheckCircle2, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";

interface DashboardMobileProps {
  total: number;
  online: number;
  stale: number;
  offline: number;
  criticalCount: number;
  patchCount: number;
  alertsTotal: number;
  agentsOutdated?: number;
  loading: boolean;
}

function HealthRing({
  pct,
  online,
  total,
}: {
  pct: number;
  online: number;
  total: number;
}) {
  const r = 56;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference - (pct / 100) * circumference;
  const color =
    pct >= 90 ? "#34d399" : pct >= 70 ? "#fbbf24" : "#f87171";

  return (
    <svg viewBox="0 0 140 140" className="h-36 w-36" aria-label={`${pct}% online`}>
      {/* Track */}
      <circle
        cx="70"
        cy="70"
        r={r}
        fill="none"
        stroke="#27272a"
        strokeWidth="10"
      />
      {/* Progress arc */}
      <circle
        cx="70"
        cy="70"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="10"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        transform="rotate(-90 70 70)"
        style={{ transition: "stroke-dashoffset 0.8s ease, stroke 0.4s ease" }}
      />
      {/* Center text */}
      <text
        x="70"
        y="63"
        textAnchor="middle"
        fontSize="26"
        fontWeight="700"
        fill="white"
        fontFamily="inherit"
      >
        {pct}%
      </text>
      <text
        x="70"
        y="81"
        textAnchor="middle"
        fontSize="11"
        fill="#71717a"
        fontFamily="inherit"
      >
        {online}/{total} online
      </text>
    </svg>
  );
}

export function DashboardMobile({
  total,
  online,
  stale,
  offline,
  criticalCount,
  patchCount,
  alertsTotal,
  agentsOutdated = 0,
  loading,
}: DashboardMobileProps) {
  const pct = total > 0 ? Math.round((online / total) * 100) : 0;

  const issues = [
    {
      label: "Offline devices",
      count: offline,
      to: "/devices?filter=offline",
      color: "#94a3b8",
    },
    {
      label: "Critical health",
      count: criticalCount,
      to: "/devices?filter=critical",
      color: "#f87171",
    },
    {
      label: "Pending updates",
      count: patchCount,
      to: "/devices?filter=needs_updates",
      color: "#fbbf24",
    },
    {
      label: "Active alerts",
      count: alertsTotal,
      to: "/devices?filter=needs_attention",
      color: "#fb923c",
    },
    {
      label: "Agent updates pending",
      count: agentsOutdated,
      to: "/devices?filter=needs_agent_update",
      color: "#a78bfa",
    },
  ].filter((i) => i.count > 0);

  return (
    <div className="flex flex-col items-center gap-4 pb-2 pt-2">
      {/* Health ring */}
      {loading ? (
        <div
          className="h-36 w-36 animate-pulse rounded-full"
          style={{ border: "10px solid #27272a" }}
        />
      ) : (
        <HealthRing pct={pct} online={online} total={total} />
      )}

      {/* 2×2 stat tiles */}
      <div className="grid w-full grid-cols-2 gap-3">
        {[
          { label: "Total", value: total, color: null, to: "/devices" },
          { label: "Online", value: online, color: "#34d399", to: "/devices?filter=online" },
          {
            label: "Critical",
            value: criticalCount,
            color: criticalCount > 0 ? "#f87171" : null,
            to: "/devices?filter=critical",
          },
          {
            label: "Alerts",
            value: alertsTotal,
            color: alertsTotal > 0 ? "#fb923c" : null,
            to: "/devices?filter=needs_attention",
          },
        ].map(({ label, value, color, to }) => (
          <Link
            key={label}
            to={to}
            className="rounded-xl p-4 transition-opacity active:opacity-75"
            style={{
              background: "var(--th-bg-card)",
              border: "1px solid var(--th-border-card)",
            }}
          >
            <p
              className="text-[10px] font-bold uppercase tracking-[0.1em]"
              style={{ color: "var(--th-text-muted)" }}
            >
              {label}
            </p>
            <p
              className="mt-2 text-3xl font-bold"
              style={{ color: loading ? "var(--th-text-muted)" : (color ?? "white") }}
            >
              {loading ? "—" : value}
            </p>
          </Link>
        ))}
      </div>

      {/* Needs Attention */}
      <div
        className="w-full overflow-hidden rounded-xl"
        style={{
          background: "var(--th-bg-card)",
          border: "1px solid var(--th-border-card)",
        }}
      >
        <div
          className="px-4 py-3"
          style={{ borderBottom: "1px solid var(--th-border-subtle)" }}
        >
          <p
            className="text-[11px] font-bold uppercase tracking-[0.1em]"
            style={{ color: "var(--th-text-muted)" }}
          >
            Needs Attention
          </p>
        </div>

        {loading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex animate-pulse items-center justify-between">
                <div className="h-3 w-32 rounded" style={{ background: "#374151" }} />
                <div className="h-3 w-8 rounded" style={{ background: "#374151" }} />
              </div>
            ))}
          </div>
        ) : issues.length === 0 ? (
          <div className="flex items-center gap-2 p-4">
            <CheckCircle2 className="h-4 w-4 flex-none text-emerald-400" />
            <span className="text-[13px] font-semibold text-emerald-400">
              All systems healthy
            </span>
          </div>
        ) : (
          <div>
            {issues.map(({ label, count, to, color }, idx) => (
              <Link
                key={label}
                to={to}
                className="flex items-center justify-between px-4 py-3 transition-colors active:bg-white/[0.04]"
                style={{
                  borderBottom:
                    idx < issues.length - 1
                      ? "1px solid var(--th-border-subtle)"
                      : undefined,
                }}
              >
                <span
                  className="text-[13px] font-semibold"
                  style={{ color: "var(--th-text-primary)" }}
                >
                  {label}
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="text-[15px] font-bold tabular-nums"
                    style={{ color }}
                  >
                    {count}
                  </span>
                  <ChevronRight
                    className="h-3.5 w-3.5"
                    style={{ color: "var(--th-text-muted)" }}
                  />
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Stale count indicator (small footnote) */}
      {!loading && stale > 0 && (
        <Link
          to="/devices?filter=stale"
          className="text-[11px] font-medium transition-opacity active:opacity-70"
          style={{ color: "#fbbf24" }}
        >
          {stale} device{stale !== 1 ? "s" : ""} stale (seen &lt;15 min ago)
        </Link>
      )}
    </div>
  );
}
