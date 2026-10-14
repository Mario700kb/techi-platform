import type { CSSProperties } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  History,
  Monitor,
  RefreshCw,
  ShieldAlert,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { Link } from "react-router-dom";
import { CardHead } from "../components/ui/PanelCard";
import { actionTypeLabel, RemoteAction, RemoteActionWithDevice } from "../api/actions";
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

function HealthRing({ pct, online, total }: { pct: number; online: number; total: number }) {
  const r = 56;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference - (pct / 100) * circumference;
  const color = pct >= 90 ? TONE.online : pct >= 70 ? TONE.warning : TONE.critical;

  return (
    <svg
      viewBox="0 0 140 140"
      className="h-[120px] w-[120px] flex-none"
      role="img"
      aria-label={`${pct}% online — ${formatCount(online)} of ${formatCount(total)}`}
    >
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
      icon: WifiOff,
    },
    { label: DASHBOARD_LABELS.stale, count: stale, to: "/devices?filter=stale", color: TONE.stale, icon: Clock3 },
    {
      label: DASHBOARD_LABELS.critical,
      count: criticalCount,
      to: "/devices?filter=critical",
      color: TONE.critical,
      icon: ShieldAlert,
    },
    {
      label: DASHBOARD_LABELS.needsUpdates,
      count: patchCount,
      to: "/devices?filter=needs_updates",
      color: TONE.warning,
      icon: Download,
    },
    { label: DASHBOARD_LABELS.openAlerts, count: alertsTotal, to: "/alerts", color: TONE.critical, icon: Bell },
    {
      label: DASHBOARD_LABELS.agentUpdates,
      count: agentsOutdated,
      to: "/devices?filter=needs_agent_update",
      color: "var(--th-status-agent)",
      icon: RefreshCw,
    },
  ].filter((i) => i.count > 0);

  const tiles = [
    { label: "Total", value: total, tone: "var(--th-accent)", to: "/devices", icon: Monitor },
    { label: "Online", value: online, tone: TONE.online, to: "/devices?filter=online", icon: Wifi },
    {
      label: "Critical",
      value: criticalCount,
      tone: criticalCount > 0 ? TONE.critical : TONE.neutral,
      to: "/devices?filter=critical",
      icon: ShieldAlert,
    },
    {
      label: "Alerts",
      value: alertsTotal,
      tone: alertsTotal > 0 ? TONE.critical : TONE.neutral,
      to: "/alerts",
      icon: Bell,
    },
  ];

  const legend = [
    { label: "Online", value: online, tone: TONE.online, to: "/devices?filter=online" },
    { label: "Stale", value: stale, tone: TONE.stale, to: "/devices?filter=stale" },
    { label: "Offline", value: offline, tone: TONE.offline, to: "/devices?filter=offline" },
  ];

  const shownActions = actions.slice(0, 5);

  return (
    <div className="th-onb mx-auto flex w-full max-w-md flex-col gap-4">
      <div className="th-onb-card th-mhero th-onb-enter" style={{ "--i": 0 } as CSSProperties}>
        {loading ? (
          <div
            className="h-[120px] w-[120px] flex-none animate-pulse rounded-full"
            style={{ border: "10px solid var(--th-ring-track)" }}
          />
        ) : (
          <HealthRing pct={pct} online={online} total={total} />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
            Fleet health
          </p>
          <p className="mb-2 text-[13px]" style={{ color: "var(--th-text-secondary)" }}>
            {loading ? "Loading…" : `${formatCount(total)} devices`}
          </p>
          <ul className="flex flex-col gap-1">
            {legend.map((item) => (
              <li key={item.label}>
                <Link to={item.to} className="th-mlegend">
                  <i style={{ background: item.tone }} />
                  <span className="flex-1">{item.label}</span>
                  <b className="tabular-nums">{loading ? "—" : formatCount(item.value)}</b>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="grid w-full grid-cols-2 gap-3">
        {tiles.map(({ label, value, tone, to, icon: Icon }, index) => (
          <Link
            key={label}
            to={to}
            className="th-onb-card th-mstat th-onb-enter"
            style={{ "--i": index + 1 } as CSSProperties}
          >
            <span className="th-onb-icon !h-10 !w-10" style={{ "--onb-tone": tone } as CSSProperties}>
              <Icon className="h-[18px] w-[18px]" />
            </span>
            <span className="self-end text-[12px] font-medium leading-4" style={{ color: "var(--th-text-muted)" }}>
              {label}
            </span>
            <span
              className="text-[22px] font-semibold leading-7 tabular-nums"
              style={{ color: loading ? "var(--th-text-faint)" : "var(--th-text-primary)" }}
            >
              {loading ? "—" : formatCount(value)}
            </span>
          </Link>
        ))}
      </div>

      <div className="th-onb-card overflow-hidden th-onb-enter" style={{ "--i": 5 } as CSSProperties}>
        <CardHead
          icon={issues.length ? AlertTriangle : CheckCircle2}
          tone={issues.length ? TONE.warning : TONE.online}
          title="Needs attention"
          subtitle={
            loading
              ? "Loading…"
              : issues.length
                ? `${issues.length} area${issues.length === 1 ? "" : "s"} to review`
                : "Nothing to review"
          }
        />
        {loading ? (
          <div className="space-y-2 p-4" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="th-alerts-skeleton !m-0" style={{ opacity: 1 - i * 0.2 }} />
            ))}
          </div>
        ) : issues.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-4">
            <CheckCircle2 className="h-4 w-4 flex-none" style={{ color: TONE.online }} />
            <span className="text-[14px] font-medium" style={{ color: TONE.online }}>
              All systems healthy
            </span>
          </div>
        ) : (
          <div>
            {issues.map(({ label, count, to, color, icon: Icon }) => (
              <Link key={label} to={to} className="th-mrow">
                <span className="th-onb-icon !h-8 !w-8" style={{ "--onb-tone": color } as CSSProperties}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="th-mrow-label">
                  <strong>{label}</strong>
                </span>
                <span className="th-mrow-end">
                  <span
                    className="th-status-chip !h-6 tabular-nums"
                    style={{ "--chip-tone": color, color } as CSSProperties}
                  >
                    {formatCount(count)}
                  </span>
                  <ChevronRight className="h-4 w-4" />
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="th-onb-card overflow-hidden th-onb-enter" style={{ "--i": 6 } as CSSProperties}>
        <CardHead
          icon={History}
          tone={TONE.info}
          title={DASHBOARD_LABELS.recentActions}
          subtitle={actionsLoading ? "Loading…" : shownActions.length ? `Last ${shownActions.length}` : "None yet"}
        />
        {actionsLoading ? (
          <div className="space-y-2 p-4" aria-busy="true">
            {[0, 1].map((i) => (
              <div key={i} className="th-alerts-skeleton !m-0" style={{ opacity: 1 - i * 0.25 }} />
            ))}
          </div>
        ) : shownActions.length === 0 ? (
          <p className="px-4 py-4 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
            No recent actions.
          </p>
        ) : (
          <div>
            {shownActions.map((a) => (
              <div key={a.id} className="th-mrow" data-static="true">
                <span className="th-onb-icon !h-8 !w-8" style={{ "--onb-tone": TONE.info } as CSSProperties}>
                  <Zap className="h-4 w-4" />
                </span>
                <span className="th-mrow-label">
                  <strong>{actionTypeLabel(a.action_type)}</strong>
                  <small>{[a.device_hostname, a.created_by].filter(Boolean).join(" · ") || "—"}</small>
                </span>
                <time className="th-mrow-end text-[12px] tabular-nums">{timeAgo(actionRelevantTime(a))}</time>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
