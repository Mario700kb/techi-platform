import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, CalendarClock, Download, FileDown, Info, LayoutGrid, Loader2, Printer } from "lucide-react";

import {
  downloadReport,
  generateReport,
  getReportPreview,
  type ClientReportKey,
  type ReportCatalogEntry,
  type ReportClient,
  type ReportDocument,
  type ReportFormat,
  type ReportRun,
} from "../../api/reports";
import { useCachedQuery } from "../../hooks/useCachedQuery";
import { Button, DatePicker, EmptyState, SelectField } from "../ui";
import { CardHead } from "../ui/PanelCard";
import ReportCatalog, { hasPreview, needsLabel, orderCatalog } from "./ReportCatalog";
import ReportPreview, { ReportPreviewError, ReportPreviewSkeleton } from "./ReportPreview";
import { PERIOD_CHOICES, toReportPeriod, type PeriodChoice } from "./reportFormat";
import type { ScheduleDraft } from "./ScheduleFormModal";

export interface Notice {
  error?: string;
  success?: string;
}

interface Props {
  clients: ReportClient[];
  catalog: ReportCatalogEntry[];
  catalogLoading: boolean;
  catalogError: string | null;
  onRetryCatalog: () => void;
  canSchedule: boolean;
  onRunCreated: (run: ReportRun) => void;
  onNotice: (notice: Notice) => void;
  onSchedule: (draft: ScheduleDraft) => void;
}

export default function ClientReportsPanel({
  clients,
  catalog,
  catalogLoading,
  catalogError,
  onRetryCatalog,
  canSchedule,
  onRunCreated,
  onNotice,
  onSchedule,
}: Props) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<ClientReportKey | null>(null);
  const [clientId, setClientId] = useState("");
  const [periodChoice, setPeriodChoice] = useState<PeriodChoice>("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [downloading, setDownloading] = useState<ReportFormat | null>(null);

  const ordered = useMemo(() => orderCatalog(catalog), [catalog]);
  useEffect(() => {
    setSelected((current) => (current && ordered.some((e) => e.key === current) ? current : (ordered[0]?.key ?? null)));
  }, [ordered]);
  useEffect(() => {
    setClientId((current) => current || (clients[0] ? String(clients[0].id) : ""));
  }, [clients]);

  const entry = ordered.find((e) => e.key === selected) ?? null;
  const client = clients.find((c) => String(c.id) === clientId) ?? null;
  const period = useMemo(
    () => toReportPeriod(periodChoice, customFrom, customTo),
    [periodChoice, customFrom, customTo],
  );
  const periodKey = period ? ("period_days" in period ? `${period.period_days}d` : `${customFrom}~${customTo}`) : null;

  // Reports without a preview ("full") are never asked for one: the server answers 422.
  const previewable = entry ? hasPreview(entry) : false;
  const previewKey =
    entry && previewable && client && period ? `mem.reports.preview:${client.id}:${entry.key}:${periodKey}` : null;
  const preview = useCachedQuery<ReportDocument>(previewKey, () => getReportPreview(client!.id, entry!.key, period!));

  async function download(format: ReportFormat) {
    if (!entry || !client || !period) return;
    setDownloading(format);
    try {
      const run = await generateReport({
        scope_type: "client",
        client_id: client.id,
        report_type: entry.key,
        report_format: format,
        ...period,
      });
      onRunCreated(run);
      if (run.status === "failed") throw new Error(run.error_message || "Report generation failed");
      await downloadReport(run);
      onNotice({ success: `${entry.title} ${format.toUpperCase()} for ${client.name} is ready.` });
    } catch (err) {
      onNotice({ error: err instanceof Error ? err.message : "Report generation failed" });
    } finally {
      setDownloading(null);
    }
  }

  const periodIndex = PERIOD_CHOICES.findIndex((p) => p.value === periodChoice);
  const customInvalid = periodChoice === "custom" && !period;
  const ready = Boolean(entry && client && period);

  return (
    <div className="space-y-4">
      <div className="th-onb-card th-onb-enter" style={{ "--i": 0 } as CSSProperties}>
        <CardHead
          icon={LayoutGrid}
          tone="var(--th-accent)"
          title="Client reports"
          subtitle="Pick a report to preview it, then download or schedule it"
        />
        <div className="th-onb-body">
          <ReportCatalog
            entries={catalog}
            selected={selected}
            onSelect={setSelected}
            loading={catalogLoading}
            error={catalogError}
            onRetry={onRetryCatalog}
          />
        </div>
      </div>

      <div className="th-onb-card th-rpt-preview-card th-onb-enter" style={{ "--i": 1 } as CSSProperties}>
        <div className="th-rpt-toolbar" role="toolbar" aria-label="Report options">
          <div className="th-rpt-controls">
            <label className="th-onb-field th-rpt-client">
              Client
              <SelectField value={clientId} onChange={(event) => setClientId(event.target.value)}>
                <option value="">Select client</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </SelectField>
            </label>
            <div className="th-onb-field">
              <span id="rpt-period-label">Period</span>
              <div
                className="th-segmented th-rpt-period"
                role="radiogroup"
                aria-labelledby="rpt-period-label"
                data-thumb
                style={{ "--seg-n": PERIOD_CHOICES.length, "--seg-i": periodIndex } as CSSProperties}
              >
                {PERIOD_CHOICES.map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    role="radio"
                    aria-checked={choice.value === periodChoice}
                    onClick={() => setPeriodChoice(choice.value)}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            </div>
            {periodChoice === "custom" && (
              <>
                <label className="th-onb-field th-onb-reveal th-rpt-date">
                  From
                  <DatePicker value={customFrom} onChange={setCustomFrom} max={customTo || undefined} />
                </label>
                <label className="th-onb-field th-onb-reveal th-rpt-date">
                  To (inclusive)
                  <DatePicker value={customTo} onChange={setCustomTo} min={customFrom || undefined} />
                </label>
              </>
            )}
          </div>
          <div className="th-rpt-actions">
            <Button
              variant="ghost"
              size="sm"
              className="th-rpt-print"
              onClick={() => window.print()}
              disabled={!preview.data}
              title="Print the preview"
              aria-label="Print preview"
            >
              <Printer className="h-3.5 w-3.5" />
            </Button>
            {canSchedule && (
              <Button
                variant="secondary"
                size="sm"
                disabled={!entry}
                onClick={() =>
                  entry &&
                  onSchedule({
                    client_id: client?.id,
                    report_type: entry.key,
                    report_format: entry.formats.includes("pdf") ? "pdf" : (entry.formats[0] ?? "pdf"),
                    period_days: period && "period_days" in period ? period.period_days : 30,
                  })
                }
              >
                <CalendarClock className="h-3.5 w-3.5" />
                Schedule…
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={!ready || downloading !== null || !entry?.formats.includes("csv")}
              title={entry && !entry.formats.includes("csv") ? "CSV is not available for this report" : undefined}
              onClick={() => void download("csv")}
            >
              {downloading === "csv" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Download CSV
            </Button>
            <Button
              size="sm"
              disabled={!ready || downloading !== null || !entry?.formats.includes("pdf")}
              onClick={() => void download("pdf")}
            >
              {downloading === "pdf" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Download PDF
            </Button>
          </div>
        </div>

        {entry?.needs && (
          <div className="th-rpt-banner">
            <Info className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
            <span>{needsLabel(entry.needs)}. Devices that do not have it yet show no data in this report.</span>
          </div>
        )}

        <div className="th-rpt-doc-wrap" aria-live="polite">
          {!client ? (
            <EmptyState
              className="py-12"
              icon={<Building2 className="h-5 w-5" />}
              title="Select a client"
              description="The preview shows the report for one client."
            />
          ) : customInvalid ? (
            <EmptyState
              className="py-12"
              icon={<CalendarClock className="h-5 w-5" />}
              title="Choose the dates"
              description="Pick the first and last day of the period to preview it."
            />
          ) : !entry ? (
            catalogLoading ? (
              <ReportPreviewSkeleton />
            ) : (
              <EmptyState
                className="py-12"
                icon={<LayoutGrid className="h-5 w-5" />}
                title="Pick a report"
                description="Choose a report from the catalog above."
              />
            )
          ) : !previewable ? (
            <EmptyState
              className="py-12"
              icon={<FileDown className="h-5 w-5" />}
              title={`${entry.title} has no on-screen preview`}
              description={`It renders only to a file: use Download ${entry.formats
                .map((f) => f.toUpperCase())
                .join(" or ")} above.`}
            />
          ) : preview.data ? (
            <div className={preview.refreshing ? "th-rpt-refreshing" : undefined}>
              <ReportPreview document={preview.data} onOpenDevice={(id) => navigate(`/devices?device=${id}`)} />
            </div>
          ) : preview.error ? (
            <ReportPreviewError message={preview.error} onRetry={() => void preview.reload()} />
          ) : (
            <ReportPreviewSkeleton />
          )}
        </div>
      </div>
    </div>
  );
}
