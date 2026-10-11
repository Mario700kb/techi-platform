import { CheckCircle2, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { ACTION_LABELS, RemoteAction, RemoteActionWithDevice } from "../api/actions";
import { formatCount } from "../utils/number";
import { TONE } from "../utils/deviceStatus";
import { timeAgo } from "../utils/time";

/**
 * Mobile Dashboard (MOBILE-DESIGN-SPEC.md — Dashboard).
 * Theme-aware (tokens only), stale as a normal attention row, and a
 * recent remote actions feed from the existing recent-actions API.
 */

/** Labels shared by the desktop and mobile dashboards, so a filter reads the same on both. */
export const DASHBOARD_LABELS = {
  openAlerts: "Open alerts",
  offline: "Offline devices",
  stale: "Stale devices",
  critical: "Critical health",
  needsUpdates: "Needs updates",
  agentUpdates: "Agent updates",
  recentActions: "Recent remote actions",
} as const;

/** The moment that matters for an action: when it finished, failed or started, else when it was created. */
export function actionRelevantTime(action: RemoteAction): string {
  return action.completed_at ?? action.failed_at ?? action.started_at ?? action.sent_at ?? action.created_at;
}

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
  actionsLoading: boolean;
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
      ? TONE.online
      : pct >= 70
      ? TONE.warning
      : TONE.critical;

  return (
    <svg viewBox="0 0 140 140" className="h-36 w-36" role="img" aria-label={`${pct}% online — ${formatCount(online)} of ${formatCount(total)}`}>
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
        {formatCount(online)}/{formatCount(total)} online
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
        className="text-[11px] font-bold uppercase tracking-[0.08em]"
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
  actionsLoading,
  loading,
}: DashboardMobileProps) {
  const pct = total > 0 ? Math.round((online / total) * 100) : 0;

  const issues = [
    {
      label: DASHBOARD_LABELS.offline,
      count: offline,
      to: "/devices?filter=offline",
      color: TONE.offline,
    },
    {
      label: DASHBOARD_LABELS.stale,
      count: stale,
      to: "/devices?filter=stale",
      color: TONE.stale,
    },
    {
      label: DASHBOARD_LABELS.critical,
      count: criticalCount,
      to: "/devices?filter=critical",
      color: TONE.critical,
    },
    {
      label: DASHBOARD_LABELS.needsUpdates,
      count: patchCount,
      to: "/devices?filter=needs_updates",
      color: TONE.warning,
    },
    {
      label: DASHBOARD_LABELS.openAlerts,
      count: alertsTotal,
      to: "/alerts",
      color: TONE.critical,
    },
    {
      label: DASHBOARD_LABELS.agentUpdates,
      count: agentsOutdated,
      to: "/devices?filter=needs_agent_update",
      color: "var(--th-status-agent)",
    },
  ].filter((i) => i.count > 0);

  const tiles = [
    { label: "Total", value: total, color: "var(--th-text-primary)", to: "/devices" },
    { label: "Online", value: online, color: TONE.online, to: "/devices?filter=online" },
    {
      label: "Critical",
      value: criticalCount,
      color: criticalCount > 0 ? TONE.critical : "var(--th-text-primary)",
      to: "/devices?filter=critical",
    },
    {
      label: "Alerts",
      value: alertsTotal,
      color: alertsTotal > 0 ? TONE.critical : "var(--th-text-primary)",
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
      <div className="grid w-full grid-cols-2 gap-3">
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
              className="text-[11px] font-bold uppercase tracking-[0.08em]"
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
              {loading ? "—" : formatCount(value)}
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
            <CheckCircle2 className="h-4 w-4 flex-none" style={{ color: TONE.online }} />
            <span className="text-[14px] font-bold" style={{ color: TONE.online }}>
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
                <span className="text-[14px] font-bold" style={{ color: "var(--th-text-primary)" }}>
                  {label}
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="text-[15px] font-extrabold"
                    style={{ color, fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatCount(count)}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5" style={{ color: "var(--th-text-muted)" }} />
                </span>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={DASHBOARD_LABELS.recentActions} />
        {actionsLoading ? (
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
                  {timeAgo(actionRelevantTime(a))}
                </time>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
