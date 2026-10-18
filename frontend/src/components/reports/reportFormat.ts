import type {
  ReportCell,
  ReportColumn,
  ReportColumnKind,
  ReportKpiKind,
  ReportPeriod,
  ReportRow,
  ReportTone,
} from "../../api/reports";
import { TONE } from "../../utils/deviceStatus";
import { DISPLAY_LOCALE, formatDateTime, formatLocalDateTime, parseUTC, tiranaInputToUtcIso } from "../../utils/time";

/** Report tones on the app's status tokens, so both themes colour them. */
export const REPORT_TONE: Record<ReportTone, string> = {
  ok: TONE.online,
  warn: TONE.warning,
  crit: TONE.critical,
  info: TONE.info,
  neutral: TONE.neutral,
};

export const toneVar = (tone?: ReportTone | null) => REPORT_TONE[tone ?? "neutral"] ?? TONE.neutral;

const NUMBER = new Intl.NumberFormat(DISPLAY_LOCALE, { maximumFractionDigits: 2 });
const PERCENT = new Intl.NumberFormat(DISPLAY_LOCALE, { maximumFractionDigits: 1 });
const PERCENT_FINE = new Intl.NumberFormat(DISPLAY_LOCALE, { maximumFractionDigits: 2 });

/** 0–100 → "97.3%". Never rounds up to 100% or down to 0% (99.95% uptime is not 100%). */
export function formatPercent(value: number): string {
  if (value < 100 && Math.round(value * 10) >= 1000) return `${PERCENT_FINE.format(Math.floor(value * 100) / 100)}%`;
  if (value > 0 && Math.round(value * 10) === 0) return "<0.1%";
  return `${PERCENT.format(value)}%`;
}

/** Seconds → "2d 4h", "3h 12m", "12m", "45s". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** "2026-10-10" or an ISO instant → "10 Oct 2026" (a bare date is a calendar day, not shifted). */
export function formatReportDate(value: string): string {
  // Noon UTC is the same calendar day in Tirana (UTC+1/+2).
  const instant = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value;
  if (Number.isNaN(parseUTC(instant).getTime())) return value;
  return formatLocalDateTime(instant, { day: "numeric", month: "short", year: "numeric" });
}

const numeric = (value: ReportCell): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};

/** One cell as the operator reads it. Percent values are 0–100. */
export function formatCell(value: ReportCell, kind: ReportColumnKind): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return Array.isArray(value) ? value.map(String).join(", ") : JSON.stringify(value);
  switch (kind) {
    case "number": {
      const n = numeric(value);
      return n === null ? String(value) : NUMBER.format(n);
    }
    case "percent": {
      const n = numeric(value);
      return n === null ? String(value) : formatPercent(n);
    }
    case "duration": {
      const n = numeric(value);
      return n === null ? String(value) : formatDuration(n);
    }
    case "date":
      return typeof value === "string" ? formatReportDate(value) : String(value);
    case "datetime": {
      if (typeof value !== "string") return String(value);
      const text = formatDateTime(value);
      return text === "—" ? value : text;
    }
    default:
      return String(value);
  }
}

/** A KPI value by its kind; strings ("needs agent 2.1.31", "4h 12m") as the server wrote them. */
export function formatSummaryValue(value: string | number | null | undefined, kind: ReportKpiKind = "number"): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value !== "number" || kind === "text") return String(value);
  if (kind === "percent") return formatPercent(value);
  if (kind === "duration") return formatDuration(value);
  return NUMBER.format(value);
}

const NUMERIC_KINDS: ReadonlySet<ReportColumnKind> = new Set(["number", "percent", "duration"]);

export const isRightAligned = (column: ReportColumn) =>
  column.align ? column.align === "right" : NUMERIC_KINDS.has(column.kind);

const KIND_WIDTH: Partial<Record<ReportColumnKind, number>> = {
  number: 88,
  percent: 96,
  duration: 104,
  date: 128,
  datetime: 168,
  badge: 136,
};

/**
 * Fixed widths for the narrow kinds: wide enough for the (uppercase, 11px)
 * header and, for badges, the longest chip in the rows. Text columns share
 * what is left and wrap.
 */
export function columnWidth(column: ReportColumn, rows: ReportRow[] = []): number | undefined {
  const base = KIND_WIDTH[column.kind];
  if (base === undefined) return undefined;
  let width = Math.max(base, Math.ceil(column.label.length * 8 + 40));
  if (column.kind === "badge") {
    const longest = rows.reduce((n, row) => Math.max(n, formatCell(row[column.key], "badge").length), 0);
    width = Math.max(width, Math.min(320, Math.ceil(longest * 6.6 + 64)));
  }
  return width;
}

/** The table never squeezes a text column below this; narrower screens scroll the table. */
export const TEXT_COLUMN_MIN = 200;

export function tableMinWidth(columns: ReportColumn[], rows: ReportRow[] = []): number {
  return columns.reduce((sum, column) => sum + (columnWidth(column, rows) ?? TEXT_COLUMN_MIN), 0) + 32;
}

// ── Periods ──

export type PeriodChoice = "7" | "30" | "90" | "custom";

export const PERIOD_CHOICES: { value: PeriodChoice; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "custom", label: "Custom" },
];

/** "2026-10-05" -> "2026-10-06" (calendar arithmetic, timezone-free). */
export function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

/**
 * A period choice → the API's period. Custom ranges are whole Tirana days:
 * from 00:00 on the first day to 00:00 after the last (or now, if sooner).
 * Null while a custom range is incomplete or backwards.
 */
export function toReportPeriod(choice: string, from: string, to: string): ReportPeriod | null {
  if (choice !== "custom") return { period_days: Number(choice) };
  if (!from || !to || from > to) return null;
  return {
    period_from: tiranaInputToUtcIso(from),
    period_to: new Date(Math.min(Date.parse(tiranaInputToUtcIso(nextDay(to))), Date.now())).toISOString(),
  };
}

/** Whole days, Tirana time. The end is exclusive (00:00 after the last day,
 *  or "now"), so the last covered day is the one just before it. */
export function formatPeriod(start: string, end: string, withYear = false) {
  const day: Intl.DateTimeFormatOptions = withYear
    ? { day: "numeric", month: "short", year: "numeric" }
    : { day: "numeric", month: "short" };
  const last = new Date(parseUTC(end).getTime() - 1000).toISOString();
  return `${formatLocalDateTime(start, day)} – ${formatLocalDateTime(last, day)}`;
}
