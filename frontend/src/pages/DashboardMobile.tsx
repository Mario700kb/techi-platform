import { CheckCircle2, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { ACTION_LABELS, RemoteActionWithDevice } from "../api/actions";
import { timeAgo } from "../utils/time";

/**
 * Mobile Dashboard (MOBILE-DESIGN-SPEC.md — Dashboard).
 * Theme-aware (tokens only), stale as a normal attention row, and a
 * Recent-activity feed from the existing recent-actions API.
 */

interface DashboardMobileProps {
  total: number;
  online: number;
  stale: number;
  offline: number;
  criticalCount: number;
  patchCount: number;
  alertsTotal: number;
  agentsOutdated?: number;
  actions?: RemoteActionWithDevice[];
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
    pct >= 90
      ? "var(--th-status-online)"
      : pct >= 70
      ? "var(--th-status-warning)"
      : "var(--th-status-critical)";

  return (
    <svg viewBox="0 0 140 140" className="h-36 w-36" role="img" aria-label={`${pct}% online — ${online} nga ${total}`}>
      <circle cx="70" cy="70" r={r} fill="none" stroke="var(--th-ring-track)" strokeWidth="10" />
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
        className="m-anim"
        style={{ transition: "stroke-dashoffset 0.8s ease, stroke 0.4s ease" }}
      />
      <text
        x="70"
        y="63"
        textAnchor="middle"
        fontSize="26"
        fontWeight="800"
        fill="var(--th-text-primary)"
        fontFamily="inherit"
      >
        {pct}%
      </text>
      <text
        x="70"
        y="81"
        textAnchor="middle"
        fontSize="11"
        fontWeight="600"
        fill="var(--th-text-muted)"
        fontFamily="inherit"
      >
        {online}/{total} online
      </text>
    </svg>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="w-full overflow-hidden rounded-[14px]"
      style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
    >
      {children}
    </div>
  );
}

function CardHeader({ title }: { title: string }) {
  return (
    <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
      <p
        className="text-[11px] font-extrabold uppercase tracking-[0.08em]"
        style={{ color: "var(--th-text-muted)" }}
      >
        {title}
      </p>
    </div>
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
  actions = [],
  loading,
}: DashboardMobileProps) {
  const pct = total > 0 ? Math.round((online / total) * 100) : 0;

  const issues = [
    {
      label: "Offline devices",
      count: offline,
      to: "/devices?filter=offline",
      color: "var(--th-status-offline)",
    },
    {
      label: "Stale devices",
      count: stale,
      to: "/devices?filter=stale",
      color: "var(--th-status-stale)",
    },
    {
      label: "Critical health",
      count: criticalCount,
      to: "/devices?filter=critical",
      color: "var(--th-status-critical)",
    },
    {
      label: "Pending updates",
      count: patchCount,
      to: "/devices?filter=needs_updates",
      color: "var(--th-status-warning)",
    },
    {
      label: "Active alerts",
      count: alertsTotal,
      to: "/alerts",
      color: "var(--th-accent)",
    },
    {
      label: "Agent updates pending",
      count: agentsOutdated,
      to: "/devices?filter=needs_agent_update",
      color: "var(--th-status-agent)",
    },
  ].filter((i) => i.count > 0);

  const tiles = [
    { label: "Total", value: total, color: "var(--th-text-primary)", to: "/devices" },
    { label: "Online", value: online, color: "var(--th-status-online)", to: "/devices?filter=online" },
    {
      label: "Critical",
      value: criticalCount,
      color: criticalCount > 0 ? "var(--th-status-critical)" : "var(--th-text-primary)",
      to: "/devices?filter=critical",
    },
    {
      label: "Alerts",
      value: alertsTotal,
      color: alertsTotal > 0 ? "var(--th-status-warning)" : "var(--th-text-primary)",
      to: "/alerts",
    },
  ];

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3">
      {/* Health ring */}
      <div className="pt-1">
        {loading ? (
          <div
            className="h-36 w-36 animate-pulse rounded-full"
            style={{ border: "10px solid var(--th-ring-track)" }}
          />
        ) : (
          <HealthRing pct={pct} online={online} total={total} />
        )}
      </div>

      {/* 2×2 stat tiles */}
      <div className="grid w-full grid-cols-2 gap-[10px]">
        {tiles.map(({ label, value, color, to }) => (
          <Link
            key={label}
            to={to}
            className="rounded-[14px] p-4 transition-opacity active:opacity-75"
            style={{
              background: "var(--th-bg-card)",
              border: "1px solid var(--th-border-card)",
            }}
          >
            <p
              className="text-[11px] font-extrabold uppercase tracking-[0.08em]"
              style={{ color: "var(--th-text-muted)" }}
            >
              {label}
            </p>
            <p
              className="num mt-2 text-[27px] font-extrabold tracking-[-0.02em]"
              style={{
                color: loading ? "var(--th-text-muted)" : color,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {loading ? "—" : value}
            </p>
          </Link>
        ))}
      </div>

      {/* Needs Attention */}
      <Card>
        <CardHeader title="Needs attention" />
        {loading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex animate-pulse items-center justify-between">
                <div className="h-3 w-32 rounded" style={{ background: "var(--th-ring-track)" }} />
                <div className="h-3 w-8 rounded" style={{ background: "var(--th-ring-track)" }} />
              </div>
            ))}
          </div>
        ) : issues.length === 0 ? (
          <div className="flex items-center gap-2 p-4">
            <CheckCircle2 className="h-4 w-4 flex-none" style={{ color: "var(--th-status-online)" }} />
            <span className="text-[13px] font-bold" style={{ color: "var(--th-status-online)" }}>
              All systems healthy
            </span>
          </div>
        ) : (
          <div>
            {issues.map(({ label, count, to, color }, idx) => (
              <Link
                key={label}
                to={to}
                className="flex min-h-[48px] items-center justify-between px-4 py-3 transition-colors"
                style={{
                  borderBottom:
                    idx < issues.length - 1 ? "1px solid var(--th-border-subtle)" : undefined,
                }}
              >
                <span className="text-[13px] font-bold" style={{ color: "var(--th-text-primary)" }}>
                  {label}
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="text-[15px] font-extrabold"
                    style={{ color, fontVariantNumeric: "tabular-nums" }}
                  >
                    {count}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5" style={{ color: "var(--th-text-muted)" }} />
                </span>
              </Link>
            ))}
          </div>
        )}
      </Card>

      {/* Recent activity */}
      <Card>
        <CardHeader title="Recent activity" />
        {loading && actions.length === 0 ? (
          <div className="space-y-2 p-4">
            {[0, 1].map((i) => (
              <div key={i} className="h-3 w-48 animate-pulse rounded" style={{ background: "var(--th-ring-track)" }} />
            ))}
          </div>
        ) : actions.length === 0 ? (
          <p className="px-4 py-4 text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
            No recent actions.
          </p>
        ) : (
          <div>
            {actions.slice(0, 5).map((a, idx) => (
              <div
                key={a.id}
                className="flex items-baseline gap-2 px-4 py-[11px] text-[12px]"
                style={{
                  color: "var(--th-text-secondary)",
                  borderBottom:
                    idx < Math.min(actions.length, 5) - 1
                      ? "1px solid var(--th-border-subtle)"
                      : undefined,
                }}
              >
                <span className="min-w-0 flex-1 truncate">
                  <b className="font-bold" style={{ color: "var(--th-text-primary)" }}>
                    {ACTION_LABELS[a.action_type] ?? a.action_type}
                  </b>
                  {a.device_hostname ? ` · ${a.device_hostname}` : ""}
                  {a.created_by ? ` · ${a.created_by}` : ""}
                </span>
                <time
                  className="flex-none text-[11px] font-semibold"
                  style={{ color: "var(--th-text-muted)" }}
                >
                  {a.created_at ? timeAgo(a.created_at) : "—"}
                </time>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
