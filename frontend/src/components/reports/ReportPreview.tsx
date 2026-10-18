import type { CSSProperties, KeyboardEvent } from "react";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";

import type { ReportColumn, ReportDocument, ReportRow, ReportSection, ReportSummaryItem } from "../../api/reports";
import { formatCount } from "../../utils/number";
import { formatDateTime } from "../../utils/time";
import Button from "../ui/Button";
import {
  columnWidth,
  formatCell,
  formatPeriod,
  formatSummaryValue,
  isRightAligned,
  tableMinWidth,
  toneVar,
} from "./reportFormat";

/** Tiles per row on wide screens: one row up to five, then even rows. */
export function kpiColumns(count: number): number {
  if (count <= 5) return Math.max(count, 1);
  if (count % 3 === 0) return 3;
  return 4;
}

function KpiTiles({ items }: { items: ReportSummaryItem[] }) {
  if (items.length === 0) return null;
  return (
    <div
      className="th-rpt-kpis"
      data-odd={items.length % 2 === 1 || undefined}
      style={{ "--kpi-cols": kpiColumns(items.length) } as CSSProperties}
    >
      {items.map((item, index) => {
        const value = formatSummaryValue(item.value, item.kind);
        const tone = item.tone ?? "neutral";
        return (
          <div
            key={`${item.label}-${index}`}
            className="th-rpt-kpi"
            data-tone={tone}
            style={{ "--kpi-tone": toneVar(tone) } as CSSProperties}
          >
            <span className="th-rpt-kpi-label" title={item.label}>
              <i aria-hidden="true" />
              {item.label}
            </span>
            {/* A worded value ("needs agent 2.1.31") is set smaller, in the same line height. */}
            <span className="th-rpt-kpi-value" data-text={value.length > 9 || undefined} title={value}>
              {value}
            </span>
            <span className="th-rpt-kpi-hint" title={item.hint ?? undefined}>
              {item.hint || " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function rowKeys(open: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      open();
    }
  };
}

function Cell({ column, row }: { column: ReportColumn; row: ReportRow }) {
  const text = formatCell(row[column.key], column.kind);
  if (column.kind === "badge") {
    if (text === "—") return <span className="th-rpt-muted">—</span>;
    return (
      <span
        className="th-status-chip th-rpt-badge"
        style={{ "--chip-tone": toneVar(row._tone) } as CSSProperties}
        title={text}
      >
        <i />
        <span className="truncate">{text}</span>
      </span>
    );
  }
  return <span className={text === "—" ? "th-rpt-muted" : undefined}>{text}</span>;
}

/** Words that name a row for a screen reader: its first text cell. */
function rowName(section: ReportSection, row: ReportRow): string {
  const first = section.columns.find((c) => c.kind === "text") ?? section.columns[0];
  return first ? formatCell(row[first.key], first.kind) : "device";
}

function SectionTable({
  section,
  index,
  onOpenDevice,
}: {
  section: ReportSection;
  index: number;
  onOpenDevice: (deviceId: number) => void;
}) {
  const headingId = `rpt-section-${section.key}-${index}`;
  return (
    <section className="th-rpt-section" aria-labelledby={headingId} data-section={section.key}>
      <header className="th-rpt-section-head">
        <div className="min-w-0">
          <h3 id={headingId}>{section.title}</h3>
          {section.description && <p>{section.description}</p>}
        </div>
        {section.rows.length > 0 && (
          <span className="th-tab-count th-rpt-count">
            {formatCount(section.rows.length)} {section.rows.length === 1 ? "row" : "rows"}
          </span>
        )}
      </header>
      {section.rows.length === 0 ? (
        <p className="th-rpt-empty">{section.empty || "Nothing to report for this period."}</p>
      ) : (
        <div className="th-rpt-table-wrap">
          <table
            className="th-alerts-table th-rpt-table"
            style={{ minWidth: tableMinWidth(section.columns, section.rows) }}
          >
            <colgroup>
              {section.columns.map((column) => {
                const width = columnWidth(column, section.rows);
                return <col key={column.key} style={width ? { width } : undefined} />;
              })}
            </colgroup>
            <thead>
              <tr>
                {section.columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={isRightAligned(column) ? "text-right" : undefined}
                    data-kind={column.kind}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row, rowIndex) => {
                const deviceId = typeof row._device_id === "number" ? row._device_id : null;
                const open = deviceId === null ? undefined : () => onOpenDevice(deviceId);
                return (
                  <tr
                    key={rowIndex}
                    className="th-alerts-row"
                    data-tone={row._tone ?? undefined}
                    data-clickable={open ? "true" : undefined}
                    {...(open
                      ? {
                          tabIndex: 0,
                          "aria-label": `Open ${rowName(section, row)}`,
                          onClick: open,
                          onKeyDown: rowKeys(open),
                        }
                      : {})}
                  >
                    {section.columns.map((column) => (
                      <td
                        key={column.key}
                        className={isRightAligned(column) ? "text-right" : undefined}
                        data-kind={column.kind}
                      >
                        <Cell column={column} row={row} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {section.note && (
        <p className="th-rpt-note">
          <Info className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          <span>{section.note}</span>
        </p>
      )}
    </section>
  );
}

export function ReportPreviewSkeleton() {
  return (
    <div className="th-rpt-doc" aria-busy="true" aria-label="Loading preview">
      <div className="th-rpt-doc-head">
        <div className="flex-1 space-y-2">
          <span className="th-rpt-shimmer block h-5 w-56 rounded" />
          <span className="th-rpt-shimmer block h-3.5 w-80 max-w-full rounded" />
        </div>
      </div>
      <div className="th-rpt-kpis" style={{ "--kpi-cols": 4 } as CSSProperties}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="th-rpt-kpi">
            <span className="th-rpt-shimmer block h-3 w-24 rounded" />
            <span className="th-rpt-shimmer mt-2 block h-7 w-16 rounded" />
            <span className="th-rpt-shimmer mt-2 block h-3 w-32 max-w-full rounded" />
          </div>
        ))}
      </div>
      <div className="th-rpt-section">
        <span className="th-rpt-shimmer block h-4 w-40 rounded" />
        <div className="th-rpt-table-wrap mt-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.15 }} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function ReportPreviewError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="th-rpt-doc">
      <div
        className="th-onb-note"
        style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
        role="alert"
        data-testid="preview-error"
      >
        <AlertTriangle className="h-4 w-4" />
        <span className="flex-1">The preview could not be built. {message}</span>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    </div>
  );
}

export default function ReportPreview({
  document: doc,
  onOpenDevice,
}: {
  document: ReportDocument;
  onOpenDevice: (deviceId: number) => void;
}) {
  return (
    <article className="th-rpt-doc" aria-label={`${doc.title} preview`} data-report={doc.key}>
      <header className="th-rpt-doc-head">
        <div className="min-w-0 flex-1">
          <p className="th-rpt-eyebrow">{doc.client_name}</p>
          <h2 className="th-rpt-doc-title">{doc.title}</h2>
          {doc.subtitle && <p className="th-rpt-doc-sub">{doc.subtitle}</p>}
        </div>
        <dl className="th-rpt-doc-meta">
          <div>
            <dt>Period</dt>
            <dd>{formatPeriod(doc.period_start, doc.period_end, true)}</dd>
          </div>
          <div>
            <dt>Generated</dt>
            <dd>{formatDateTime(doc.generated_at)}</dd>
          </div>
        </dl>
      </header>

      <KpiTiles items={doc.summary} />

      {doc.sections.map((section, index) => (
        <SectionTable key={`${section.key}-${index}`} section={section} index={index} onOpenDevice={onOpenDevice} />
      ))}

      {doc.notes.length > 0 && (
        <footer className="th-rpt-notes">
          <h3>Notes</h3>
          <ul>
            {doc.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </footer>
      )}
    </article>
  );
}
