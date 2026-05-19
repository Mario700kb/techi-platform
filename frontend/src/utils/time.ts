/**
 * Parse an ISO-8601 datetime string as UTC, regardless of whether it carries
 * an explicit timezone offset or not.
 *
 * Python's datetime.utcnow() produces strings like "2024-05-16T12:00:00"
 * (no trailing Z or +00:00).  The ECMAScript spec treats such strings as
 * *local* time when parsed by Date, which makes timestamps appear ~2 hours
 * wrong in UTC+2 zones (e.g. Europe/Tirane in summer).
 *
 * This helper appends "Z" when no timezone designator is present so the
 * browser always interprets the value as UTC and converts to local time
 * correctly for display.
 */
export function parseUTC(iso: string): Date {
  if (!iso) return new Date(NaN);
  // If no timezone designator (Z, +, or -hh:mm at the end), treat as UTC.
  if (!/[Zz]$/.test(iso) && !/[+-]\d{2}:\d{2}$/.test(iso)) {
    return new Date(iso + "Z");
  }
  return new Date(iso);
}

/**
 * Human-readable relative time ("just now", "5m ago", "2h ago", "3d ago").
 * Accepts null/undefined gracefully.
 */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diffSec = (Date.now() - parseUTC(iso).getTime()) / 1000;
  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

/**
 * Format a UTC ISO string as a localised date/time string using the browser's
 * locale and the user's OS timezone (DST-aware automatically).
 */
export function formatLocalDateTime(
  iso: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }
): string {
  if (!iso) return "—";
  return parseUTC(iso).toLocaleString(undefined, opts);
}
