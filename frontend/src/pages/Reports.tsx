import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CheckCircle2,
  Download,
  FileCheck2,
  FileSpreadsheet,
  History,
  Loader2,
  Monitor,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";

import {
  createReportSchedule,
  deleteReportRun,
  deleteReportSchedule,
  downloadReport,
  generateReport,
  getReportClients,
  getReportRuns,
  getReportSchedules,
  ReportCadence,
  ReportClient,
  ReportFormat,
  ReportRun,
  ReportSchedule,
  ReportStatus,
  updateReportSchedule,
} from "../api/reports";
import type { ReportScope, ReportType } from "../api/reports";
import { Device, getDevices } from "../api/devices";
import { useAuth } from "../auth/AuthContext";
import ConfirmationModal from "../components/ConfirmationModal";
import Button from "../components/ui/Button";
import PageHeader from "../components/ui/PageHeader";
import TablePagination from "../components/ui/TablePagination";
import { CardHead } from "../components/ui/PanelCard";
import { EmptyState, SelectField, DatePicker } from "../components/ui";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { useTabIndicator } from "../hooks/useTabIndicator";
import { TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { formatLocalDateTime, tiranaInputToUtcIso } from "../utils/time";

const REPORT_TYPES: { value: ReportType; label: string }[] = [
  { value: "full", label: "Full Report" },
  { value: "overview", label: "Overview" },
  { value: "user_activity", label: "User Activity" },
  { value: "status_uptime", label: "Status / Uptime" },
  { value: "health", label: "Health" },
  { value: "alerts", label: "Alerts" },
  { value: "actions", label: "Actions" },
  { value: "software", label: "Software" },
  { value: "remote_support", label: "Remote Support" },
  { value: "assignments", label: "Assignments" },
  { value: "notes", label: "Notes" },
  { value: "event_history", label: "Event History" },
];
const reportLabel = (type?: ReportType) => REPORT_TYPES.find((item) => item.value === type)?.label ?? "Full Report";

/** "2026-10-05" -> "2026-10-06" (calendar arithmetic, timezone-free). */
function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

function formatDate(value?: string | null) {
  return value ? formatLocalDateTime(value) : "—";
}

/** Whole days, Tirana time. The end is exclusive (00:00 after the last day,
 *  or "now"), so the last covered day is the one just before it. */
function formatPeriod(start: string, end: string) {
  const day: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const last = new Date(Date.parse(end.endsWith("Z") || end.includes("+") ? end : `${end}Z`) - 1000).toISOString();
  return `${formatLocalDateTime(start, day)} – ${formatLocalDateTime(last, day)}`;
}

function formatBytes(value?: number | null) {
  if (!value) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

const RUN_STATUS: Record<ReportStatus, { label: string; tone: string }> = {
  completed: { label: "Completed", tone: TONE.online },
  pending: { label: "Running", tone: TONE.info },
  failed: { label: "Failed", tone: TONE.critical },
};

type HistoryFilter = "all" | ReportScope;

interface ReportsView {
  clients: ReportClient[];
  runs: ReportRun[];
  schedules: ReportSchedule[];
}

const EMPTY_REPORTS: ReportsView = { clients: [], runs: [], schedules: [] };

const HISTORY_FILTERS: { id: HistoryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "client", label: "Client" },
  { id: "device", label: "Device" },
];

export default function Reports() {
  const { can } = useAuth();
  const isAdmin = can("admin");
  const [manualRefresh, setManualRefresh] = useState(false);
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
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [historySearch, setHistorySearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const scopeTabsRef = useTabIndicator<HTMLDivElement>(historyFilter);

  const reports = useCachedQuery<ReportsView>(`page.reports:${isAdmin ? "admin" : "operator"}`, async () => {
    const [clientRows, runRows, scheduleRows] = await Promise.all([
      getReportClients(),
      getReportRuns(),
      isAdmin ? getReportSchedules() : Promise.resolve([]),
    ]);
    return { clients: clientRows, runs: runRows.items, schedules: scheduleRows };
  });
  const { data, reload, setData } = reports;
  const { clients, runs, schedules } = data ?? EMPTY_REPORTS;
  const loading = reports.loading || manualRefresh;
  const updateView = (change: (view: ReportsView) => ReportsView) => setData((prev) => prev && change(prev));

  useEffect(() => {
    setClientId((current) => current || (clients[0] ? String(clients[0].id) : ""));
  }, [clients]);

  useEffect(() => {
    if (!reports.refreshing && reports.error) setError(reports.error);
  }, [reports.refreshing, reports.error]);

  const refresh = () => {
    setError(null);
    setManualRefresh(true);
    void reload().finally(() => setManualRefresh(false));
  };

  useEffect(() => {
    if (scopeType !== "device") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setDevicesLoading(true);
      getDevices({ search: deviceQuery || undefined }, 0, 100, controller.signal)
        .then((result) => {
          setDevices(result.devices);
          setDeviceId((current) =>
            result.devices.some((device) => String(device.id) === current)
              ? current
              : String(result.devices[0]?.id ?? ""),
          );
        })
        .catch((err) => {
          if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Unable to load devices");
        })
        .finally(() => {
          if (!controller.signal.aborted) setDevicesLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [scopeType, deviceQuery]);

  const stats = useMemo(
    () => ({
      completed: runs.filter((run) => run.status === "completed").length,
      failed: runs.filter((run) => run.status === "failed").length,
      scheduled: schedules.filter((schedule) => schedule.enabled).length,
    }),
    [runs, schedules],
  );

  const historyCounts = useMemo(() => {
    const counts: Record<HistoryFilter, number> = { all: runs.length, client: 0, device: 0 };
    for (const run of runs) counts[run.scope_type === "device" ? "device" : "client"] += 1;
    return counts;
  }, [runs]);
  const visibleRuns = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    return runs.filter((run) => {
      if (historyFilter !== "all" && (run.scope_type === "device" ? "device" : "client") !== historyFilter)
        return false;
      if (!q) return true;
      return [run.client_name, run.device_name ?? "", run.generated_by, reportLabel(run.report_type)].some((v) =>
        v.toLowerCase().includes(q),
      );
    });
  }, [runs, historyFilter, historySearch]);
  const pagedRuns = useMemo(
    () => visibleRuns.slice((page - 1) * pageSize, page * pageSize),
    [visibleRuns, page, pageSize],
  );

  async function handleGenerate() {
    if (scopeType === "client" ? !clientId : !deviceId) return;
    if (periodChoice === "custom" && (!customFrom || !customTo || customFrom > customTo)) {
      setError("Select a valid custom date range.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const range =
        periodChoice === "custom"
          ? {
              // Whole Tirana days: from 00:00 on the first day to 00:00 after the last.
              period_from: tiranaInputToUtcIso(customFrom),
              period_to: new Date(
                Math.min(Date.parse(tiranaInputToUtcIso(nextDay(customTo))), Date.now()),
              ).toISOString(),
            }
          : { period_days: Number(periodChoice) };
      const run = await generateReport({
        scope_type: scopeType,
        ...(scopeType === "client" ? { client_id: Number(clientId) } : { device_id: Number(deviceId) }),
        report_type: scopeType === "client" ? "full" : reportType,
        report_format: reportFormat,
        ...range,
      });
      updateView((view) => ({ ...view, runs: [run, ...view.runs] }));
      setSuccess(`${run.device_name || run.client_name} ${run.report_format.toUpperCase()} report is ready.`);
      await downloadReport(run);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Report generation failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateSchedule() {
    if (!clientId || !scheduleName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createReportSchedule({
        name: scheduleName.trim(),
        client_id: Number(clientId),
        report_format: reportFormat,
        cadence,
        period_days: periodDays,
        hour_local: hourLocal,
        day_of_week: cadence === "weekly" ? scheduleDay : null,
        day_of_month: cadence === "monthly" ? scheduleDay : null,
      });
      updateView((view) => ({ ...view, schedules: [...view.schedules, created] }));
      setScheduleName("");
      setShowSchedule(false);
      setSuccess("Report schedule created.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create schedule");
    } finally {
      setBusy(false);
    }
  }

  async function toggleSchedule(schedule: ReportSchedule) {
    try {
      const updated = await updateReportSchedule(schedule.id, { enabled: !schedule.enabled });
      updateView((view) => ({
        ...view,
        schedules: view.schedules.map((item) => (item.id === updated.id ? updated : item)),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update schedule");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deleteReportSchedule(deleteTarget.id);
      updateView((view) => ({ ...view, schedules: view.schedules.filter((item) => item.id !== deleteTarget.id) }));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete schedule");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDeleteRun() {
    if (!deleteRunTarget) return;
    setBusy(true);
    try {
      await deleteReportRun(deleteRunTarget.id);
      updateView((view) => ({ ...view, runs: view.runs.filter((item) => item.id !== deleteRunTarget.id) }));
      setDeleteRunTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete report");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="premium-page th-onb space-y-4">
      <PageHeader
        title="Reports"
        description="Client and device reports, on demand or on a schedule."
        actions={
          <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      {(error || success) && (
        <div
          className="th-onb-note th-onb-reveal"
          style={{ "--onb-tone": error ? "var(--th-status-critical)" : "var(--th-status-online)" } as CSSProperties}
          role={error ? "alert" : "status"}
        >
          {error ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          <span className="flex-1">{error || success}</span>
          <button
            type="button"
            className="th-onb-action !h-5 !w-5"
            onClick={() => {
              setError(null);
              setSuccess(null);
            }}
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── summary ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          {
            label: "Reports ready",
            value: stats.completed,
            hint: "Stored and downloadable",
            icon: FileCheck2,
            tone: TONE.online,
          },
          {
            label: "Active schedules",
            value: stats.scheduled,
            hint: `${formatCount(schedules.length)} configured`,
            icon: CalendarClock,
            tone: "var(--th-accent)",
          },
          {
            label: "Failed runs",
            value: stats.failed,
            hint: stats.failed ? "See the history below" : "Nothing failed",
            icon: AlertTriangle,
            tone: stats.failed ? TONE.critical : TONE.neutral,
          },
        ].map((item, index) => (
          <div
            key={item.label}
            className="th-onb-card th-onb-stat th-onb-enter"
            style={{ "--i": index } as CSSProperties}
          >
            <span className="th-onb-icon" style={{ "--onb-tone": item.tone } as CSSProperties}>
              <item.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                {item.label}
              </div>
              <div
                className="text-[24px] font-semibold leading-8 tabular-nums"
                style={{ color: "var(--th-text-primary)" }}
              >
                {formatCount(item.value)}
              </div>
              <div className="truncate text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                {item.hint}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── generate · schedules ────────────────────────────────────────── */}
      <div className={`grid items-stretch gap-4 ${isAdmin ? "xl:grid-cols-2" : ""}`}>
        <div className="th-onb-card th-onb-enter" style={{ "--i": 3 } as CSSProperties}>
          <CardHead
            icon={FileSpreadsheet}
            tone="var(--th-accent)"
            title="Generate now"
            subtitle="Builds the report and downloads it"
          />
          <div className="th-onb-body flex-1">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="th-onb-field">
                Scope
                <SelectField
                  value={scopeType}
                  onChange={(event) => {
                    setScopeType(event.target.value as ReportScope);
                    setReportType("full");
                    if (event.target.value === "device") {
                      setReportFormat("pdf");
                      if (periodChoice === "90" || periodChoice === "365") {
                        setPeriodChoice("30");
                        setPeriodDays(30);
                      }
                    }
                  }}
                >
                  <option value="client">Client</option>
                  <option value="device">Device</option>
                </SelectField>
              </label>
              {scopeType === "client" ? (
                <label className="th-onb-field">
                  Client
                  <SelectField value={clientId} onChange={(event) => setClientId(event.target.value)}>
                    <option value="">Select client</option>
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </SelectField>
                </label>
              ) : (
                <label className="th-onb-field">
                  Find device
                  <input
                    value={deviceQuery}
                    onChange={(event) => setDeviceQuery(event.target.value)}
                    placeholder="Search name or IP"
                  />
                </label>
              )}
              {scopeType === "device" && (
                <div className="th-onb-field th-onb-reveal sm:col-span-2">
                  Device
                  <SelectField
                    aria-label="Device"
                    value={deviceId}
                    onChange={(event) => setDeviceId(event.target.value)}
                    disabled={devicesLoading}
                  >
                    <option value="">{devicesLoading ? "Loading devices..." : "Select device"}</option>
                    {devices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.display_name || device.hostname || `Device ${device.id}`} ·{" "}
                        {device.client_name || "Unassigned"} · #{device.id}
                      </option>
                    ))}
                  </SelectField>
                </div>
              )}
              <label className="th-onb-field">
                Report type
                <SelectField
                  value={scopeType === "client" ? "full" : reportType}
                  onChange={(event) => {
                    const next = event.target.value as ReportType;
                    setReportType(next);
                    if (next === "full" && scopeType === "device") setReportFormat("pdf");
                  }}
                >
                  <option value="full">Full Report</option>
                  {scopeType === "device" &&
                    REPORT_TYPES.filter((item) => item.value !== "full").map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                </SelectField>
              </label>
              <label className="th-onb-field">
                Format
                <SelectField
                  value={reportFormat}
                  onChange={(event) => setReportFormat(event.target.value as ReportFormat)}
                >
                  <option value="pdf">PDF</option>
                  <option value="csv" disabled={scopeType === "device" && reportType === "full"}>
                    CSV
                    {scopeType === "device" && reportType === "full" ? " (not available for Full Device Report)" : ""}
                  </option>
                </SelectField>
              </label>
              <label className="th-onb-field sm:col-span-2">
                Period
                <SelectField
                  value={periodChoice}
                  onChange={(event) => {
                    setPeriodChoice(event.target.value);
                    if (event.target.value !== "custom") setPeriodDays(Number(event.target.value));
                  }}
                >
                  <option value="1">Last 24 hours</option>
                  <option value="7">Last 7 days</option>
                  <option value="30">Last 30 days</option>
                  {scopeType === "client" && (
                    <>
                      <option value="90">Last 90 days</option>
                      <option value="365">Last year</option>
                    </>
                  )}
                  <option value="custom">Custom date range</option>
                </SelectField>
              </label>
              {periodChoice === "custom" && (
                <>
                  <label className="th-onb-field th-onb-reveal">
                    From
                    <DatePicker value={customFrom} onChange={setCustomFrom} max={customTo || undefined} />
                  </label>
                  <label className="th-onb-field th-onb-reveal">
                    To (inclusive)
                    <DatePicker value={customTo} onChange={setCustomTo} min={customFrom || undefined} />
                  </label>
                </>
              )}
            </div>
            {scopeType === "device" && (
              <p className="th-onb-hint th-onb-reveal">
                Full Device Report is PDF only, because its sections have different columns. Category reports support
                PDF and CSV. Historical sections show the records still retained; software and overview are current
                snapshots.
              </p>
            )}
          </div>
          <div className="th-onb-foot">
            <Button
              className="w-full"
              onClick={() => void handleGenerate()}
              disabled={
                busy ||
                (scopeType === "client" ? !clientId : !deviceId) ||
                (scopeType === "device" && reportType === "full" && reportFormat === "csv")
              }
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Generate
            </Button>
          </div>
        </div>

        {isAdmin && (
          <div className="th-onb-card th-onb-enter" style={{ "--i": 4 } as CSSProperties}>
            <CardHead
              icon={CalendarClock}
              tone="var(--th-accent)"
              title="Client schedules"
              subtitle="Full client reports, generated and stored on a cadence"
              aside={
                <Button
                  size="sm"
                  variant={showSchedule ? "secondary" : "primary"}
                  onClick={() => setShowSchedule((value) => !value)}
                >
                  {showSchedule ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  {showSchedule ? "Close" : "New"}
                </Button>
              }
            />
            <div className="th-onb-body flex-1">
              {showSchedule && (
                <div className="th-onb-sub th-onb-reveal sm:grid-cols-2">
                  <label className="th-onb-field sm:col-span-2">
                    Schedule name
                    <input
                      value={scheduleName}
                      maxLength={160}
                      onChange={(event) => setScheduleName(event.target.value)}
                      placeholder={
                        clients.find((c) => String(c.id) === clientId)?.name
                          ? `${clients.find((c) => String(c.id) === clientId)!.name} monthly`
                          : "e.g. Monthly client report"
                      }
                    />
                  </label>
                  <label className="th-onb-field">
                    Cadence
                    <SelectField
                      value={cadence}
                      onChange={(event) => {
                        setCadence(event.target.value as ReportCadence);
                        setScheduleDay(event.target.value === "weekly" ? 0 : 1);
                      }}
                    >
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                    </SelectField>
                  </label>
                  <label className="th-onb-field">
                    {cadence === "daily" ? "Hour (Tirana)" : cadence === "weekly" ? "Weekday (0=Mon)" : "Day of month"}
                    <input
                      type="number"
                      min={cadence === "weekly" ? 0 : 1}
                      max={cadence === "weekly" ? 6 : cadence === "monthly" ? 28 : 23}
                      value={cadence === "daily" ? hourLocal : scheduleDay}
                      onChange={(event) =>
                        cadence === "daily"
                          ? setHourLocal(Number(event.target.value))
                          : setScheduleDay(Number(event.target.value))
                      }
                    />
                  </label>
                  <p className="th-onb-hint sm:col-span-2">
                    Uses the client, format and period chosen in Generate now.
                  </p>
                  <div className="sm:col-span-2">
                    <Button
                      className="w-full"
                      onClick={() => void handleCreateSchedule()}
                      disabled={busy || !scheduleName.trim() || !clientId}
                    >
                      Create schedule
                    </Button>
                  </div>
                </div>
              )}
              {schedules.length === 0 ? (
                !showSchedule && (
                  <div className="th-onb-empty !p-0">
                    <EmptyState
                      icon={<CalendarClock className="h-5 w-5" />}
                      title="No scheduled reports"
                      description="Schedule a client's full report to arrive daily, weekly or monthly."
                      action={
                        <Button size="sm" variant="secondary" onClick={() => setShowSchedule(true)}>
                          <Plus className="h-3.5 w-3.5" />
                          New schedule
                        </Button>
                      }
                    />
                  </div>
                )
              ) : (
                <ul className="th-onb-list">
                  {schedules.map((schedule, index) => (
                    <li key={schedule.id} className="th-alerts-row" style={{ "--row": index } as CSSProperties}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className="truncate text-[13px] font-medium"
                            style={{ color: "var(--th-text-primary)" }}
                          >
                            {schedule.name}
                          </span>
                          <span
                            className="th-status-chip !h-5 !px-2 !text-[11px]"
                            style={{ "--chip-tone": schedule.enabled ? TONE.online : TONE.neutral } as CSSProperties}
                          >
                            <i />
                            {schedule.enabled ? "Active" : "Paused"}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                          {schedule.client_name} · {schedule.cadence} · {schedule.report_format.toUpperCase()} · next{" "}
                          {formatDate(schedule.next_run_at)}
                        </div>
                      </div>
                      <div className="th-onb-actions">
                        <button
                          type="button"
                          className="th-onb-action"
                          onClick={() => void toggleSchedule(schedule)}
                          title={schedule.enabled ? "Pause" : "Resume"}
                          aria-label={`${schedule.enabled ? "Pause" : "Resume"} ${schedule.name}`}
                        >
                          {schedule.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                        </button>
                        <button
                          type="button"
                          className="th-onb-action"
                          data-tone="danger"
                          onClick={() => setDeleteTarget(schedule)}
                          title="Delete"
                          aria-label={`Delete ${schedule.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── history ─────────────────────────────────────────────────────── */}
      <div className="th-alerts-card th-onb-tokens th-onb-enter" style={{ "--i": 5 } as CSSProperties}>
        <CardHead
          icon={History}
          tone="var(--th-accent)"
          title="Report history"
          subtitle={loading && runs.length === 0 ? "Loading…" : `${formatCount(runs.length)} reports`}
        />
        <div className="th-alerts-toolbar">
          <div ref={scopeTabsRef} role="tablist" aria-label="Report scope" className="th-tabs">
            {HISTORY_FILTERS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={historyFilter === id}
                onClick={() => {
                  setHistoryFilter(id);
                  setPage(1);
                }}
                className="th-tab"
              >
                {label}
                <span className="th-tab-count">{formatCount(historyCounts[id])}</span>
              </button>
            ))}
          </div>
          <div className="pb-2">
            <label className="th-search th-search-sm w-[260px]">
              <Search className="h-3.5 w-3.5 flex-none" />
              <input
                value={historySearch}
                onChange={(e) => {
                  setHistorySearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search reports"
                aria-label="Search reports"
              />
              {historySearch && (
                <button
                  type="button"
                  onClick={() => setHistorySearch("")}
                  className="th-explorer-clear"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </label>
          </div>
        </div>

        {loading && runs.length === 0 ? (
          <div className="th-alerts-scroll" aria-busy="true" aria-label="Loading reports">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.12 }} />
            ))}
          </div>
        ) : visibleRuns.length === 0 ? (
          <EmptyState
            className="th-fade-in py-10"
            icon={<History className="h-5 w-5" />}
            title={runs.length === 0 ? "No reports yet" : "No reports match these filters"}
            description={runs.length === 0 ? "Generate the first report to begin the history." : undefined}
            action={
              runs.length > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setHistoryFilter("all");
                    setHistorySearch("");
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="th-alerts-scroll th-table-scroll">
            <table className="th-alerts-table" data-mobile="cards">
              <colgroup>
                <col />
                <col className="w-[110px]" />
                <col className="w-[130px]" />
                <col className="w-[80px]" />
                <col className="w-[200px]" />
                <col className="w-[96px]" />
                <col className="w-[96px]" />
              </colgroup>
              <thead>
                <tr>
                  <th>Report</th>
                  <th>Scope</th>
                  <th>Status</th>
                  <th>Format</th>
                  <th>Generated</th>
                  <th className="text-right">Size</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedRuns.map((run, index) => {
                  const status = RUN_STATUS[run.status];
                  const subject = run.device_name || run.client_name;
                  return (
                    <tr
                      key={run.id}
                      className="th-alerts-row"
                      style={
                        {
                          "--row": index,
                          "--row-tone": run.status === "failed" ? TONE.critical : undefined,
                        } as CSSProperties
                      }
                    >
                      <td>
                        <span className="th-alerts-primary">{subject}</span>
                        <span
                          className="th-alerts-secondary"
                          style={run.error_message ? { color: "var(--th-status-critical)" } : undefined}
                          title={run.error_message ?? undefined}
                        >
                          {run.error_message || (
                            <>
                              <span>{reportLabel(run.report_type)}</span> ·{" "}
                              {formatPeriod(run.period_start, run.period_end)}
                            </>
                          )}
                        </span>
                      </td>
                      <td>
                        <span className="th-status-chip">
                          {run.scope_type === "device" ? (
                            <Monitor className="h-3.5 w-3.5" />
                          ) : (
                            <Building2 className="h-3.5 w-3.5" />
                          )}
                          {run.scope_type === "device" ? "Device" : "Client"}
                        </span>
                      </td>
                      <td>
                        <span className="th-status-chip" style={{ "--chip-tone": status.tone } as CSSProperties}>
                          <i />
                          {status.label}
                        </span>
                      </td>
                      <td>
                        <span className="th-alerts-primary font-mono !text-[12px]">
                          {run.report_format.toUpperCase()}
                        </span>
                      </td>
                      <td>
                        <span className="th-alerts-primary tabular-nums">
                          {formatDate(run.completed_at || run.created_at)}
                        </span>
                        <span className="th-alerts-secondary">
                          {run.generated_by}
                          {run.schedule_id ? " · scheduled" : ""}
                        </span>
                      </td>
                      <td className="text-right">
                        <span className="th-alerts-primary tabular-nums">{formatBytes(run.size_bytes)}</span>
                      </td>
                      <td>
                        <div className="th-onb-actions">
                          {run.status === "completed" && (
                            <button
                              type="button"
                              className="th-onb-action"
                              title={`Download ${subject}`}
                              aria-label="Download"
                              onClick={() =>
                                void downloadReport(run).catch((err) =>
                                  setError(err instanceof Error ? err.message : "Download failed"),
                                )
                              }
                            >
                              <Download className="h-4 w-4" />
                            </button>
                          )}
                          {isAdmin && (
                            <button
                              type="button"
                              className="th-onb-action"
                              data-tone="danger"
                              title="Delete"
                              aria-label={`Delete report ${subject}`}
                              onClick={() => setDeleteRunTarget(run)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {visibleRuns.length > 0 && (
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={visibleRuns.length}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            pageSizeOptions={[25, 50, 100]}
            itemLabel="reports"
          />
        )}
      </div>

      {deleteTarget && (
        <ConfirmationModal
          title="Delete report schedule"
          confirmLabel="Delete schedule"
          loading={busy}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        >
          <p>
            This removes <strong style={{ color: "var(--th-text-primary)" }}>{deleteTarget.name}</strong>. Generated
            report history remains available.
          </p>
        </ConfirmationModal>
      )}

      {deleteRunTarget && (
        <ConfirmationModal
          title="Delete report"
          confirmLabel="Delete report"
          loading={busy}
          onClose={() => setDeleteRunTarget(null)}
          onConfirm={() => void confirmDeleteRun()}
        >
          <p>
            Permanently delete the{" "}
            <strong style={{ color: "var(--th-text-primary)" }}>
              {deleteRunTarget.device_name || deleteRunTarget.client_name}
            </strong>{" "}
            {deleteRunTarget.report_format.toUpperCase()} report from {formatDate(deleteRunTarget.created_at)}? This
            removes the stored file and cannot be undone.{" "}
            {deleteRunTarget.schedule_id ? "Its schedule is not affected." : ""}
          </p>
        </ConfirmationModal>
      )}
    </section>
  );
}
