import { useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { BellOff, CalendarDays, CheckCircle2, ClipboardList, Copy } from "lucide-react";

import {
  addDutyShift,
  getAlertDuty,
  getAlertFindings,
  getAlertHandover,
  getAlertMutes,
  getAlertOperators,
  getAlertQuality,
  removeAlertMute,
  removeDutyShift,
} from "../../api/alerts";
import { useAuth } from "../../auth/AuthContext";
import { useCachedQuery } from "../../hooks/useCachedQuery";
import type { DeadlineReport, Finding, HandoverItem } from "../../types/alert";
import { ALERT_KIND_LABELS, WAITING_LABELS } from "../../types/alert";
import type { AlertKind } from "../../types/alert";
import { formatCount } from "../../utils/number";
import { formatSpan } from "../../utils/alertDeadline";
import { APP_TIME_ZONE, DISPLAY_LOCALE, formatLocalDateTime, parseUTC, timeAgo } from "../../utils/time";
import { Button, DatePicker, EmptyState, Modal, Select } from "../ui";
import { PriorityChip } from "./AlertControls";

const FINDING_TYPES: { id: Finding["type"] | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "security", label: "Security" },
  { id: "reboot", label: "Restart pending" },
  { id: "power", label: "Unexpected shutdowns" },
  { id: "disk_forecast", label: "Disk forecast" },
];
const FINDING_TONE: Record<Finding["severity"], string> = {
  high: "var(--th-status-critical)",
  medium: "var(--th-status-warning)",
  low: "var(--th-status-info)",
};

/** States to fix on a plan, not incidents: they do not wait in the alert queue. */
export function FindingsView() {
  const navigate = useNavigate();
  const [type, setType] = useState<Finding["type"] | "all">("all");
  const { data, loading } = useCachedQuery("page.alerts.findings", () => getAlertFindings());
  const items = (data?.items ?? []).filter((i) => type === "all" || i.type === type);
  return (
    <div className="th-ac-view">
      <p className="th-ac-muted">
        Weak security, restarts waiting, PCs that keep losing power and disks that will fill. Fixed in batches, by plan:
        they do not wait in the alert queue. A protection that gets switched off still opens an alert.
      </p>
      <div className="th-ac-seg" role="group" aria-label="Finding type">
        {FINDING_TYPES.map((t) => (
          <button key={t.id} type="button" aria-pressed={type === t.id} onClick={() => setType(t.id)}>
            {t.label}
            <b>{formatCount(t.id === "all" ? (data?.items.length ?? 0) : (data?.counts[t.id] ?? 0))}</b>
          </button>
        ))}
      </div>
      {loading && !data ? (
        <div className="th-alerts-skeleton" aria-busy="true" />
      ) : items.length === 0 ? (
        <EmptyState icon={<CheckCircle2 className="h-5 w-5" />} title="Nothing to fix here" />
      ) : (
        <div className="th-ac-table-wrap">
          <table className="th-ac-table">
            <thead>
              <tr>
                <th>Finding</th>
                <th>Device</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr
                  key={`${item.device_id}-${item.type}-${i}`}
                  data-clickable="true"
                  onClick={() => navigate(`/devices?device=${item.device_id}`)}
                >
                  <td>
                    <span
                      className="th-status-chip"
                      style={{ "--chip-tone": FINDING_TONE[item.severity] } as CSSProperties}
                    >
                      <i />
                      {item.title}
                    </span>
                  </td>
                  <td>
                    <b>{item.device_name}</b>
                    <small>
                      {item.client_name ?? "No client"} · {item.device_role === "server" ? "Server" : "Workstation"}
                    </small>
                  </td>
                  <td>
                    {item.detail}
                    {item.since && <small>since {formatLocalDateTime(item.since)}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Which rules make noise, so they can be tuned every week. */
export function QualityView() {
  const [days, setDays] = useState(7);
  const { data, loading } = useCachedQuery(`page.alerts.quality.${days}`, () => getAlertQuality(days));
  return (
    <div className="th-ac-view">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="th-ac-muted">
          Noise = closed by itself within 15 minutes, came back, or closed as false alarm / expected. Tune the noisiest
          rules each week.
        </p>
        <div className="th-ac-seg" role="group" aria-label="Period">
          {[7, 30].map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      {data && (
        <div className="grid grid-cols-3 gap-3">
          <div className="th-kpi">
            <span className="th-kpi-label">Alerts</span>
            <span className="th-kpi-value">{formatCount(data.totals.opened)}</span>
          </div>
          <div className="th-kpi" style={{ "--kpi-tone": "var(--th-status-warning)" } as CSSProperties}>
            <span className="th-kpi-label">Noise</span>
            <span className="th-kpi-value">{data.totals.noise_pct}%</span>
          </div>
          <div className="th-kpi">
            <span className="th-kpi-label">Issue types</span>
            <span className="th-kpi-value">{formatCount(data.totals.issues)}</span>
          </div>
        </div>
      )}
      {data?.deadlines && <DeadlineSection report={data.deadlines} />}
      {loading && !data ? (
        <div className="th-alerts-skeleton" aria-busy="true" />
      ) : (
        <div className="th-ac-table-wrap">
          <table className="th-ac-table">
            <thead>
              <tr>
                <th>Issue</th>
                <th className="text-right">Opened</th>
                <th className="text-right">Came back</th>
                <th className="text-right">Devices</th>
                <th className="text-right">False alarm</th>
                <th className="text-right">Time to owner</th>
                <th className="text-right">Time to fix</th>
                <th className="text-right">Noise</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {(data?.rows ?? []).map((row) => (
                <tr key={row.issue}>
                  <td>
                    <b>{row.title}</b>
                    <small>{row.still_open} still open</small>
                  </td>
                  <td className="text-right">{formatCount(row.opened)}</td>
                  <td className="text-right">{formatCount(row.reopened)}</td>
                  <td className="text-right">{formatCount(row.devices)}</td>
                  <td className="text-right">{formatCount(row.false_positive)}</td>
                  <td className="text-right">
                    {row.mtta_minutes != null ? `${Math.round(row.mtta_minutes)} min` : "—"}
                  </td>
                  <td className="text-right">
                    {row.mttr_minutes != null ? `${Math.round(row.mttr_minutes)} min` : "—"}
                  </td>
                  <td className="text-right">
                    <span
                      style={{
                        color:
                          row.noise_pct >= 50
                            ? "var(--th-status-critical)"
                            : row.noise_pct >= 20
                              ? "var(--th-status-warning)"
                              : undefined,
                      }}
                    >
                      {row.noise_pct}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function MutesView() {
  const { can } = useAuth();
  const { data, loading, reload } = useCachedQuery("page.alerts.mutes", () => getAlertMutes());
  const [busy, setBusy] = useState<number | null>(null);
  const rows = data ?? [];
  return (
    <div className="th-ac-view">
      <p className="th-ac-muted">
        Rules that keep matching alerts from opening. Add one from an alert's panel (“Mute rule…”).
      </p>
      {loading && !data ? (
        <div className="th-alerts-skeleton" aria-busy="true" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<BellOff className="h-5 w-5" />} title="No mute rules" description="Every alert can open." />
      ) : (
        <div className="th-ac-table-wrap">
          <table className="th-ac-table">
            <thead>
              <tr>
                <th>What</th>
                <th>Where</th>
                <th>Until</th>
                <th>Why</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>
                    <b>{m.kind ? (ALERT_KIND_LABELS[m.kind as AlertKind] ?? m.kind) : "Every alert"}</b>
                    {m.fingerprint && <small className="th-ac-mono">{m.fingerprint}</small>}
                  </td>
                  <td>{m.device_name ?? (m.client_name ? `All of ${m.client_name}` : "Every device")}</td>
                  <td>{m.until ? formatLocalDateTime(m.until) : "Until removed"}</td>
                  <td>
                    {m.reason}
                    <small>
                      {m.created_by} · {timeAgo(m.created_at)}
                    </small>
                  </td>
                  <td className="text-right">
                    {can("operator") && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === m.id}
                        onClick={async () => {
                          setBusy(m.id);
                          try {
                            await removeAlertMute(m.id);
                            await reload();
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function minutes(value: number | null | undefined): string {
  return value == null ? "—" : formatSpan(value * 60_000);
}

function pctTone(value: number | null | undefined, good: number): string | undefined {
  if (value == null) return undefined;
  return value >= good
    ? "var(--th-status-online)"
    : value >= good - 20
      ? "var(--th-status-warning)"
      : "var(--th-status-critical)";
}

/** Whether the work keeps its deadlines: taken in time, fixed in time, by whom. */
function DeadlineSection({ report }: { report: DeadlineReport }) {
  return (
    <section className="grid gap-3">
      <h3 className="text-[13px] font-semibold">Deadlines</h3>
      <div className="grid grid-cols-3 gap-3">
        <div className="th-kpi" style={{ "--kpi-tone": pctTone(report.urgent_owned_pct, 100) } as CSSProperties}>
          <span className="th-kpi-label">P1–P2 with an owner</span>
          <span className="th-kpi-value">{report.urgent_owned_pct != null ? `${report.urgent_owned_pct}%` : "—"}</span>
          <span className="th-kpi-hint">Target 100%</span>
        </div>
        <div className="th-kpi">
          <span className="th-kpi-label">Fixed by a person</span>
          <span className="th-kpi-value">{formatCount(report.fixed)}</span>
        </div>
        <div
          className="th-kpi"
          style={
            {
              "--kpi-tone":
                report.fix_failed_pct != null && report.fix_failed_pct > 10 ? "var(--th-status-warning)" : undefined,
            } as CSSProperties
          }
        >
          <span className="th-kpi-label">Back within a day of a fix</span>
          <span className="th-kpi-value">{report.fix_failed_pct != null ? `${report.fix_failed_pct}%` : "—"}</span>
          <span className="th-kpi-hint">Target 10% or less · {formatCount(report.fix_failed)} alerts</span>
        </div>
      </div>
      <div className="th-ac-table-wrap">
        <table className="th-ac-table">
          <thead>
            <tr>
              <th>Priority</th>
              <th className="text-right">Alerts</th>
              <th className="text-right">With an owner</th>
              <th className="text-right">Time to take</th>
              <th className="text-right">Taken in time</th>
              <th className="text-right">Time to fix</th>
              <th className="text-right">Fixed in time</th>
              <th className="text-right">Overdue now</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {report.by_priority.map((row) => (
              <tr key={row.priority}>
                <td>
                  <PriorityChip priority={row.priority} />
                </td>
                <td className="text-right">{formatCount(row.alerts)}</td>
                <td className="text-right">{row.owned_pct != null ? `${row.owned_pct}%` : "—"}</td>
                <td className="text-right">{minutes(row.mtta_minutes)}</td>
                <td className="text-right" style={{ color: pctTone(row.ack_met_pct, 90) }}>
                  {row.ack_met_pct != null ? `${row.ack_met_pct}%` : "—"}
                </td>
                <td className="text-right">{minutes(row.mttr_minutes)}</td>
                <td className="text-right" style={{ color: pctTone(row.met_pct, 90) }}>
                  {row.met_pct != null ? `${row.met_pct}%` : "—"}
                </td>
                <td className="text-right">{formatCount(row.overdue_open)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.by_person.length > 0 && (
        <div className="th-ac-table-wrap">
          <table className="th-ac-table">
            <thead>
              <tr>
                <th>Resolved by</th>
                <th className="text-right">Alerts</th>
                <th className="text-right">Time to fix</th>
                <th className="text-right">Fixed in time</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {report.by_person.map((row) => (
                <tr key={row.name}>
                  <td>
                    <b>{row.name}</b>
                  </td>
                  <td className="text-right">{formatCount(row.resolved)}</td>
                  <td className="text-right">{minutes(row.mttr_minutes)}</td>
                  <td className="text-right" style={{ color: pctTone(row.met_pct, 90) }}>
                    {row.met_pct != null ? `${row.met_pct}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="th-ac-muted">
        Times are counted on the deadline clock: working hours, or every hour for a P1 on a server, less the time spent
        waiting on others.
      </p>
    </section>
  );
}

const WEEKDAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Today in Tirana as "YYYY-MM-DD" (the roster's days are Tirana days). */
function isoDay(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: APP_TIME_ZONE });
}

/** "Mon 19 Oct" for a roster day; noon UTC is the same day in Tirana. */
function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(DISPLAY_LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: APP_TIME_ZONE,
  });
}

function clockMinutes(hhmm: string | undefined): number {
  const [h, m] = (hhmm ?? "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Whole working days read as such ("3 working days"), the rest as hours. */
function workingSpan(minutes: number, dayMinutes: number): string {
  if (dayMinutes > 0 && minutes >= dayMinutes && minutes % dayMinutes === 0) {
    const days = minutes / dayMinutes;
    return `${days} working day${days === 1 ? "" : "s"}`;
  }
  return formatSpan(minutes * 60_000);
}

/** Who keeps the queue (the dispatcher) and the deadlines every alert gets. */
export function DutyView() {
  const { can } = useAuth();
  const canEdit = can("admin");
  const { data, loading, reload } = useCachedQuery("page.alerts.duty", () => getAlertDuty());
  const people = useCachedQuery(canEdit ? "page.alerts.operators" : null, () => getAlertOperators());
  const today = isoDay(new Date());
  const [form, setForm] = useState({ starts_on: today, ends_on: today, operator_id: "", backup_operator_id: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = (people.data ?? []).map((p) => ({ value: String(p.id), label: p.name }));
  const hours = data?.work_hours;
  const dayMinutes = clockMinutes(hours?.end) - clockMinutes(hours?.start);

  const add = async () => {
    if (!form.operator_id) return;
    setBusy(true);
    setError(null);
    try {
      await addDutyShift({
        starts_on: form.starts_on,
        ends_on: form.ends_on,
        operator_id: Number(form.operator_id),
        backup_operator_id: form.backup_operator_id ? Number(form.backup_operator_id) : null,
      });
      setForm((f) => ({ ...f, operator_id: "", backup_operator_id: "" }));
      await reload();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "The shift was not saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="th-ac-view">
      <p className="th-ac-muted">
        The dispatcher keeps the queue: every P1–P2 that nobody takes in half its time goes to them, and they hear when
        a deadline passes. Not every alert is theirs to fix, only to see that someone does.
      </p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div
          className="th-kpi"
          style={
            { "--kpi-tone": data?.current ? "var(--th-status-online)" : "var(--th-status-warning)" } as CSSProperties
          }
        >
          <span className="th-kpi-label">
            <CalendarDays className="h-3.5 w-3.5" /> Dispatcher today
          </span>
          <span className="th-kpi-value">{data ? (data.current?.operator_name ?? "Nobody") : "—"}</span>
          <span className="th-kpi-hint">
            {data?.current
              ? `Stand-in: ${data.current.backup_name ?? "none"} · until ${dayLabel(data.current.ends_on)}`
              : "Unowned alerts are not handed to anyone: add a shift"}
          </span>
        </div>
        <div className="th-kpi">
          <span className="th-kpi-label">Working hours (the clock)</span>
          <span className="th-kpi-value text-[18px]">
            {hours?.start && hours?.end ? `${hours.start}–${hours.end}` : "—"}
          </span>
          <span className="th-kpi-hint">
            {(hours?.days ?? []).map((d) => WEEKDAYS[d]).join(" ")} · {hours?.zone} · a P1 on a server counts every hour
          </span>
        </div>
      </div>

      {data && (
        <div className="th-ac-table-wrap">
          <table className="th-ac-table">
            <thead>
              <tr>
                <th>Priority</th>
                <th className="text-right">Take within</th>
                <th className="text-right">Fix within</th>
                <th>Escalation</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.deadlines.map((d) => (
                <tr key={d.priority}>
                  <td>
                    <PriorityChip priority={d.priority} />
                  </td>
                  <td className="text-right">{d.ack_minutes ? workingSpan(d.ack_minutes, dayMinutes) : "—"}</td>
                  <td className="text-right">{workingSpan(d.resolve_minutes, dayMinutes)}</td>
                  <td>
                    {d.priority <= 2
                      ? "Dispatcher at half the time to take · stand-in when not taken · owner at half the time to fix · manager when missed"
                      : d.priority === 3
                        ? "Marked when not taken in a day; listed in the handover"
                        : "Marked when missed; reviewed weekly"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && (
        <div className="th-ac-duty-form flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-[13px]">
            <span className="th-text-muted">From</span>
            <DatePicker
              value={form.starts_on}
              onChange={(v) => setForm((f) => ({ ...f, starts_on: v }))}
              clearable={false}
            />
          </label>
          <label className="grid gap-1 text-[13px]">
            <span className="th-text-muted">To</span>
            <DatePicker
              value={form.ends_on}
              min={form.starts_on}
              onChange={(v) => setForm((f) => ({ ...f, ends_on: v }))}
              clearable={false}
            />
          </label>
          <label className="grid gap-1 text-[13px]">
            <span className="th-text-muted">Dispatcher</span>
            <Select
              className="w-[200px]"
              value={form.operator_id}
              placeholder="Choose"
              options={options}
              onChange={(v) => setForm((f) => ({ ...f, operator_id: v }))}
            />
          </label>
          <label className="grid gap-1 text-[13px]">
            <span className="th-text-muted">Stand-in</span>
            <Select
              className="w-[200px]"
              value={form.backup_operator_id}
              options={[{ value: "", label: "None" }, ...options.filter((o) => o.value !== form.operator_id)]}
              onChange={(v) => setForm((f) => ({ ...f, backup_operator_id: v }))}
            />
          </label>
          <Button
            size="sm"
            disabled={busy || !form.operator_id || !form.starts_on || !form.ends_on}
            onClick={() => void add()}
          >
            Add shift
          </Button>
          {error && (
            <p className="th-ac-error w-full" role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      {loading && !data ? (
        <div className="th-alerts-skeleton" aria-busy="true" />
      ) : (data?.shifts ?? []).length === 0 ? (
        <EmptyState
          icon={<CalendarDays className="h-5 w-5" />}
          title="No shifts"
          description={canEdit ? "Add who keeps the queue, a week at a time." : "An administrator sets the roster."}
        />
      ) : (
        <div className="th-ac-table-wrap">
          <table className="th-ac-table">
            <thead>
              <tr>
                <th>Days</th>
                <th>Dispatcher</th>
                <th>Stand-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.shifts ?? []).map((shift) => {
                const now = data?.current?.id === shift.id;
                return (
                  <tr key={shift.id} data-muted={shift.ends_on < (data?.today ?? today)}>
                    <td className="tabular-nums">
                      {dayLabel(shift.starts_on)}
                      {shift.ends_on !== shift.starts_on && ` – ${dayLabel(shift.ends_on)}`}
                      {now && <small>today</small>}
                    </td>
                    <td>
                      <b>{shift.operator_name}</b>
                    </td>
                    <td>{shift.backup_name ?? "—"}</td>
                    <td className="text-right">
                      {canEdit && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            try {
                              await removeDutyShift(shift.id);
                              await reload();
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function handoverText(rows: HandoverItem[]): string {
  return rows
    .map((r) => {
      const due = r.resolve_due_at ? formatLocalDateTime(r.resolve_due_at) : "—";
      const state =
        r.sla_state === "overdue"
          ? " · OVERDUE"
          : r.sla_state === "ack_overdue"
            ? " · not taken"
            : r.waiting_reason
              ? ` · ${WAITING_LABELS[r.waiting_reason]}`
              : "";
      return `P${r.priority} ${r.title} · ${r.device_name} · ${r.owner ?? "no owner"} · due ${due}${state}${r.last_note ? ` — ${r.last_note}` : ""}`;
    })
    .join("\n");
}

/** The end-of-day handover: what stays open, whose it is, when it is due. */
export function HandoverModal({ onClose, onOpen }: { onClose: () => void; onOpen: (alertId: number) => void }) {
  const { data, loading } = useCachedQuery("page.alerts.handover", () => getAlertHandover());
  const [copied, setCopied] = useState(false);
  const rows = data ?? [];
  return (
    <Modal
      title="Handover"
      subtitle="Alerts someone owns and every P1–P2: for the next shift. Also sent at 16:45 to the handover channel."
      icon={ClipboardList}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            disabled={rows.length === 0}
            onClick={() =>
              void navigator.clipboard
                .writeText(handoverText(rows))
                .then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                })
                .catch(() => setCopied(false))
            }
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? "Copied" : "Copy as text"}
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {loading && !data ? (
        <div className="th-alerts-skeleton" aria-busy="true" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<CheckCircle2 className="h-5 w-5" />} title="Nothing to hand over" />
      ) : (
        <div className="th-ac-table-wrap">
          <table className="th-ac-table">
            <thead>
              <tr>
                <th>Alert</th>
                <th>Owner</th>
                <th className="text-right">Due</th>
                <th>Last note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const late = r.sla_state === "overdue" || r.sla_state === "ack_overdue";
                const left = r.resolve_due_at ? parseUTC(r.resolve_due_at).getTime() - Date.now() : null;
                return (
                  <tr key={r.id} data-clickable="true" onClick={() => onOpen(r.id)}>
                    <td>
                      <span className="flex items-center gap-2">
                        <PriorityChip priority={r.priority} />
                        <b>{r.title}</b>
                      </span>
                      <small>
                        {r.device_name}
                        {r.client_name ? ` · ${r.client_name}` : ""}
                      </small>
                    </td>
                    <td style={{ color: r.owner ? undefined : "var(--th-status-warning)" }}>{r.owner ?? "No owner"}</td>
                    <td
                      className="text-right tabular-nums"
                      style={{ color: late ? "var(--th-status-critical)" : undefined }}
                    >
                      {r.waiting_reason
                        ? WAITING_LABELS[r.waiting_reason]
                        : left == null
                          ? "—"
                          : left <= 0
                            ? `Overdue ${formatSpan(left)}`
                            : `in ${formatSpan(left)}`}
                      <small>{r.resolve_due_at ? formatLocalDateTime(r.resolve_due_at) : ""}</small>
                    </td>
                    <td>{r.last_note ?? <span className="th-ac-muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
