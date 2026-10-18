import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, CalendarClock, Loader2 } from "lucide-react";

import {
  createReportSchedule,
  updateReportSchedule,
  type ClientReportKey,
  type ReportCadence,
  type ReportCatalogEntry,
  type ReportClient,
  type ReportFormat,
  type ReportSchedule,
  type SchedulePayload,
} from "../../api/reports";
import { Button, Modal, SelectField } from "../ui";
import { orderCatalog } from "./ReportCatalog";

/** What the form opens with: a schedule to edit, or a draft from the report the operator was looking at. */
export interface ScheduleDraft {
  client_id?: number;
  report_type?: ClientReportKey;
  report_format?: ReportFormat;
  period_days?: number;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const PERIODS = [1, 7, 30, 90, 365];
const periodLabel = (days: number) => (days === 1 ? "Last 24 hours" : days === 365 ? "Last year" : `Last ${days} days`);

/** The server's catalog titles, for when the catalog has not loaded. */
export const FALLBACK_TITLES: Record<ClientReportKey, string> = {
  executive: "Executive summary",
  patch_compliance: "Patch compliance",
  lifecycle: "OS lifecycle & hardware",
  availability: "Availability & outages",
  capacity: "Disk capacity",
  access_audit: "Access audit",
  security_posture: "Security posture",
  full: "Full fleet report",
};

interface Props {
  clients: ReportClient[];
  catalog: ReportCatalogEntry[];
  /** Editing this schedule; otherwise a new one from `draft`. */
  schedule?: ReportSchedule | null;
  draft?: ScheduleDraft;
  onClose: () => void;
  onSaved: (schedule: ReportSchedule, created: boolean) => void;
}

export default function ScheduleFormModal({ clients, catalog, schedule, draft = {}, onClose, onSaved }: Props) {
  const editing = Boolean(schedule);
  const [name, setName] = useState(schedule?.name ?? "");
  const [clientId, setClientId] = useState(String(schedule?.client_id ?? draft.client_id ?? clients[0]?.id ?? ""));
  const [reportType, setReportType] = useState<ClientReportKey>(schedule?.report_type ?? draft.report_type ?? "full");
  const [format, setFormat] = useState<ReportFormat>(schedule?.report_format ?? draft.report_format ?? "pdf");
  const [periodDays, setPeriodDays] = useState(schedule?.period_days ?? draft.period_days ?? 30);
  const [cadence, setCadence] = useState<ReportCadence>(schedule?.cadence ?? "monthly");
  const [day, setDay] = useState(
    schedule ? (schedule.cadence === "weekly" ? (schedule.day_of_week ?? 0) : (schedule.day_of_month ?? 1)) : 1,
  );
  const [hour, setHour] = useState(schedule?.hour_local ?? 8);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The catalog's reports, plus whatever this schedule already uses (an older server's "full").
  const reports = useMemo(() => {
    const list = orderCatalog(catalog).map((entry) => ({
      key: entry.key,
      title: entry.title,
      formats: entry.formats,
    }));
    if (!list.some((item) => item.key === reportType))
      list.push({ key: reportType, title: FALLBACK_TITLES[reportType] ?? reportType, formats: ["pdf", "csv"] });
    return list;
  }, [catalog, reportType]);
  const formats = reports.find((item) => item.key === reportType)?.formats ?? ["pdf"];
  const periods = PERIODS.includes(periodDays) ? PERIODS : [...PERIODS, periodDays].sort((a, b) => a - b);
  const clientName = clients.find((c) => String(c.id) === clientId)?.name;
  const reportTitle = reports.find((item) => item.key === reportType)?.title ?? "report";

  const chooseReport = (key: ClientReportKey) => {
    setReportType(key);
    const allowed = reports.find((item) => item.key === key)?.formats ?? ["pdf"];
    if (!allowed.includes(format)) setFormat(allowed[0] ?? "pdf");
  };

  async function save() {
    if (!name.trim() || !clientId) return;
    setSaving(true);
    setError(null);
    const fields: Omit<SchedulePayload, "client_id"> = {
      name: name.trim(),
      report_type: reportType,
      report_format: format,
      cadence,
      period_days: periodDays,
      hour_local: hour,
      day_of_week: cadence === "weekly" ? day : null,
      day_of_month: cadence === "monthly" ? day : null,
    };
    try {
      // A schedule keeps its client: the update API does not take one.
      const saved = schedule
        ? await updateReportSchedule(schedule.id, fields)
        : await createReportSchedule({ ...fields, client_id: Number(clientId) });
      onSaved(saved, !schedule);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save schedule");
      setSaving(false);
    }
  }

  return (
    <Modal
      title={editing ? "Edit schedule" : "New report schedule"}
      subtitle="Generated and stored on a cadence, in Tirana time"
      icon={CalendarClock}
      size="lg"
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || !name.trim() || !clientId}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {editing ? "Save changes" : "Create schedule"}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4 sm:grid-cols-6"
        aria-label="Schedule"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {error && (
          <div
            className="th-onb-note sm:col-span-6"
            style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
            role="alert"
          >
            <AlertTriangle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        )}
        <label className="th-onb-field sm:col-span-6">
          Schedule name
          <input
            value={name}
            maxLength={160}
            onChange={(event) => setName(event.target.value)}
            placeholder={clientName ? `${clientName} · ${reportTitle}` : "e.g. Monthly executive summary"}
            data-autofocus
          />
        </label>
        <label className="th-onb-field sm:col-span-3">
          Client
          <SelectField value={clientId} onChange={(event) => setClientId(event.target.value)} disabled={editing}>
            <option value="">Select client</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </SelectField>
        </label>
        <label className="th-onb-field sm:col-span-3">
          Report
          <SelectField value={reportType} onChange={(event) => chooseReport(event.target.value as ClientReportKey)}>
            {reports.map((item) => (
              <option key={item.key} value={item.key}>
                {item.title}
              </option>
            ))}
          </SelectField>
        </label>
        <label className="th-onb-field sm:col-span-3">
          Period
          <SelectField value={periodDays} onChange={(event) => setPeriodDays(Number(event.target.value))}>
            {periods.map((days) => (
              <option key={days} value={days}>
                {periodLabel(days)}
              </option>
            ))}
          </SelectField>
        </label>
        <label className="th-onb-field sm:col-span-3">
          Format
          <SelectField value={format} onChange={(event) => setFormat(event.target.value as ReportFormat)}>
            <option value="pdf" disabled={!formats.includes("pdf")}>
              PDF
            </option>
            <option value="csv" disabled={!formats.includes("csv")}>
              CSV{formats.includes("csv") ? "" : " (not available for this report)"}
            </option>
          </SelectField>
        </label>
        <label className="th-onb-field sm:col-span-2">
          Cadence
          <SelectField
            value={cadence}
            onChange={(event) => {
              const next = event.target.value as ReportCadence;
              setCadence(next);
              setDay(next === "weekly" ? 0 : 1);
            }}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </SelectField>
        </label>
        <label className="th-onb-field sm:col-span-2">
          {cadence === "weekly" ? "Weekday" : cadence === "monthly" ? "Day of month" : "Day"}
          <SelectField
            value={cadence === "daily" ? "" : day}
            disabled={cadence === "daily"}
            onChange={(event) => setDay(Number(event.target.value))}
          >
            {cadence === "daily" && <option value="">Every day</option>}
            {cadence === "weekly" &&
              WEEKDAYS.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            {cadence === "monthly" &&
              Array.from({ length: 28 }, (_, i) => i + 1).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
          </SelectField>
        </label>
        <label className="th-onb-field sm:col-span-2">
          Time (Tirana)
          <SelectField value={hour} onChange={(event) => setHour(Number(event.target.value))}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {`${String(h).padStart(2, "0")}:00`}
              </option>
            ))}
          </SelectField>
        </label>
      </form>
    </Modal>
  );
}
