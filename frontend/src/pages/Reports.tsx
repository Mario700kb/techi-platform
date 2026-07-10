import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Download, FileBarChart, FileSpreadsheet, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

import {
  createReportSchedule, deleteReportRun, deleteReportSchedule, downloadReport, generateReport,
  getReportClients, getReportRuns, getReportSchedules, ReportCadence, ReportClient,
  ReportFormat, ReportRun, ReportSchedule, updateReportSchedule,
} from "../api/reports";
import { useAuth } from "../auth/AuthContext";
import ConfirmationModal from "../components/ConfirmationModal";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";

const fieldClass = "min-h-10 w-full rounded-lg border px-3 text-sm outline-none focus:border-techi-orange/60";
const fieldStyle = { background: "var(--th-bg-input)", borderColor: "var(--th-border-input)", color: "var(--th-text-primary)" };

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

function formatBytes(value?: number | null) {
  if (!value) return "—";
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

export default function Reports() {
  const { can } = useAuth();
  const isAdmin = can("admin");
  const [clients, setClients] = useState<ReportClient[]>([]);
  const [runs, setRuns] = useState<ReportRun[]>([]);
  const [schedules, setSchedules] = useState<ReportSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [reportFormat, setReportFormat] = useState<ReportFormat>("pdf");
  const [periodDays, setPeriodDays] = useState(30);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleName, setScheduleName] = useState("");
  const [cadence, setCadence] = useState<ReportCadence>("monthly");
  const [hourUtc, setHourUtc] = useState(6);
  const [scheduleDay, setScheduleDay] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<ReportSchedule | null>(null);
  const [deleteRunTarget, setDeleteRunTarget] = useState<ReportRun | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [clientRows, runRows, scheduleRows] = await Promise.all([
        getReportClients(), getReportRuns(), isAdmin ? getReportSchedules() : Promise.resolve([]),
      ]);
      setClients(clientRows); setRuns(runRows.items); setSchedules(scheduleRows);
      setClientId((current) => current || (clientRows[0] ? String(clientRows[0].id) : ""));
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to load reports"); }
    finally { setLoading(false); }
  }, [isAdmin]);

  useEffect(() => { void load(); }, [load]);

  const stats = useMemo(() => ({
    completed: runs.filter((run) => run.status === "completed").length,
    failed: runs.filter((run) => run.status === "failed").length,
    scheduled: schedules.filter((schedule) => schedule.enabled).length,
  }), [runs, schedules]);

  async function handleGenerate() {
    if (!clientId) return;
    setBusy(true); setError(null); setSuccess(null);
    try {
      const run = await generateReport({ client_id: Number(clientId), report_format: reportFormat, period_days: periodDays });
      setRuns((current) => [run, ...current]);
      setSuccess(`${run.client_name} ${run.report_format.toUpperCase()} report is ready.`);
      await downloadReport(run);
    } catch (err) { setError(err instanceof Error ? err.message : "Report generation failed"); }
    finally { setBusy(false); }
  }

  async function handleCreateSchedule() {
    if (!clientId || !scheduleName.trim()) return;
    setBusy(true); setError(null);
    try {
      const created = await createReportSchedule({
        name: scheduleName.trim(), client_id: Number(clientId), report_format: reportFormat,
        cadence, period_days: periodDays, hour_utc: hourUtc,
        day_of_week: cadence === "weekly" ? scheduleDay : null,
        day_of_month: cadence === "monthly" ? scheduleDay : null,
      });
      setSchedules((current) => [...current, created]);
      setScheduleName(""); setShowSchedule(false); setSuccess("Report schedule created.");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to create schedule"); }
    finally { setBusy(false); }
  }

  async function toggleSchedule(schedule: ReportSchedule) {
    try {
      const updated = await updateReportSchedule(schedule.id, { enabled: !schedule.enabled });
      setSchedules((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to update schedule"); }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deleteReportSchedule(deleteTarget.id);
      setSchedules((current) => current.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to delete schedule"); }
    finally { setBusy(false); }
  }

  async function confirmDeleteRun() {
    if (!deleteRunTarget) return;
    setBusy(true);
    try {
      await deleteReportRun(deleteRunTarget.id);
      setRuns((current) => current.filter((item) => item.id !== deleteRunTarget.id));
      setDeleteRunTarget(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to delete report"); }
    finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-3 pb-24 sm:p-5 md:pb-5">
      <header className="premium-card flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-techi-orange/15 text-techi-orange"><FileBarChart className="h-5 w-5" /></span>
          <div><h1 className="text-xl font-bold" style={{ color: "var(--th-text-primary)" }}>Client Reports</h1><p className="mt-1 text-sm" style={{ color: "var(--th-text-muted)" }}>Fleet health and alert proof-of-value, on demand or scheduled.</p></div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>
      </header>

      {(error || success) && <div className="rounded-lg border px-4 py-3 text-sm" style={{ borderColor: error ? "rgba(239,68,68,.4)" : "rgba(34,197,94,.35)", background: error ? "rgba(239,68,68,.08)" : "rgba(34,197,94,.08)", color: "var(--th-text-primary)" }}>{error || success}</div>}

      <section className="grid grid-cols-3 gap-2 sm:gap-4">
        {[{ label: "Reports ready", value: stats.completed }, { label: "Active schedules", value: stats.scheduled }, { label: "Failed runs", value: stats.failed }].map((item) => <div key={item.label} className="premium-card p-3 sm:p-4"><p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--th-text-muted)" }}>{item.label}</p><p className="mt-1 text-2xl font-bold" style={{ color: "var(--th-text-primary)" }}>{item.value}</p></div>)}
      </section>

      <section className="premium-card p-4">
        <div className="mb-4 flex items-center gap-2"><FileSpreadsheet className="h-4 w-4 text-techi-orange" /><h2 className="font-semibold" style={{ color: "var(--th-text-primary)" }}>Generate now</h2></div>
        <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_auto] md:items-end">
          <label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Client<select className={`${fieldClass} mt-1`} style={fieldStyle} value={clientId} onChange={(event) => setClientId(event.target.value)}><option value="">Select client</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
          <label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Format<select className={`${fieldClass} mt-1`} style={fieldStyle} value={reportFormat} onChange={(event) => setReportFormat(event.target.value as ReportFormat)}><option value="pdf">PDF</option><option value="csv">CSV</option></select></label>
          <label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Period<select className={`${fieldClass} mt-1`} style={fieldStyle} value={periodDays} onChange={(event) => setPeriodDays(Number(event.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option></select></label>
          <Button onClick={() => void handleGenerate()} disabled={busy || !clientId}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Generate</Button>
        </div>
      </section>

      {isAdmin && <section className="premium-card p-4">
        <div className="flex items-center justify-between"><div className="flex items-center gap-2"><CalendarClock className="h-4 w-4 text-techi-orange" /><h2 className="font-semibold" style={{ color: "var(--th-text-primary)" }}>Schedules</h2></div><Button size="sm" variant="secondary" onClick={() => setShowSchedule((value) => !value)}><Plus className="h-4 w-4" />New</Button></div>
        {showSchedule && <div className="mt-4 grid gap-3 rounded-xl border p-3 md:grid-cols-5 md:items-end" style={{ borderColor: "var(--th-border-subtle)", background: "var(--th-bg-input)" }}>
          <label className="text-xs font-semibold md:col-span-2" style={{ color: "var(--th-text-secondary)" }}>Schedule name<input className={`${fieldClass} mt-1`} style={fieldStyle} value={scheduleName} maxLength={160} onChange={(event) => setScheduleName(event.target.value)} /></label>
          <label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Cadence<select className={`${fieldClass} mt-1`} style={fieldStyle} value={cadence} onChange={(event) => { setCadence(event.target.value as ReportCadence); setScheduleDay(event.target.value === "weekly" ? 0 : 1); }}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
          <label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>{cadence === "daily" ? "Hour UTC" : cadence === "weekly" ? "Weekday (0=Mon)" : "Day of month"}<input type="number" className={`${fieldClass} mt-1`} style={fieldStyle} min={cadence === "weekly" ? 0 : 1} max={cadence === "weekly" ? 6 : cadence === "monthly" ? 28 : 23} value={cadence === "daily" ? hourUtc : scheduleDay} onChange={(event) => cadence === "daily" ? setHourUtc(Number(event.target.value)) : setScheduleDay(Number(event.target.value))} /></label>
          <Button onClick={() => void handleCreateSchedule()} disabled={busy || !scheduleName.trim() || !clientId}>Create schedule</Button>
        </div>}
        <div className="mt-4 space-y-2">{schedules.length === 0 ? <p className="py-6 text-center text-sm" style={{ color: "var(--th-text-muted)" }}>No scheduled reports.</p> : schedules.map((schedule) => <div key={schedule.id} className="flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: "var(--th-border-subtle)" }}><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold" style={{ color: "var(--th-text-primary)" }}>{schedule.name}</p><Badge variant={schedule.enabled ? "primary" : "neutral"}>{schedule.enabled ? "Active" : "Paused"}</Badge><Badge variant="ghost">{schedule.report_format.toUpperCase()}</Badge></div><p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>{schedule.client_name} · {schedule.cadence} · next {formatDate(schedule.next_run_at)}</p></div><div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => void toggleSchedule(schedule)}>{schedule.enabled ? "Pause" : "Resume"}</Button><Button size="sm" variant="ghost" onClick={() => setDeleteTarget(schedule)} aria-label={`Delete ${schedule.name}`}><Trash2 className="h-4 w-4" /></Button></div></div>)}</div>
      </section>}

      <section className="premium-card overflow-hidden">
        <div className="border-b p-4" style={{ borderColor: "var(--th-border-subtle)" }}><h2 className="font-semibold" style={{ color: "var(--th-text-primary)" }}>Report history</h2></div>
        {loading ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-techi-orange" /></div> : runs.length === 0 ? <p className="py-12 text-center text-sm" style={{ color: "var(--th-text-muted)" }}>Generate the first client report to begin history.</p> : <div className="divide-y" style={{ borderColor: "var(--th-border-subtle)" }}>{runs.map((run) => <div key={run.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: "var(--th-border-subtle)" }}><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold" style={{ color: "var(--th-text-primary)" }}>{run.client_name}</p><Badge variant={run.status === "completed" ? "primary" : run.status === "failed" ? "secondary" : "neutral"}>{run.status}</Badge><Badge variant="ghost">{run.report_format.toUpperCase()}</Badge></div><p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>{formatDate(run.created_at)} · {run.generated_by} · {formatBytes(run.size_bytes)}</p>{run.error_message && <p className="mt-1 text-xs text-red-300">{run.error_message}</p>}</div><div className="flex gap-2">{run.status === "completed" && <Button size="sm" variant="secondary" onClick={() => void downloadReport(run).catch((err) => setError(err instanceof Error ? err.message : "Download failed"))}><Download className="h-4 w-4" />Download</Button>}{isAdmin && <Button size="sm" variant="ghost" onClick={() => setDeleteRunTarget(run)} aria-label={`Delete report ${run.client_name}`}><Trash2 className="h-4 w-4" /></Button>}</div></div>)}</div>}
      </section>

      {deleteTarget && <ConfirmationModal title="Delete report schedule" confirmLabel="Delete schedule" loading={busy} onClose={() => setDeleteTarget(null)} onConfirm={() => void confirmDelete()}><p>This removes <strong>{deleteTarget.name}</strong>. Generated report history remains available.</p></ConfirmationModal>}

      {deleteRunTarget && <ConfirmationModal title="Delete report" confirmLabel="Delete report" loading={busy} onClose={() => setDeleteRunTarget(null)} onConfirm={() => void confirmDeleteRun()}><p>Permanently delete the <strong>{deleteRunTarget.client_name}</strong> {deleteRunTarget.report_format.toUpperCase()} report from {formatDate(deleteRunTarget.created_at)}? This removes the stored file and cannot be undone. {deleteRunTarget.schedule_id ? "Its schedule is not affected." : ""}</p></ConfirmationModal>}
    </div>
  );
}
