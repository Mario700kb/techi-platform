import type { CSSProperties } from "react";
import {
  Activity,
  AlertTriangle,
  Briefcase,
  Check,
  FileText,
  Files,
  Gauge,
  Hourglass,
  KeyRound,
  PackageCheck,
  RefreshCw,
  ShieldHalf,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { ClientReportKey, ReportCatalogEntry } from "../../api/reports";
import Button from "../ui/Button";

const ICONS: Record<ClientReportKey, LucideIcon> = {
  executive: Briefcase,
  patch_compliance: PackageCheck,
  lifecycle: Hourglass,
  availability: Activity,
  capacity: Gauge,
  access_audit: KeyRound,
  security_posture: ShieldHalf,
  full: Files,
};

export const reportIcon = (key: string): LucideIcon => ICONS[key as ClientReportKey] ?? FileText;

/** Executive first (the one sent to a client's management), then the server's order. */
export function orderCatalog(entries: ReportCatalogEntry[]): ReportCatalogEntry[] {
  return [...entries].sort((a, b) => Number(b.key === "executive") - Number(a.key === "executive"));
}

/** False only when the server says the report renders to files alone ("full"). */
export const hasPreview = (entry: ReportCatalogEntry) => entry.preview !== false;

/** "agent 2.1.31" → "Needs agent 2.1.31"; a bare version reads as an agent version. */
export function needsLabel(needs: string): string {
  const text = needs.trim();
  if (/^needs\b/i.test(text)) return text;
  return /^\d/.test(text) ? `Needs agent ${text}` : `Needs ${text}`;
}

interface Props {
  entries: ReportCatalogEntry[];
  selected: ClientReportKey | null;
  onSelect: (key: ClientReportKey) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export default function ReportCatalog({ entries, selected, onSelect, loading, error, onRetry }: Props) {
  if (error && entries.length === 0) {
    return (
      <div
        className="th-onb-note"
        style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
        role="alert"
        data-testid="catalog-error"
      >
        <AlertTriangle className="h-4 w-4" />
        <span className="flex-1">Could not load the report catalog. {error}</span>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (loading && entries.length === 0) {
    return (
      <div className="th-rpt-catalog" aria-busy="true" aria-label="Loading report catalog">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="th-rpt-card th-rpt-card--skeleton">
            <span className="th-rpt-shimmer h-9 w-9 rounded-[9px]" />
            <span className="th-rpt-shimmer mt-4 h-4 w-2/3 rounded" />
            <span className="th-rpt-shimmer mt-2 h-3 w-full rounded" />
            <span className="th-rpt-shimmer mt-1.5 h-3 w-4/5 rounded" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="th-rpt-catalog" role="group" aria-label="Report catalog">
      {orderCatalog(entries).map((entry, index) => {
        const Icon = reportIcon(entry.key);
        const featured = entry.key === "executive";
        const active = entry.key === selected;
        return (
          <button
            key={entry.key}
            type="button"
            className="th-rpt-card th-onb-enter"
            data-featured={featured || undefined}
            aria-pressed={active}
            data-report={entry.key}
            onClick={() => onSelect(entry.key)}
            style={{ "--i": index } as CSSProperties}
          >
            <span className="th-rpt-card-top">
              <span className="th-onb-icon" style={{ "--onb-tone": "var(--th-accent)" } as CSSProperties}>
                <Icon className="h-4 w-4" />
              </span>
              {featured && (
                <span className="th-tag" data-size="md" style={{ "--chip-tone": "var(--th-accent)" } as CSSProperties}>
                  Recommended
                </span>
              )}
              <span className="th-rpt-check" aria-hidden="true">
                <Check className="h-3 w-3" />
              </span>
            </span>
            <span className="th-rpt-card-title">{entry.title}</span>
            <span className="th-rpt-card-desc" title={entry.description}>
              {entry.description}
            </span>
            <span className="th-rpt-card-foot">
              <span className="flex gap-1">
                {(["pdf", "csv"] as const).map((format) => (
                  <span
                    key={format}
                    className="th-rpt-format"
                    data-on={entry.formats.includes(format) || undefined}
                    aria-hidden={!entry.formats.includes(format)}
                  >
                    {format.toUpperCase()}
                  </span>
                ))}
              </span>
              {entry.needs ? (
                <span className="th-rpt-needs" title={needsLabel(entry.needs)}>
                  {needsLabel(entry.needs)}
                </span>
              ) : (
                !hasPreview(entry) && (
                  <span className="th-rpt-fileonly" title="Downloads as a file; no on-screen preview">
                    File only
                  </span>
                )
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
