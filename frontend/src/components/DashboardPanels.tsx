import { useState } from "react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ChevronDown, Cpu, RefreshCcw, ShieldCheck, Timer } from "lucide-react";

import type { FleetRisk, RiskCheck } from "../api/devices";
import type { Alert } from "../types/alert";
import { ALERT_KIND_LABELS } from "../types/alert";
import { alertDeadline } from "../utils/alertDeadline";
import { formatCount } from "../utils/number";
import { TONE, TERMS, humanize } from "../utils/deviceStatus";
import { parseUTC } from "../utils/time";
import { PriorityChip } from "./alerts/AlertControls";
import { MeterRow, SubHead, percent } from "./MeterPanels";
import { Button, EmptyState, SkeletonRows } from "./ui";

function PanelError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <EmptyState
      className="flex-1"
      icon={<AlertTriangle className="h-5 w-5" />}
      title={`Couldn't load ${what}`}
      description="The server did not respond. Try again."
      action={
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RefreshCcw className="h-3.5 w-3.5" />
          Retry
        </Button>
      }
    />
  );
}

// ── SLA at risk ───────────────────────────────────────────────────────────

/** When the alert's current deadline falls: to take it while nobody has, else to fix it. */
function dueTime(alert: Alert): number | null {
  if (alert.waiting_since) return null;
  const due = !alert.acknowledged_at && alert.ack_due_at ? alert.ack_due_at : alert.resolve_due_at;
  return due ? parseUTC(due).getTime() : null;
}

/** Open alerts with a running deadline, nearest (or most overdue) first. */
export function slaRows(alerts: Alert[], limit = 6): Alert[] {
  const seen = new Set<number>();
  return alerts
    .filter((alert) => {
      if (seen.has(alert.id) || alert.id <= 0 || alert.state !== "open") return false;
      seen.add(alert.id);
      return dueTime(alert) != null;
    })
    .sort((a, b) => (dueTime(a) ?? 0) - (dueTime(b) ?? 0))
    .slice(0, limit);
}

export function SlaAtRiskCard({
  alerts,
  overdue,
  loading,
  failed,
  onRetry,
}: {
  alerts: Alert[] | null;
  overdue: number;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const rows = alerts ? slaRows(alerts) : [];
  return (
    <section className="premium-card th-dash-card flex h-full flex-col p-0" aria-labelledby="sla-title">
      <div className="th-panel-head">
        <h2 id="sla-title" className="flex items-center gap-2">
          SLA at risk
        </h2>
        <span className="flex items-center gap-3">
          {overdue > 0 && (
            <span className="th-status-chip" style={{ "--chip-tone": TONE.critical } as CSSProperties}>
              <i />
              {formatCount(overdue)} overdue
            </span>
          )}
          <Link to="/alerts" className="th-link-btn">
            Open queue
          </Link>
        </span>
      </div>
      {loading && !alerts ? (
        <SkeletonRows rows={4} />
      ) : failed && !alerts ? (
        <PanelError what="deadlines" onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <EmptyState
          className="flex-1"
          icon={<Timer className="h-5 w-5" />}
          title="No deadline running"
          description="Every open alert is taken in time or waiting on someone else."
        />
      ) : (
        <ul className="flex-1 px-2 pb-2">
          {rows.map((alert, index) => {
            const deadline = alertDeadline(alert);
            return (
              <li key={alert.id} className="th-share-row" style={{ "--i": index } as CSSProperties}>
                <Link to="/alerts" className="th-sla-row">
                  <PriorityChip priority={alert.priority} />
                  <span className="min-w-0 flex-1">
                    <span className="th-sla-title">
                      {alert.title || ALERT_KIND_LABELS[alert.kind] || humanize(alert.kind)}
                    </span>
                    <span className="th-sla-meta">
                      {[alert.device_name, alert.client_name ?? TERMS.noClient, alert.assigned_to_name ?? "Unassigned"]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  {deadline && (
                    <span
                      className="th-sla-due"
                      style={{ "--due-tone": deadline.tone } as CSSProperties}
                      title={deadline.title}
                    >
                      {deadline.label}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <p className="th-panel-foot mt-auto">Nearest deadline first: to take an alert, then to fix it.</p>
    </section>
  );
}

// ── Security & risk ───────────────────────────────────────────────────────

function RiskRow({ check, index }: { check: RiskCheck; index: number }) {
  const [open, setOpen] = useState(false);
  const tone = check.count === 0 ? TONE.neutral : check.severity === "critical" ? TONE.critical : TONE.warning;
  const more = check.count - check.devices.length;
  return (
    <li className="th-share-row" style={{ "--i": index } as CSSProperties}>
      <button
        type="button"
        className="th-risk-row"
        style={{ "--row-tone": tone } as CSSProperties}
        data-empty={check.count === 0 || undefined}
        disabled={check.count === 0}
        aria-expanded={check.count > 0 ? open : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <i aria-hidden="true" />
        <span className="flex-1 truncate text-left">{check.label}</span>
        <strong className="tabular-nums">{formatCount(check.count)}</strong>
        <ChevronDown className="th-risk-chevron h-3.5 w-3.5" data-open={open || undefined} aria-hidden="true" />
      </button>
      {open && check.count > 0 && (
        <ul className="th-risk-devices">
          {check.devices.map((device) => (
            <li key={device.id}>
              <Link to={`/devices?device=${device.id}`} className="th-risk-device">
                <span className="min-w-0 flex-1 truncate">
                  {device.name}
                  <span className="th-risk-client"> · {device.client_name ?? TERMS.noClient}</span>
                </span>
                <span className="th-risk-detail">{device.detail}</span>
              </Link>
            </li>
          ))}
          {more > 0 && <li className="th-risk-more">and {formatCount(more)} more</li>}
        </ul>
      )}
    </li>
  );
}

export function SecurityRiskCard({
  risk,
  failed,
  onRetry,
}: {
  risk: FleetRisk | null;
  failed: boolean;
  onRetry: () => void;
}) {
  const groups = (["security", "health"] as const).map((group) => ({
    group,
    // Checks with devices first; the rest keep their order below.
    checks: (risk?.checks ?? [])
      .filter((check) => check.group === group)
      .sort((a, b) => Number(b.count > 0) - Number(a.count > 0)),
  }));
  const flagged = risk?.checks.filter((check) => check.count > 0).length ?? 0;
  const score = risk?.security.average_score ?? null;
  return (
    <section className="premium-card th-dash-card flex h-full flex-col p-0" aria-labelledby="risk-title">
      <div className="th-panel-head">
        <h2 id="risk-title">Security &amp; risk</h2>
        {risk && (
          <span
            className="th-status-chip"
            style={
              {
                "--chip-tone":
                  score == null ? TONE.neutral : score >= 85 ? TONE.online : score >= 65 ? TONE.warning : TONE.critical,
              } as CSSProperties
            }
            title="Average security score of the devices that report one (0–100)"
          >
            <i />
            {score == null ? "No posture yet" : `Score ${Math.round(score)}/100`}
          </span>
        )}
      </div>
      {!risk && failed ? (
        <PanelError what="security checks" onRetry={onRetry} />
      ) : !risk ? (
        <SkeletonRows rows={6} />
      ) : (
        <div className="flex-1 px-2 pb-2">
          {groups.map(({ group, checks }, g) => (
            <div key={group}>
              <SubHead>
                {group === "security"
                  ? `Protection · ${formatCount(risk.security.protected)} of ${formatCount(risk.security.reported)} protected`
                  : `Device health · ${formatCount(risk.health_reported)} reporting`}
              </SubHead>
              <ul>
                {checks.map((check, index) => (
                  <RiskRow key={check.key} check={check} index={g * 5 + index} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <p className="th-panel-foot mt-auto flex items-center gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
        {risk
          ? flagged === 0
            ? "No check is failing on any device."
            : `${flagged} of ${risk.checks.length} checks need a look. Refreshed every 5 minutes.`
          : "From the security and health reports agents send."}
      </p>
    </section>
  );
}

// ── Agent versions ────────────────────────────────────────────────────────

export function AgentVersionsCard({
  risk,
  failed,
  onRetry,
  activeWindows,
  activeLinux,
}: {
  risk: FleetRisk | null;
  failed: boolean;
  onRetry: () => void;
  activeWindows: string | null;
  /** Active Linux versions (one per architecture). */
  activeLinux: string[];
}) {
  const families = (["windows", "linux"] as const)
    .map((family) => {
      const rows = (risk?.agent_versions ?? []).filter((row) => row.family === family);
      const total = rows.reduce((sum, row) => sum + row.count, 0);
      const active = family === "windows" ? (activeWindows ? [activeWindows] : []) : activeLinux;
      const current = rows.filter((row) => active.includes(row.version)).reduce((sum, row) => sum + row.count, 0);
      return { family, rows, total, active, current };
    })
    .filter((family) => family.total > 0);
  const total = families.reduce((sum, f) => sum + f.total, 0);
  const current = families.reduce((sum, f) => sum + f.current, 0);
  const behind = total - current;
  return (
    <section
      className="premium-card th-dash-card th-cp-overview flex h-full flex-col p-0"
      aria-labelledby="agent-versions-title"
    >
      <div className="th-panel-head">
        <h2 id="agent-versions-title">Agent versions</h2>
        {behind > 0 && (
          <Link to="/devices?filter=needs_agent_update" className="th-link-btn">
            Update {formatCount(behind)}
          </Link>
        )}
      </div>
      {!risk && failed ? (
        <PanelError what="agent versions" onRetry={onRetry} />
      ) : !risk ? (
        <SkeletonRows rows={4} />
      ) : families.length === 0 ? (
        <EmptyState className="flex-1" icon={<Cpu className="h-5 w-5" />} title="No agents reporting a version" />
      ) : (
        <div className="flex-1">
          <div className="th-version-hero">
            <p className="th-version-pct tabular-nums">{percent(current, total)}</p>
            <p className="th-version-caption">
              on the active agent
              {activeWindows ? ` (Windows ${activeWindows})` : ""} · {formatCount(behind)} behind
            </p>
          </div>
          {families.map(({ family, rows, total: familyTotal, active }) => (
            <div key={family}>
              <SubHead>{family === "windows" ? "Windows" : "Linux"}</SubHead>
              <ul className="th-cp-meters" data-dense="true">
                {rows.slice(0, 5).map((row, index) => {
                  const isActive = active.includes(row.version);
                  return (
                    <MeterRow
                      key={row.version}
                      index={index}
                      label={isActive ? `${row.version} · active` : row.version}
                      count={row.count}
                      total={familyTotal}
                      tone={isActive ? TONE.online : "var(--th-status-agent)"}
                      to={isActive ? "/devices" : "/devices?filter=needs_agent_update"}
                      title={`${formatCount(row.count)} ${family === "windows" ? "Windows" : "Linux"} agents on ${row.version}`}
                    />
                  );
                })}
              </ul>
              {rows.length > 5 && (
                <p className="px-5 pb-2 text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                  and {rows.length - 5} older versions ({formatCount(rows.slice(5).reduce((s, r) => s + r.count, 0))}{" "}
                  agents)
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="th-panel-foot mt-auto">Active devices with an agent; MikroTik connectors are not counted.</p>
    </section>
  );
}
