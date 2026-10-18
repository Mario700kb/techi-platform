import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CheckCircle2,
  Download,
  FileCheck2,
  FileSpreadsheet,
  History,
  LayoutGrid,
  Loader2,
  Monitor,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";

import {
  deleteReportRun,
  deleteReportSchedule,
  downloadReport,
  generateReport,
  getReportCatalog,
  getReportClients,
  getReportRuns,
  getReportSchedules,
  ReportCatalogEntry,
  ReportClient,
  ReportFormat,
  ReportRun,
  ReportSchedule,
  ReportStatus,
  updateReportSchedule,
} from "../api/reports";
import type { DeviceReportType, ReportScope, ReportType } from "../api/reports";
import { Device, getDevices } from "../api/devices";
import { useAuth } from "../auth/AuthContext";
import ConfirmationModal from "../components/ConfirmationModal";
import Button from "../components/ui/Button";
import PageHeader from "../components/ui/PageHeader";
import TablePagination from "../components/ui/TablePagination";
import { CardHead } from "../components/ui/PanelCard";
import { EmptyState, SelectField, DatePicker } from "../components/ui";
import ClientReportsPanel, { type Notice } from "../components/reports/ClientReportsPanel";
import ScheduleFormModal, { FALLBACK_TITLES, type ScheduleDraft } from "../components/reports/ScheduleFormModal";
import { formatPeriod, toReportPeriod } from "../components/reports/reportFormat";
import "../components/reports/reports.css";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { useTabIndicator } from "../hooks/useTabIndicator";
import { TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { formatLocalDateTime } from "../utils/time";

const DEVICE_REPORT_TYPES: { value: DeviceReportType; label: string }[] = [
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

/** A run's or schedule's report: device categories by their label, client reports by the catalog's title. */
function reportLabel(
  type: ReportType | undefined,
  catalog: ReportCatalogEntry[],
  scope: ReportScope = "client",
): string {
  const key = type ?? "full";
  if (scope === "device") return DEVICE_REPORT_TYPES.find((item) => item.value === key)?.label ?? key;
  return (
    catalog.find((entry) => entry.key === key)?.title ??
    FALLBACK_TITLES[key as keyof typeof FALLBACK_TITLES] ??
    DEVICE_REPORT_TYPES.find((item) => item.value === key)?.label ??
    key
  );
}

function formatDate(value?: string | null) {
  return value ? formatLocalDateTime(value) : "—";
}

function formatBytes(value?: number | null) {
  if (!value) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function cadenceLabel(schedule: ReportSchedule): string {
  const time = `${String(schedule.hour_local).padStart(2, "0")}:00`;
  if (schedule.cadence === "daily") return `Daily · ${time}`;
  if (schedule.cadence === "weekly") return `Weekly · ${WEEKDAYS_SHORT[schedule.day_of_week ?? 0] ?? "Mon"} ${time}`;
  return `Monthly · day ${schedule.day_of_month ?? 1} · ${time}`;
}

const RUN_STATUS: Record<ReportStatus, { label: string; tone: string }> = {
  completed: { label: "Completed", tone: TONE.online },
  pending: { label: "Running", tone: TONE.info },
  failed: { label: "Failed", tone: TONE.critical },
};

type HistoryFilter = "all" | ReportScope;
type Tab = "client" | "device" | "runs" | "schedules";

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
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab") as Tab | null;
  const tab: Tab =
    requestedTab && ["client", "device", "runs", "schedules"].includes(requestedTab)
      ? requestedTab === "schedules" && !isAdmin
        ? "client"
        : requestedTab
      : "client";
  const [opened, setOpened] = useState<ReadonlySet<Tab>>(() => new Set<Tab>([tab]));
  const [manualRefresh, setManualRefresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [deviceQuery, setDeviceQuery] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [reportType, setReportType] = useState<DeviceReportType>("full");
  const [reportFormat, setReportFormat] = useState<ReportFormat>("pdf");
  const [periodChoice, setPeriodChoice] = useState("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [scheduleForm, setScheduleForm] = useState<{ schedule?: ReportSchedule; draft?: ScheduleDraft } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ReportSchedule | null>(null);
  const [deleteRunTarget, setDeleteRunTarget] = useState<ReportRun | null>(null);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [historySearch, setHistorySearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const tabsRef = useTabIndicator<HTMLDivElement>(tab);
  const scopeTabsRef = useTabIndicator<HTMLDivElement>(historyFilter);

  const openTab = (next: Tab) => {
    setOpened((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === "client") params.delete("tab");
        else params.set("tab", next);
        return params;
      },
      { replace: true },
    );
  };
  useEffect(() => {
    setOpened((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  const reports = useCachedQuery<ReportsView>(`page.reports:${isAdmin ? "admin" : "operator"}`, async () => {
    const [clientRows, runRows, scheduleRows] = await Promise.all([
      getReportClients(),
      getReportRuns(),
      isAdmin ? getReportSchedules() : Promise.resolve([]),
    ]);
    return { clients: clientRows, runs: runRows.items, schedules: scheduleRows };
  });
  const catalogQuery = useCachedQuery<ReportCatalogEntry[]>("page.reports.catalog", getReportCatalog);
  const catalog = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);
  const { data, reload, setData } = reports;
  const { clients, runs, schedules } = data ?? EMPTY_REPORTS;
  const loading = reports.loading || manualRefresh;
  const updateView = (change: (view: ReportsView) => ReportsView) => setData((prev) => prev && change(prev));

  useEffect(() => {
    if (!reports.refreshing && reports.error) setError(reports.error);
  }, [reports.refreshing, reports.error]);

  const refresh = () => {
    setError(null);
    setManualRefresh(true);
    void Promise.all([reload(), catalogQuery.reload()]).finally(() => setManualRefresh(false));
  };

  const notify = ({ error: err, success: ok }: Notice) => {
    setError(err ?? null);
    setSuccess(ok ?? null);
  };

  const deviceTabOpened = opened.has("device");
  useEffect(() => {
    if (!deviceTabOpened) return;
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
  }, [deviceTabOpened, deviceQuery]);

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
      return [
        run.client_name,
        run.device_name ?? "",
        run.generated_by,
        reportLabel(run.report_type, catalog, run.scope_type),
      ].some((v) => v.toLowerCase().includes(q));
    });
  }, [runs, historyFilter, historySearch, catalog]);
  const pagedRuns = useMemo(
    () => visibleRuns.slice((page - 1) * pageSize, page * pageSize),
    [visibleRuns, page, pageSize],
  );
  const deviceRuns = useMemo(() => runs.filter((run) => run.scope_type === "device").slice(0, 6), [runs]);

  const addRun = (run: ReportRun) => updateView((view) => ({ ...view, runs: [run, ...view.runs] }));
  const download = (run: ReportRun) =>
    void downloadReport(run).catch((err) => setError(err instanceof Error ? err.message : "Download failed"));

  async function handleGenerateDevice() {
    if (!deviceId) return;
    const range = toReportPeriod(periodChoice, customFrom, customTo);
    if (!range) {
      setError("Select a valid custom date range.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const run = await generateReport({
        scope_type: "device",
        device_id: Number(deviceId),
        report_type: reportType,
        report_format: reportFormat,
        ...range,
      });
      addRun(run);
      setSuccess(`${run.device_name || run.client_name} ${run.report_format.toUpperCase()} report is ready.`);
      await downloadReport(run);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Report generation failed");
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

  const tabs: { key: Tab; label: string; icon: typeof History; count?: number }[] = [
    { key: "client", label: "Client reports", icon: LayoutGrid, count: catalog.length || undefined },
    { key: "device", label: "Device reports", icon: Monitor },
    { key: "runs", label: "Runs", icon: History, count: runs.length },
    ...(isAdmin
      ? [{ key: "schedules" as const, label: "Schedules", icon: CalendarClock, count: schedules.length }]
      : []),
  ];

  return (
    <section className="premium-page th-onb th-rpt-page space-y-4">
      <PageHeader
        title="Reports"
        description="Client and device reports: preview on screen, download, or schedule."
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
            hint: stats.failed ? "See the Runs tab" : "Nothing failed",
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

      {/* ── sections ────────────────────────────────────────────────────── */}
      <div className="th-onb-card th-rpt-tabs-card th-onb-enter" style={{ "--i": 3 } as CSSProperties}>
        <div className="th-alerts-toolbar !border-b-0">
          <div
            ref={tabsRef}
            role="tablist"
            aria-label="Report sections"
            className="th-tabs !flex-nowrap overflow-x-auto"
            style={{ scrollbarWidth: "none" }}
          >
            {tabs.map((t) => (
              <button
                key={t.key}
                id={`rpt-tab-${t.key}`}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                aria-controls={`rpt-panel-${t.key}`}
                onClick={() => openTab(t.key)}
                className="th-tab whitespace-nowrap"
              >
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
                {t.count !== undefined && <span className="th-tab-count">{formatCount(t.count)}</span>}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── client reports ── */}
      {opened.has("client") && (
        <div
          role="tabpanel"
          id="rpt-panel-client"
          aria-labelledby="rpt-tab-client"
          hidden={tab !== "client"}
          className="th-onb-panel"
        >
          <ClientReportsPanel
            clients={clients}
            catalog={catalog}
            catalogLoading={catalogQuery.loading}
            catalogError={catalogQuery.error}
            onRetryCatalog={() => void catalogQuery.reload()}
            canSchedule={isAdmin}
            onRunCreated={addRun}
            onNotice={notify}
            onSchedule={(draft) => setScheduleForm({ draft })}
          />
        </div>
      )}

      {/* ── device reports ── */}
      {opened.has("device") && (
        <div
          role="tabpanel"
          id="rpt-panel-device"
          aria-labelledby="rpt-tab-device"
          hidden={tab !== "device"}
          className="th-onb-panel"
        >
          <div className="grid items-stretch gap-4 xl:grid-cols-2">
            <div className="th-onb-card th-onb-enter" style={{ "--i": 0 } as CSSProperties}>
              <CardHead
                icon={FileSpreadsheet}
                tone="var(--th-accent)"
                title="Device report"
                subtitle="One device, one category or the full report"
              />
              <div className="th-onb-body flex-1">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="th-onb-field">
                    Find device
                    <input
                      value={deviceQuery}
                      onChange={(event) => setDeviceQuery(event.target.value)}
                      placeholder="Search name or IP"
                    />
                  </label>
                  <div className="th-onb-field">
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
                  <label className="th-onb-field">
                    Report type
                    <SelectField
                      value={reportType}
                      onChange={(event) => {
                        const next = event.target.value as DeviceReportType;
                        setReportType(next);
                        if (next === "full") setReportFormat("pdf");
                      }}
                    >
                      {DEVICE_REPORT_TYPES.map((item) => (
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
                      <option value="csv" disabled={reportType === "full"}>
                        CSV
                        {reportType === "full" ? " (not available for Full Device Report)" : ""}
                      </option>
                    </SelectField>
                  </label>
                  <label className="th-onb-field sm:col-span-2">
                    Period
                    <SelectField value={periodChoice} onChange={(event) => setPeriodChoice(event.target.value)}>
                      <option value="1">Last 24 hours</option>
                      <option value="7">Last 7 days</option>
                      <option value="30">Last 30 days</option>
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
                <p className="th-onb-hint">
                  Full Device Report is PDF only, because its sections have different columns. Category reports support
                  PDF and CSV. Historical sections show the records still retained; software and overview are current
                  snapshots.
                </p>
              </div>
              <div className="th-onb-foot">
                <Button
                  className="w-full"
                  onClick={() => void handleGenerateDevice()}
                  disabled={busy || !deviceId || (reportType === "full" && reportFormat === "csv")}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  Generate
                </Button>
              </div>
            </div>

            <div className="th-onb-card th-onb-enter" style={{ "--i": 1 } as CSSProperties}>
              <CardHead
                icon={History}
                tone="var(--th-accent)"
                title="Recent device reports"
                subtitle="The latest six; all of them are under Runs"
              />
              <div className="th-onb-body flex-1">
                {deviceRuns.length === 0 ? (
                  <div className="th-onb-empty !p-0">
                    <EmptyState
                      icon={<Monitor className="h-5 w-5" />}
                      title="No device reports yet"
                      description="Generated device reports appear here."
                    />
                  </div>
                ) : (
                  <ul className="th-onb-list">
                    {deviceRuns.map((run, index) => (
                      <li key={run.id} className="th-alerts-row" style={{ "--row": index } as CSSProperties}>
                        <div className="min-w-0 flex-1">
                          <span className="th-alerts-primary">{run.device_name || run.client_name}</span>
                          <span className="th-alerts-secondary">
                            {reportLabel(run.report_type, catalog, run.scope_type)} · {run.report_format.toUpperCase()}{" "}
                            · {formatDate(run.completed_at || run.created_at)}
                          </span>
                        </div>
                        <div className="th-onb-actions">
                          {run.status === "completed" ? (
                            <button
                              type="button"
                              className="th-onb-action"
                              title="Download"
                              aria-label={`Download ${run.device_name || run.client_name}`}
                              onClick={() => download(run)}
                            >
                              <Download className="h-4 w-4" />
                            </button>
                          ) : (
                            <span
                              className="th-status-chip"
                              style={{ "--chip-tone": RUN_STATUS[run.status].tone } as CSSProperties}
                            >
                              <i />
                              {RUN_STATUS[run.status].label}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="th-onb-foot">
                <Button variant="secondary" className="w-full" onClick={() => openTab("runs")}>
                  <History className="h-4 w-4" />
                  All runs
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── runs ── */}
      {opened.has("runs") && (
        <div
          role="tabpanel"
          id="rpt-panel-runs"
          aria-labelledby="rpt-tab-runs"
          hidden={tab !== "runs"}
          className="th-onb-panel"
        >
          <div className="th-alerts-card th-onb-tokens th-onb-enter">
            <CardHead
              icon={History}
              tone="var(--th-accent)"
              title="Report runs"
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
                <label className="th-search th-search-sm w-[260px] max-w-full">
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
                                  <span>{reportLabel(run.report_type, catalog, run.scope_type)}</span> ·{" "}
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
                                  onClick={() => download(run)}
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
        </div>
      )}

      {/* ── schedules ── */}
      {isAdmin && opened.has("schedules") && (
        <div
          role="tabpanel"
          id="rpt-panel-schedules"
          aria-labelledby="rpt-tab-schedules"
          hidden={tab !== "schedules"}
          className="th-onb-panel"
        >
          <div className="th-alerts-card th-onb-tokens th-onb-enter">
            <CardHead
              icon={CalendarClock}
              tone="var(--th-accent)"
              title="Report schedules"
              subtitle="Client reports, generated and stored on a cadence"
              aside={
                <Button size="sm" onClick={() => setScheduleForm({ draft: {} })}>
                  <Plus className="h-3.5 w-3.5" />
                  New schedule
                </Button>
              }
            />
            {schedules.length === 0 ? (
              <EmptyState
                className="th-fade-in py-10"
                icon={<CalendarClock className="h-5 w-5" />}
                title="No scheduled reports"
                description="Schedule a client report to arrive daily, weekly or monthly."
                action={
                  <Button size="sm" variant="secondary" onClick={() => setScheduleForm({ draft: {} })}>
                    <Plus className="h-3.5 w-3.5" />
                    New schedule
                  </Button>
                }
              />
            ) : (
              <div className="th-alerts-scroll th-table-scroll">
                <table className="th-alerts-table" data-mobile="cards" aria-label="Report schedules">
                  <colgroup>
                    <col />
                    <col className="w-[200px]" />
                    <col className="w-[210px]" />
                    <col className="w-[150px]" />
                    <col className="w-[110px]" />
                    <col className="w-[132px]" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Schedule</th>
                      <th>Report</th>
                      <th>Cadence</th>
                      <th>Next run</th>
                      <th>Status</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedules.map((schedule, index) => (
                      <tr key={schedule.id} className="th-alerts-row" style={{ "--row": index } as CSSProperties}>
                        <td>
                          <span className="th-alerts-primary">{schedule.name}</span>
                          <span className="th-alerts-secondary">{schedule.client_name}</span>
                        </td>
                        <td>
                          <span className="th-alerts-primary" data-testid="schedule-report">
                            {reportLabel(schedule.report_type, catalog)}
                          </span>
                          <span className="th-alerts-secondary">
                            {schedule.report_format.toUpperCase()} · last {formatCount(schedule.period_days)}{" "}
                            {schedule.period_days === 1 ? "day" : "days"}
                          </span>
                        </td>
                        <td>
                          <span className="th-alerts-primary">{cadenceLabel(schedule)}</span>
                        </td>
                        <td>
                          <span className="th-alerts-primary tabular-nums">{formatDate(schedule.next_run_at)}</span>
                          <span className="th-alerts-secondary">
                            {schedule.last_run_at ? `last ${formatDate(schedule.last_run_at)}` : "not run yet"}
                          </span>
                        </td>
                        <td>
                          <span
                            className="th-status-chip"
                            style={{ "--chip-tone": schedule.enabled ? TONE.online : TONE.neutral } as CSSProperties}
                          >
                            <i />
                            {schedule.enabled ? "Active" : "Paused"}
                          </span>
                        </td>
                        <td>
                          <div className="th-onb-actions">
                            <button
                              type="button"
                              className="th-onb-action"
                              onClick={() => setScheduleForm({ schedule })}
                              title="Edit"
                              aria-label={`Edit ${schedule.name}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
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
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {scheduleForm && (
        <ScheduleFormModal
          clients={clients}
          catalog={catalog}
          schedule={scheduleForm.schedule}
          draft={scheduleForm.draft}
          onClose={() => setScheduleForm(null)}
          onSaved={(saved, created) => {
            updateView((view) => ({
              ...view,
              schedules: created
                ? [...view.schedules, saved]
                : view.schedules.map((item) => (item.id === saved.id ? saved : item)),
            }));
            setScheduleForm(null);
            setError(null);
            setSuccess(created ? `Schedule “${saved.name}” created.` : `Schedule “${saved.name}” saved.`);
            if (created) openTab("schedules");
          }}
        />
      )}

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
