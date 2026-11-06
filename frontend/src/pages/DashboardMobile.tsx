import { useId, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  HeartPulse,
  Loader2,
  Monitor,
  RefreshCw,
  ShieldAlert,
  Terminal,
  Timer,
  WifiOff,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  ACTION_STATUS_LABELS,
  actionTypeLabel,
  RemoteAction,
  RemoteActionWithDevice,
  statusColor,
  statusDotColor,
} from "../api/actions";
import { slaRows, SlaRow } from "../components/DashboardPanels";
import {
  Briefing,
  BriefingItem,
  DashSection,
  DeltaChip,
  ScoreTile,
  shareOf,
  Sparkline,
} from "../components/DashboardWidgets";
import { AnimatedNumber } from "../components/ui";
import type { Alert } from "../types/alert";
import { formatCount } from "../utils/number";
import { TONE } from "../utils/deviceStatus";
import { timeAgo } from "../utils/time";
import "./DashboardMobile.css";

/**
 * Mobile Dashboard (MOBILE-DESIGN-SPEC.md — Dashboard).
 * Answers "is anything urgent?" first: fleet pulse, what to look at, counts,
 * scorecard, then what needs a decision. Every other analysis of the desktop
 * dashboard is one tap away and renders only once it is opened.
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

/** One analysis behind a tap: a title and its one-line answer, the full card when opened. */
export interface MobilePanel {
  key: string;
  title: string;
  summary: string;
  icon: LucideIcon;
  tone: string;
  render: () => ReactNode;
}

export interface MobileScore {
  label: string;
  value: number | null;
  display: string;
  caption: string;
  tone: string;
  to: string;
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
  greeting?: string;
  clientName?: string | null;
  clientPicker?: ReactNode;
  averageHealth?: number | null;
  health?: { label: string; tone: string };
  availabilityPct?: number | null;
  availabilityValues?: (number | null)[];
  availabilityDelta?: number | null;
  briefing?: BriefingItem[];
  scorecard?: MobileScore[];
  sla?: { alerts: Alert[] | null; overdue: number; failed: boolean };
  panels?: MobilePanel[];
}

const SLA_ROWS = 3;

function OnlineRing({ pct, online, total }: { pct: number; online: number; total: number }) {
  const r = 56;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference - (pct / 100) * circumference;
  const color = pct >= 90 ? TONE.online : pct >= 70 ? TONE.warning : TONE.critical;

  return (
    <div className="th-dash-ring relative flex-none" style={{ "--ring-tone": color } as CSSProperties}>
      <svg
        viewBox="0 0 140 140"
        className="relative h-[116px] w-[116px]"
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
          y="72"
          textAnchor="middle"
          fontSize="32"
          fontWeight="700"
          letterSpacing="-1"
          fill="var(--th-text-primary)"
          fontFamily="inherit"
        >
          {pct}%
        </text>
        <text
          x="70"
          y="92"
          textAnchor="middle"
          fontSize="13"
          fontWeight="500"
          fill="var(--th-text-muted)"
          fontFamily="inherit"
        >
          online
        </text>
      </svg>
    </div>
  );
}

function InsightPanel({ panel, index }: { panel: MobilePanel; index: number }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const Icon = panel.icon;
  return (
    <li className="th-mpanel" style={{ "--i": index } as CSSProperties}>
      <button
        type="button"
        className="th-mpanel-toggle"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="th-mdash-mark" style={{ "--mark-tone": panel.tone } as CSSProperties}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="th-mpanel-title">{panel.title}</span>
          <span className="th-mpanel-summary">{panel.summary}</span>
        </span>
        <ChevronDown className="th-mpanel-chevron" data-open={open || undefined} aria-hidden="true" />
      </button>
      {open && (
        <div id={bodyId} className="th-mpanel-body">
          {panel.render()}
        </div>
      )}
    </li>
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
  greeting,
  clientName = null,
  clientPicker,
  averageHealth = null,
  health,
  availabilityPct = null,
  availabilityValues = [],
  availabilityDelta = null,
  briefing = [],
  scorecard = [],
  sla,
  panels = [],
}: DashboardMobileProps) {
  const pct = total > 0 ? Math.round((online / total) * 100) : 0;
  const share = (count: number) => shareOf(count, total) ?? 0;

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
    {
      label: "All devices",
      value: total,
      tone: TONE.neutral,
      to: "/devices",
      icon: Monitor,
      hint: "Managed endpoints",
    },
    {
      label: "Critical",
      value: criticalCount,
      tone: criticalCount > 0 ? TONE.critical : TONE.neutral,
      to: "/devices?filter=critical",
      icon: HeartPulse,
      hint: "Health below 50",
    },
    {
      label: "Alerts",
      value: alertsTotal,
      tone: alertsTotal > 0 ? TONE.critical : TONE.neutral,
      to: "/alerts",
      icon: Bell,
      hint: "Open right now",
    },
    {
      label: "Updates",
      value: patchCount,
      tone: patchCount > 0 ? TONE.warning : TONE.neutral,
      to: "/devices?filter=needs_updates",
      icon: Download,
      hint: "Pending patches",
    },
  ];

  const statuses = [
    { label: "Online", value: online, tone: TONE.online, to: "/devices?filter=online" },
    { label: "Stale", value: stale, tone: TONE.stale, to: "/devices?filter=stale" },
    { label: "Offline", value: offline, tone: TONE.offline, to: "/devices?filter=offline" },
  ];

  const shownActions = actions.slice(0, 5);
  const deadlines = sla?.alerts ? slaRows(sla.alerts, SLA_ROWS) : [];

  return (
    <div className="th-mdash">
      {(greeting || clientPicker) && (
        <div className="th-mdash-top">
          {greeting && <p className="th-mdash-greeting">{greeting}</p>}
          {clientPicker}
        </div>
      )}

      <section className="th-mpulse" aria-label="Fleet status">
        <div className="th-mpulse-main">
          {loading ? (
            <div className="th-mpulse-ring-loading" />
          ) : (
            <OnlineRing pct={pct} online={online} total={total} />
          )}
          <div className="min-w-0 flex-1">
            <p className="th-mpulse-label">Fleet health{clientName ? ` · ${clientName}` : ""}</p>
            <p className="th-mpulse-count tabular-nums">
              {loading || averageHealth == null ? "—" : averageHealth}
              <small>/100</small>
            </p>
            {!loading && health && (
              <span className="th-status-chip mt-1" style={{ "--chip-tone": health.tone } as CSSProperties}>
                <i />
                {health.label}
              </span>
            )}
            <p className="th-mpulse-of tabular-nums">
              {loading ? "Loading…" : `${formatCount(online)} of ${formatCount(total)} devices online`}
            </p>
          </div>
        </div>

        <div
          className="th-mix-bar th-dash-mix flex overflow-hidden rounded-full"
          style={{ background: "var(--th-ring-track)" }}
          aria-hidden="true"
        >
          <div style={{ width: loading ? "0%" : `${share(online)}%`, background: TONE.online }} />
          <div style={{ width: loading ? "0%" : `${share(stale)}%`, background: TONE.stale }} />
          <div style={{ width: loading ? "0%" : `${share(offline)}%`, background: TONE.offline }} />
        </div>

        <ul className="th-mpulse-status">
          {statuses.map((item) => (
            <li key={item.label}>
              <Link to={item.to} className="th-mpulse-cell" style={{ "--cell-tone": item.tone } as CSSProperties}>
                <span className="th-mpulse-cell-label">
                  <i aria-hidden="true" />
                  {item.label}
                </span>
                <strong className="tabular-nums">{loading ? "—" : formatCount(item.value)}</strong>
              </Link>
            </li>
          ))}
        </ul>

        {availabilityPct != null && (
          <div className="th-mpulse-trend">
            <div className="min-w-0">
              <p className="th-mpulse-label">Availability · 30 days</p>
              <p className="th-mpulse-trend-value tabular-nums">{availabilityPct.toFixed(2)}%</p>
              <DeltaChip delta={availabilityDelta} caption="vs prior 7 d" />
            </div>
            <Sparkline
              values={availabilityValues}
              tone={TONE.online}
              label="Daily availability over the last 30 days"
              height={52}
            />
          </div>
        )}
      </section>

      {!loading && briefing.length > 0 && <Briefing items={briefing} loading={false} />}

      <div className="th-mdash-kpis">
        {tiles.map(({ label, value, tone, to, icon: Icon, hint }, index) => (
          <Link
            key={label}
            to={to}
            className="th-kpi th-dash-kpi"
            style={{ "--kpi-tone": tone, "--i": index } as CSSProperties}
          >
            <span className="th-kpi-label">
              <span className="th-kpi-dot" />
              {label}
              <Icon className="th-dash-kpi-icon" aria-hidden="true" />
            </span>
            <span className="th-kpi-value">
              {loading ? "—" : <AnimatedNumber value={value} format={formatCount} />}
            </span>
            <span className="th-kpi-hint">{hint}</span>
            <span className="th-dash-kpi-bar" aria-hidden="true">
              <span style={{ width: loading ? "0%" : `${share(value)}%` }} />
            </span>
          </Link>
        ))}
      </div>

      {scorecard.length > 0 && (
        <DashSection label="Scorecard">
          <div className="th-mscroll">
            {scorecard.map((score, index) => (
              <ScoreTile key={score.label} index={index} {...score} />
            ))}
          </div>
        </DashSection>
      )}

      <DashSection label="Right now">
        <div className="flex flex-col gap-3">
          <section className="th-mcard" aria-labelledby="m-attention-title">
            <div className="th-mcard-head">
              <h2 id="m-attention-title">Needs attention</h2>
              <small>
                {loading
                  ? "Loading…"
                  : issues.length
                    ? `${issues.length} area${issues.length === 1 ? "" : "s"} to review`
                    : "Nothing to review"}
              </small>
            </div>
            {loading ? (
              <div className="space-y-2 px-4 pb-4" aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="th-alerts-skeleton !m-0" style={{ opacity: 1 - i * 0.2 }} />
                ))}
              </div>
            ) : issues.length === 0 ? (
              <p className="th-mcard-clear">
                <CheckCircle2 className="h-4 w-4 flex-none" aria-hidden="true" />
                All systems healthy
              </p>
            ) : (
              <ul>
                {issues.map(({ label, count, to, color, icon: Icon }) => (
                  <li key={label}>
                    <Link to={to} className="th-mattn" style={{ "--mark-tone": color } as CSSProperties}>
                      <span className="th-mdash-mark">
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="th-mattn-label">{label}</span>
                        <span className="th-mattn-track" aria-hidden="true">
                          <span style={{ width: `${Math.max(share(count), 2)}%` }} />
                        </span>
                      </span>
                      <strong className="th-mattn-count tabular-nums">{formatCount(count)}</strong>
                      <ChevronRight className="th-mdash-chevron" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {sla && (
            <section className="th-mcard" aria-labelledby="m-sla-title">
              <div className="th-mcard-head">
                <h2 id="m-sla-title">SLA at risk</h2>
                {sla.overdue > 0 ? (
                  <span className="th-status-chip" style={{ "--chip-tone": TONE.critical } as CSSProperties}>
                    <i />
                    {formatCount(sla.overdue)} overdue
                  </span>
                ) : (
                  <Timer className="h-4 w-4" style={{ color: "var(--th-text-faint)" }} aria-hidden="true" />
                )}
              </div>
              {deadlines.length > 0 ? (
                <ul className="px-2">
                  {deadlines.map((alert, index) => (
                    <SlaRow key={alert.id} alert={alert} index={index} />
                  ))}
                </ul>
              ) : (
                <p className="th-mcard-note">
                  {sla.failed
                    ? "Deadlines could not be loaded. Trying again in a minute."
                    : sla.alerts === null
                      ? "Loading…"
                      : "No deadline running right now."}
                </p>
              )}
              <Link to="/alerts" className="th-mcard-more">
                Open the alert queue
                <ChevronRight className="th-mdash-chevron" aria-hidden="true" />
              </Link>
            </section>
          )}

          <section className="th-mcard" aria-labelledby="m-actions-title">
            <div className="th-mcard-head">
              <h2 id="m-actions-title">{DASHBOARD_LABELS.recentActions}</h2>
              <small>
                {actionsLoading ? "Loading…" : shownActions.length ? `Last ${shownActions.length}` : "None yet"}
              </small>
            </div>
            {actionsLoading ? (
              <div className="space-y-2 px-4 pb-4" aria-busy="true">
                {[0, 1].map((i) => (
                  <div key={i} className="th-alerts-skeleton !m-0" style={{ opacity: 1 - i * 0.25 }} />
                ))}
              </div>
            ) : shownActions.length === 0 ? (
              <p className="th-mcard-note">No recent actions.</p>
            ) : (
              <ul className="th-mfeed">
                {shownActions.map((a) => (
                  <li key={a.id} className="th-mfeed-row">
                    <span className="th-mdash-mark" style={{ "--mark-tone": TONE.info } as CSSProperties}>
                      {a.status === "running" ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Terminal className="h-4 w-4" aria-hidden="true" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="th-mfeed-title">{actionTypeLabel(a.action_type)}</span>
                      <span className="th-mfeed-meta">
                        {[a.device_hostname, a.created_by].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </span>
                    <span className="th-mfeed-end">
                      <span className={`inline-flex items-center gap-1.5 font-medium ${statusColor(a.status)}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${statusDotColor(a.status)}`} />
                        {ACTION_STATUS_LABELS[a.status] ?? a.status}
                      </span>
                      <time className="tabular-nums">{timeAgo(actionRelevantTime(a))}</time>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </DashSection>

      {panels.length > 0 && (
        <DashSection label="Insights" hint="Tap to open">
          <ul className="th-mpanels">
            {panels.map((panel, index) => (
              <InsightPanel key={panel.key} panel={panel} index={index} />
            ))}
          </ul>
        </DashSection>
      )}
    </div>
  );
}
