import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { BellOff, Check, ExternalLink, StickyNote, UserCheck, X } from "lucide-react";

import {
  addAlertNote,
  createAlertMute,
  getAlertDetail,
  resolveAlert,
  snoozeAlert,
  takeAlert,
  assignAlert,
  unsnoozeAlert,
} from "../../api/alerts";
import { useAuth } from "../../auth/AuthContext";
import type { AlertDetail } from "../../types/alert";
import { ALERT_SEVERITY_TONE, RESOLUTION_LABELS } from "../../types/alert";
import { APP_TIME_ZONE, formatDateTime, formatLocalDateTime, timeAgo } from "../../utils/time";
import AlertKindIcon from "../AlertKindIcon";
import { Button } from "../ui";
import AiAnalysisPanel from "./AiAnalysisPanel";
import { CommandBlock, MuteModal, PriorityChip, ResolveModal, SnoozeMenu } from "./AlertControls";

const ACTIONS: Record<string, string> = {
  opened: "Opened",
  reopened: "Came back",
  resolved: "Resolved",
  taken: "Taken",
  assigned: "Assigned to",
  unassigned: "Released",
  snoozed: "Snoozed",
  unsnoozed: "Woken",
  note: "Note",
  escalated: "Escalated",
  analysed: "Analysed",
};

function HistoryStrip({ history }: { history: string[] }) {
  const days = 30;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const counts = new Array(days).fill(0);
  for (const at of history) {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    const index = days - 1 - Math.round((today.getTime() - d.getTime()) / 86_400_000);
    if (index >= 0 && index < days) counts[index] += 1;
  }
  const first = new Date(today.getTime() - (days - 1) * 86_400_000);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: APP_TIME_ZONE });
  return (
    <div>
      <div className="th-ac-strip" role="img" aria-label={`${history.length} times in 30 days`}>
        {counts.map((n, i) => (
          <span key={i} data-on={n > 0} title={n ? `${n}×` : undefined} />
        ))}
      </div>
      <div className="th-ac-strip-axis">
        <span>{fmt(first)}</span>
        <span>{history.length}× in 30 days</span>
        <span>{fmt(today)}</span>
      </div>
    </div>
  );
}

export default function AlertDrawer({
  alertId,
  onClose,
  onChanged,
}: {
  alertId: number | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { user, can } = useAuth();
  const canOperate = can("operator");
  const canRun = can("admin");
  const [detail, setDetail] = useState<AlertDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [muteOpen, setMuteOpen] = useState(false);
  const [note, setNote] = useState("");
  const open = alertId != null;

  const load = useCallback(async () => {
    if (alertId == null) return;
    setError(null);
    try {
      setDetail(await getAlertDetail(alertId));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't load the alert.");
    }
  }, [alertId]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !resolveOpen && !muteOpen) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, resolveOpen, muteOpen]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const alert = detail?.alert;
  const tone = alert ? ALERT_SEVERITY_TONE[alert.severity] : "var(--th-text-muted)";
  const isOpenAlert = alert?.state === "open";
  const snoozed = alert?.snoozed_until && new Date(alert.snoozed_until).getTime() > Date.now();
  const mine = alert?.assigned_to_id != null && alert.assigned_to_id === user?.id;
  const facts = detail?.facts ?? {};
  const events = detail?.evidence.events ?? [];

  return (
    <>
      <div
        className={`th-drawer-scrim fixed inset-0 z-40 backdrop-blur-[2px] ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        style={{ background: "var(--th-scrim)" }}
        data-open={open}
        role="presentation"
        onClick={onClose}
      />
      <aside
        className={`th-drawer th-drawer-panel fixed right-0 top-0 z-50 flex h-full w-full max-w-[760px] flex-col shadow-2xl ${open ? "translate-x-0" : "translate-x-full"}`}
        data-open={open}
        aria-label="Alert"
        aria-hidden={!open}
        style={{ borderLeft: "1px solid var(--th-border-drawer)", background: "var(--th-bg-drawer)" }}
      >
        {open && (
          <>
            <header className="th-ac-drawer-head">
              <div className="flex items-start gap-3">
                <span className="th-alerts-kind" aria-hidden="true" style={{ color: tone }}>
                  {alert && <AlertKindIcon kind={alert.kind} fingerprint={alert.fingerprint} className="h-5 w-5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {alert && <PriorityChip priority={alert.priority} />}
                    <h2 className="th-ac-drawer-title">{alert?.title ?? "Loading…"}</h2>
                  </div>
                  {alert && (
                    <p className="th-ac-drawer-sub">
                      {alert.summary}
                      {(alert.occurrences ?? 1) > 1 && ` · came back ${alert.occurrences}×`}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  title="Close (Esc)"
                  className="th-icon-btn th-icon-btn-ghost flex-none"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {alert && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="th-status-chip capitalize" style={{ "--chip-tone": tone } as CSSProperties}>
                    <i />
                    {alert.severity}
                  </span>
                  <span className="th-status-chip">
                    {alert.state === "resolved"
                      ? `${RESOLUTION_LABELS[alert.resolution ?? "auto"]}${alert.resolved_by ? ` · ${alert.resolved_by}` : ""}`
                      : snoozed
                        ? alert.snooze_until_worse
                          ? "Snoozed until worse"
                          : `Snoozed until ${formatLocalDateTime(alert.snoozed_until)}`
                        : alert.assigned_to_name
                          ? `Owner: ${alert.assigned_to_name}`
                          : "No owner"}
                  </span>
                  {alert.device_id != null && (
                    <Link to={`/devices?device=${alert.device_id}`} className="th-status-chip th-ac-chip-link">
                      {alert.device_name ?? `Device #${alert.device_id}`}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                  {alert.client_name && <span className="th-status-chip">{alert.client_name}</span>}
                  {typeof facts.role === "string" && (
                    <span className="th-status-chip">{facts.role === "server" ? "Server" : "Workstation"}</span>
                  )}
                  {typeof facts.os === "string" && <span className="th-status-chip">{facts.os}</span>}
                  {typeof facts.agent_version === "string" && (
                    <span className="th-status-chip">Agent {facts.agent_version}</span>
                  )}
                  {typeof facts.uptime_hours === "number" && (
                    <span className="th-status-chip">Up {facts.uptime_hours} h</span>
                  )}
                </div>
              )}
              {alert && canOperate && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {isOpenAlert && !mine && (
                    <Button size="sm" disabled={busy} onClick={() => void act(() => takeAlert(alert.id))}>
                      <UserCheck className="h-3.5 w-3.5" />
                      Take it
                    </Button>
                  )}
                  {isOpenAlert && mine && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void act(() => assignAlert(alert.id, null))}
                    >
                      Release
                    </Button>
                  )}
                  {isOpenAlert &&
                    (snoozed ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void act(() => unsnoozeAlert(alert.id))}
                      >
                        Wake up
                      </Button>
                    ) : (
                      <SnoozeMenu
                        disabled={busy}
                        onSnooze={(choice) => void act(() => snoozeAlert(alert.id, choice))}
                      />
                    ))}
                  {isOpenAlert && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setResolveOpen(true)}>
                      <Check className="h-3.5 w-3.5" />
                      Resolve…
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMuteOpen(true)}>
                    <BellOff className="h-3.5 w-3.5" />
                    Mute rule…
                  </Button>
                </div>
              )}
              {error && (
                <p className="th-ac-error mt-2" role="alert">
                  {error}
                </p>
              )}
            </header>

            <div className="th-ac-drawer-body">
              {!detail && !error && <div className="th-alerts-skeleton" aria-busy="true" />}
              {detail && alert && (
                <>
                  <section className="th-ac-section">
                    <h3>What happened</h3>
                    <p>{detail.description}</p>
                    <p className="th-ac-muted">
                      Opened {formatDateTime(alert.created_at)}
                      {alert.last_seen_at &&
                        alert.last_seen_at !== alert.created_at &&
                        ` · last ${timeAgo(alert.last_seen_at)}`}
                    </p>
                  </section>

                  {(events.length > 0 ||
                    detail.evidence.top_processes ||
                    detail.evidence.findings ||
                    detail.evidence.disks ||
                    detail.evidence.site) && (
                    <section className="th-ac-section">
                      <h3>Evidence</h3>
                      {events.length > 0 && (
                        <div className="th-ac-table-wrap">
                          <table className="th-ac-table">
                            <tbody>
                              {events.slice(0, 12).map((e, i) => (
                                <tr key={i} data-muted={!e.counts}>
                                  <td className="tabular-nums">{formatLocalDateTime(e.at)}</td>
                                  <td className="th-ac-mono">
                                    {e.source} {e.event_id}
                                  </td>
                                  <td>
                                    <b>{e.title}</b>
                                    {e.message && <small>{e.message}</small>}
                                    {!e.counts && <small>Not a problem (informational)</small>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {detail.evidence.also_seen_7d && detail.evidence.also_seen_7d.length > 0 && (
                        <p className="th-ac-muted">
                          Also in the last 7 days: {detail.evidence.also_seen_7d.join(", ")}
                        </p>
                      )}
                      {detail.evidence.top_processes && detail.evidence.top_processes.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {detail.evidence.top_processes.slice(0, 5).map((p) => (
                            <span key={p.n} className="th-status-chip th-ac-mono">
                              {p.n}
                              {p.c != null && ` ${Math.round(p.c)}% CPU`}
                              {p.m != null && ` · ${Math.round(p.m)} MB`}
                            </span>
                          ))}
                        </div>
                      )}
                      {detail.evidence.findings && detail.evidence.findings.length > 0 && (
                        <ul className="list-disc pl-5">
                          {detail.evidence.findings.map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      )}
                      {Array.isArray(detail.evidence.disks) && detail.evidence.disks.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {detail.evidence.disks.map((d, i) => (
                            <span key={i} className="th-status-chip th-ac-mono">
                              {String(d.mount ?? d.name ?? "Disk")}
                              {d.used_pct != null && ` ${Math.round(Number(d.used_pct))}% used`}
                              {d.free_gb != null && ` · ${Number(d.free_gb).toFixed(1)} GB free`}
                              {d.problem ? ` · ${String(d.problem)}` : ""}
                            </span>
                          ))}
                        </div>
                      )}
                      {detail.evidence.site && (
                        <p>
                          At this site {detail.evidence.site.offline} of {detail.evidence.site.devices} devices are
                          offline.
                        </p>
                      )}
                    </section>
                  )}

                  <section className="th-ac-section">
                    <h3>History</h3>
                    <HistoryStrip history={detail.history} />
                  </section>

                  {detail.runbook && (
                    <section className="th-ac-section">
                      <h3>Runbook</h3>
                      <p>{detail.runbook.why}</p>
                      <ol className="th-ac-steps">
                        {detail.runbook.steps.map((s, i) => (
                          <li key={i}>
                            <p>{s}</p>
                          </li>
                        ))}
                      </ol>
                      {detail.runbook.commands.map((c) => (
                        <CommandBlock
                          key={c.label}
                          label={c.label}
                          script={c.script}
                          risk={c.risk}
                          deviceId={alert.device_id}
                          deviceName={alert.device_name}
                          canRun={canRun}
                        />
                      ))}
                      {detail.runbook.escalate && <p className="th-ac-muted">Escalate: {detail.runbook.escalate}</p>}
                    </section>
                  )}

                  <AiAnalysisPanel
                    key={alert.id}
                    alertId={alert.id}
                    deviceId={alert.device_id}
                    deviceName={alert.device_name ?? null}
                    enabled={detail.ai_enabled}
                    canOperate={canOperate}
                    canRun={canRun}
                    initial={detail.analysis}
                  />

                  <section className="th-ac-section">
                    <h3>Activity</h3>
                    {canOperate && (
                      <form
                        className="flex gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const text = note.trim();
                          if (!text) return;
                          void act(async () => {
                            await addAlertNote(alert.id, text);
                            setNote("");
                          });
                        }}
                      >
                        <input
                          id="alert-note"
                          className="th-input flex-1"
                          maxLength={1000}
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="Add a note for the team"
                          aria-label="Note"
                        />
                        <Button size="sm" variant="secondary" type="submit" disabled={busy || !note.trim()}>
                          <StickyNote className="h-3.5 w-3.5" />
                          Add
                        </Button>
                      </form>
                    )}
                    <ol className="th-ac-timeline">
                      {detail.activity.map((a) => (
                        <li key={a.id}>
                          <span className="tabular-nums th-ac-muted" title={formatDateTime(a.at)}>
                            {timeAgo(a.at)}
                          </span>
                          <span>
                            <b>{ACTIONS[a.action] ?? a.action}</b>
                            {a.detail && ` · ${a.detail}`}
                            {a.actor && <span className="th-ac-muted"> · {a.actor}</span>}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </section>
                </>
              )}
            </div>
          </>
        )}
      </aside>

      {resolveOpen && alert && (
        <ResolveModal
          count={1}
          onClose={() => setResolveOpen(false)}
          onResolve={async (resolution, text) => {
            await act(() => resolveAlert(alert.id, resolution, text));
            setResolveOpen(false);
          }}
        />
      )}
      {muteOpen && alert && (
        <MuteModal
          alert={alert}
          onClose={() => setMuteOpen(false)}
          onMute={async (body) => {
            await act(() => createAlertMute(body));
            setMuteOpen(false);
          }}
        />
      )}
    </>
  );
}
