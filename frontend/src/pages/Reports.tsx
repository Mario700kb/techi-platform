import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Download, FileBarChart, FileSpreadsheet, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

import {
  createReportSchedule, deleteReportRun, deleteReportSchedule, downloadReport, generateReport,
  getReportClients, getReportRuns, getReportSchedules, ReportCadence, ReportClient,
  ReportFormat, ReportRun, ReportSchedule, updateReportSchedule,
} from "../api/reports";
import type { ReportScope, ReportType } from "../api/reports";
import { Device, getDevices } from "../api/devices";
import { useAuth } from "../auth/AuthContext";
import ConfirmationModal from "../components/ConfirmationModal";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import { APP_TIME_ZONE, parseUTC, tiranaInputToUtcIso } from "../utils/time";

const fieldClass = "min-h-10 w-full rounded-lg border px-3 text-sm outline-none focus:border-techi-orange/60";
const fieldStyle = { background: "var(--th-bg-input)", borderColor: "var(--th-border-input)", color: "var(--th-text-primary)" };
const REPORT_TYPES: { value: ReportType; label: string }[] = [
  { value: "full", label: "Full Report" }, { value: "overview", label: "Overview" },
  { value: "user_activity", label: "User Activity" }, { value: "status_uptime", label: "Status / Uptime" },
  { value: "health", label: "Health" }, { value: "alerts", label: "Alerts" },
  { value: "actions", label: "Actions" }, { value: "software", label: "Software" },
  { value: "remote_support", label: "Remote Support" }, { value: "assignments", label: "Assignments" },
  { value: "notes", label: "Notes" }, { value: "event_history", label: "Event History" },
];
const reportLabel = (type?: ReportType) => REPORT_TYPES.find((item) => item.value === type)?.label ?? "Full Report";

/** "2026-10-05" -> "2026-10-06" (calendar arithmetic, timezone-free). */
function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

function formatDate(value?: string | null) {
  return value ? parseUTC(value).toLocaleString(undefined, { timeZone: APP_TIME_ZONE }) : "—";
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
  const [scopeType, setScopeType] = useState<ReportScope>("client");
  const [deviceId, setDeviceId] = useState("");
  const [deviceQuery, setDeviceQuery] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [reportType, setReportType] = useState<ReportType>("full");
  const [reportFormat, setReportFormat] = useState<ReportFormat>("pdf");
  const [periodDays, setPeriodDays] = useState(30);
  const [periodChoice, setPeriodChoice] = useState("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleName, setScheduleName] = useState("");
  const [cadence, setCadence] = useState<ReportCadence>("monthly");
  const [hourLocal, setHourLocal] = useState(8);
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

  useEffect(() => {
    if (scopeType !== "device") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setDevicesLoading(true);
      getDevices({ search: deviceQuery || undefined }, 0, 100, controller.signal)
        .then((result) => {
          setDevices(result.devices);
          setDeviceId((current) => result.devices.some((device) => String(device.id) === current) ? current : String(result.devices[0]?.id ?? ""));
        })
        .catch((err) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Unable to load devices"); })
        .finally(() => { if (!controller.signal.aborted) setDevicesLoading(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [scopeType, deviceQuery]);

  const stats = useMemo(() => ({
    completed: runs.filter((run) => run.status === "completed").length,
    failed: runs.filter((run) => run.status === "failed").length,
    scheduled: schedules.filter((schedule) => schedule.enabled).length,
  }), [runs, schedules]);

  async function handleGenerate() {
    if (scopeType === "client" ? !clientId : !deviceId) return;
    if (periodChoice === "custom" && (!customFrom || !customTo || customFrom > customTo)) {
      setError("Select a valid custom date range."); return;
    }
    setBusy(true); setError(null); setSuccess(null);
    try {
      const range = periodChoice === "custom" ? {
        // Whole Tirana days: from 00:00 on the first day to 00:00 after the last.
        period_from: tiranaInputToUtcIso(customFrom),
        period_to: new Date(Math.min(Date.parse(tiranaInputToUtcIso(nextDay(customTo))), Date.now())).toISOString(),
      } : { period_days: Number(periodChoice) };
      const run = await generateReport({
        scope_type: scopeType,
        ...(scopeType === "client" ? { client_id: Number(clientId) } : { device_id: Number(deviceId) }),
        report_type: scopeType === "client" ? "full" : reportType,
        report_format: reportFormat, ...range,
      });
      setRuns((current) => [run, ...current]);
      setSuccess(`${run.device_name || run.client_name} ${run.report_format.toUpperCase()} report is ready.`);
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
        cadence, period_days: periodDays, hour_local: hourLocal,
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
          <div><h1 className="text-xl font-bold" style={{ color: "var(--th-text-primary)" }}>Reports</h1><p className="mt-1 text-sm" style={{ color: "var(--th-text-muted)" }}>Client and device reports, on demand or scheduled.</p></div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>
      </header>

      {(error || success) && <div className="rounded-lg border px-4 py-3 text-sm" style={{ borderColor: error ? "color-mix(in srgb, var(--th-status-critical) 40%, transparent)" : "color-mix(in srgb, var(--th-status-online) 35%, transparent)", background: error ? "color-mix(in srgb, var(--th-status-critical) 8%, transparent)" : "color-mix(in srgb, var(--th-status-online) 8%, transparent)", color: "var(--th-text-primary)" }}>{error || success}</div>}

      <section className="grid grid-cols-3 gap-2 sm:gap-4">
        {[{ label: "Reports ready", value: stats.completed }, { label: "Active schedules", value: stats.scheduled }, { label: "Failed runs", value: stats.failed }].map((item) => <div key={item.label} className="premium-card p-3 sm:p-4"><p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--th-text-muted)" }}>{item.label}</p><p className="mt-1 text-2xl font-bold" style={{ color: "var(--th-text-primary)" }}>{item.value}</p></div>)}
      </section>

      <section className="premium-card p-4">
        <div className="mb-4 flex items-center gap-2"><FileSpreadsheet className="h-4 w-4 text-techi-orange" /><h2 className="font-semibold" style={{ color: "var(--th-text-primary)" }}>Generate now</h2></div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 md:items-end">
          <label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Scope<select className={`${fieldClass} mt-1`} style={fieldStyle} value={scopeType} onChange={(event) => { setScopeType(event.target.value as ReportScope); setReportType("full"); if (event.target.value === "device") { setReportFormat("pdf"); if (periodChoice === "90" || periodChoice === "365") { setPeriodChoice("30"); setPeriodDays(30); } } }}><option value="client">Client</option><option value="device">Device</option></select></label>
          {scopeType === "client" ? <label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Client<select className={`${fieldClass} mt-1`} style={fieldStyle} value={clientId} onChange={(event) => setClientId(event.target.value)}><option value="">Select client</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label> : <div className="space-y-1"><label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Find device<input className={`${fieldClass} mt-1`} style={fieldStyle} value={deviceQuery} onChange={(event) => setDeviceQuery(event.target.value)} placeholder="Search name or IP" /></label><select aria-label="Device" className={fieldClass} style={fieldStyle} value={deviceId} onChange={(event) => setDeviceId(event.target.value)} disabled={devicesLoading}><option value="">{devicesLoading ? "Loading devices..." : "Select device"}</option>{devices.map((device) => <option key={device.id} value={device.id}>{device.display_name || device.hostname || `Device ${device.id}`} · {device.client_name || "Unassigned"} · #{device.id}</option>)}</select></div>}
          <label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Report type<select className={`${fieldClass} mt-1`} style={fieldStyle} value={scopeType === "client" ? "full" : reportType} onChange={(event) => { const next = event.target.value as ReportType; setReportType(next); if (next === "full" && scopeType === "device") setReportFormat("pdf"); }}><option value="full">Full Report</option>{scopeType === "device" && REPORT_TYPES.filter((item) => item.value !== "full").map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Format<select className={`${fieldClass} mt-1`} style={fieldStyle} value={reportFormat} onChange={(event) => setReportFormat(event.target.value as ReportFormat)}><option value="pdf">PDF</option><option value="csv" disabled={scopeType === "device" && reportType === "full"}>CSV{scopeType === "device" && reportType === "full" ? " (not available for Full Device Report)" : ""}</option></select></label>
          <label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Period<select className={`${fieldClass} mt-1`} style={fieldStyle} value={periodChoice} onChange={(event) => { setPeriodChoice(event.target.value); if (event.target.value !== "custom") setPeriodDays(Number(event.target.value)); }}><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>{scopeType === "client" && <><option value="90">Last 90 days</option><option value="365">Last year</option></>}<option value="custom">Custom date range</option></select></label>
          {periodChoice === "custom" && <><label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>From<input type="date" className={`${fieldClass} mt-1`} style={fieldStyle} value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label><label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>To (inclusive)<input type="date" className={`${fieldClass} mt-1`} style={fieldStyle} value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label></>}
          <Button onClick={() => void handleGenerate()} disabled={busy || (scopeType === "client" ? !clientId : !deviceId) || (scopeType === "device" && reportType === "full" && reportFormat === "csv")}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Generate</Button>
        </div>
        {scopeType === "device" && <p className="mt-3 text-xs" style={{ color: "var(--th-text-muted)" }}>Full Device Report is PDF only because its sections have different table columns. Category reports support PDF and CSV. Historical sections show available records and retention notes; software and overview are current snapshots.</p>}
      </section>

      {isAdmin && <section className="premium-card p-4">
        <div className="flex items-center justify-between"><div className="flex items-center gap-2"><CalendarClock className="h-4 w-4 text-techi-orange" /><h2 className="font-semibold" style={{ color: "var(--th-text-primary)" }}>Client schedules</h2></div><Button size="sm" variant="secondary" onClick={() => setShowSchedule((value) => !value)}><Plus className="h-4 w-4" />New</Button></div>
        {showSchedule && <div className="mt-4 grid gap-3 rounded-xl border p-3 md:grid-cols-5 md:items-end" style={{ borderColor: "var(--th-border-subtle)", background: "var(--th-bg-input)" }}>
          <label className="text-xs font-semibold md:col-span-2" style={{ color: "var(--th-text-secondary)" }}>Schedule name<input className={`${fieldClass} mt-1`} style={fieldStyle} value={scheduleName} maxLength={160} onChange={(event) => setScheduleName(event.target.value)} /></label>
          <label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>Cadence<select className={`${fieldClass} mt-1`} style={fieldStyle} value={cadence} onChange={(event) => { setCadence(event.target.value as ReportCadence); setScheduleDay(event.target.value === "weekly" ? 0 : 1); }}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
          <label className="text-xs font-semibold" style={{ color: "var(--th-text-secondary)" }}>{cadence === "daily" ? "Hour (Tirana)" : cadence === "weekly" ? "Weekday (0=Mon)" : "Day of month"}<input type="number" className={`${fieldClass} mt-1`} style={fieldStyle} min={cadence === "weekly" ? 0 : 1} max={cadence === "weekly" ? 6 : cadence === "monthly" ? 28 : 23} value={cadence === "daily" ? hourLocal : scheduleDay} onChange={(event) => cadence === "daily" ? setHourLocal(Number(event.target.value)) : setScheduleDay(Number(event.target.value))} /></label>
          <Button onClick={() => void handleCreateSchedule()} disabled={busy || !scheduleName.trim() || !clientId}>Create schedule</Button>
        </div>}
        <div className="mt-4 space-y-2">{schedules.length === 0 ? <p className="py-6 text-center text-sm" style={{ color: "var(--th-text-muted)" }}>No scheduled reports.</p> : schedules.map((schedule) => <div key={schedule.id} className="flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: "var(--th-border-subtle)" }}><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold" style={{ color: "var(--th-text-primary)" }}>{schedule.name}</p><Badge variant={schedule.enabled ? "primary" : "neutral"}>{schedule.enabled ? "Active" : "Paused"}</Badge><Badge variant="ghost">{schedule.report_format.toUpperCase()}</Badge></div><p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>{schedule.client_name} · {schedule.cadence} · next {formatDate(schedule.next_run_at)}</p></div><div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => void toggleSchedule(schedule)}>{schedule.enabled ? "Pause" : "Resume"}</Button><Button size="sm" variant="ghost" onClick={() => setDeleteTarget(schedule)} aria-label={`Delete ${schedule.name}`}><Trash2 className="h-4 w-4" /></Button></div></div>)}</div>
      </section>}

      <section className="premium-card overflow-hidden">
        <div className="border-b p-4" style={{ borderColor: "var(--th-border-subtle)" }}><h2 className="font-semibold" style={{ color: "var(--th-text-primary)" }}>Report history</h2></div>
        {loading ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-techi-orange" /></div> : runs.length === 0 ? <p className="py-12 text-center text-sm" style={{ color: "var(--th-text-muted)" }}>Generate the first report to begin history.</p> : <div className="divide-y" style={{ borderColor: "var(--th-border-subtle)" }}>{runs.map((run) => <div key={run.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: "var(--th-border-subtle)" }}><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold" style={{ color: "var(--th-text-primary)" }}>{run.device_name || run.client_name}</p><Badge variant="ghost">{run.scope_type === "device" ? "Device" : "Client"}</Badge><Badge variant="ghost">{reportLabel(run.report_type)}</Badge><Badge variant={run.status === "completed" ? "primary" : run.status === "failed" ? "secondary" : "neutral"}>{run.status}</Badge><Badge variant="ghost">{run.report_format.toUpperCase()}</Badge></div><p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>Generated at {formatDate(run.completed_at || run.created_at)} · By {run.generated_by} · Size {formatBytes(run.size_bytes)}</p>{run.error_message && <p className="mt-1 text-xs text-red-300">{run.error_message}</p>}</div><div className="flex gap-2">{run.status === "completed" && <Button size="sm" variant="secondary" onClick={() => void downloadReport(run).catch((err) => setError(err instanceof Error ? err.message : "Download failed"))}><Download className="h-4 w-4" />Download</Button>}{isAdmin && <Button size="sm" variant="ghost" onClick={() => setDeleteRunTarget(run)} aria-label={`Delete report ${run.device_name || run.client_name}`}><Trash2 className="h-4 w-4" /></Button>}</div></div>)}</div>}
      </section>

      {deleteTarget && <ConfirmationModal title="Delete report schedule" confirmLabel="Delete schedule" loading={busy} onClose={() => setDeleteTarget(null)} onConfirm={() => void confirmDelete()}><p>This removes <strong>{deleteTarget.name}</strong>. Generated report history remains available.</p></ConfirmationModal>}

      {deleteRunTarget && <ConfirmationModal title="Delete report" confirmLabel="Delete report" loading={busy} onClose={() => setDeleteRunTarget(null)} onConfirm={() => void confirmDeleteRun()}><p>Permanently delete the <strong>{deleteRunTarget.device_name || deleteRunTarget.client_name}</strong> {deleteRunTarget.report_format.toUpperCase()} report from {formatDate(deleteRunTarget.created_at)}? This removes the stored file and cannot be undone. {deleteRunTarget.schedule_id ? "Its schedule is not affected." : ""}</p></ConfirmationModal>}
    </div>
  );
}
