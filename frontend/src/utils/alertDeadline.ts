import type { Alert } from "../types/alert";
import { WAITING_LABELS } from "../types/alert";
import { formatDateTime, parseUTC } from "./time";

export interface DeadlineText {
  label: string;
  tone: string;
  title: string;
  overdue: boolean;
}

/** "45m", "3h 20m", "2d 4h". */
export function formatSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** The deadline that matters now: to take it while nobody has, else to fix it.
 *  The server stamps both once; the browser only counts down to them. */
export function alertDeadline(alert: Alert, now = Date.now()): DeadlineText | null {
  if (alert.state !== "open" || alert.id <= 0) return null;
  if (alert.waiting_since) {
    return {
      label: alert.waiting_reason ? WAITING_LABELS[alert.waiting_reason] : "Waiting",
      tone: "var(--th-status-info)",
      title: "The deadlines are stopped while waiting",
      overdue: false,
    };
  }
  const clock = alert.sla_24x7 ? "counted every hour (P1 on a server)" : "counted in working hours";
  const toTake = !alert.acknowledged_at && alert.ack_due_at ? alert.ack_due_at : null;
  const due = toTake ?? alert.resolve_due_at;
  if (!due) return null;
  const left = parseUTC(due).getTime() - now;
  const what = toTake ? "Take" : "Fix";
  if (left <= 0) {
    return {
      label: `${what} overdue ${formatSpan(left)}`,
      tone: "var(--th-status-critical)",
      title: `${what === "Take" ? "To be taken" : "To be fixed"} by ${formatDateTime(due)}, ${clock}`,
      overdue: true,
    };
  }
  return {
    label: `${what} in ${formatSpan(left)}`,
    tone: left < (toTake ? 5 : 60) * 60_000 ? "var(--th-status-warning)" : "var(--th-text-muted)",
    title: `${what === "Take" ? "To be taken" : "To be fixed"} by ${formatDateTime(due)}, ${clock}`,
    overdue: false,
  };
}
