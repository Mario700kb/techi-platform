/**
 * The one timezone every human-facing time in TECHI is shown and entered in.
 * Storage and APIs stay UTC; only display and form inputs use this zone.
 * Every toLocale*String call on a Date must pass `timeZone: APP_TIME_ZONE`
 * (guarded by src/utils/__tests__/time.test.ts).
 */
export const APP_TIME_ZONE = "Europe/Tirane";

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
 * Format a UTC ISO string as a localised date/time string in Tirana time
 * (DST-aware), whatever timezone the viewer's device is set to.
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
  return parseUTC(iso).toLocaleString(undefined, { ...opts, timeZone: APP_TIME_ZONE });
}

/** Minutes Tirana is ahead of UTC at the given instant (+120 CEST, +60 CET). */
function zoneOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((wallAsUtc - utcMs) / 60000);
}

/**
 * A Tirana wall-clock value from a form input ("YYYY-MM-DD" or
 * "YYYY-MM-DDTHH:mm") → UTC ISO string for the API. Independent of the
 * device's own timezone.
 */
export function tiranaInputToUtcIso(value: string): string {
  const [datePart, timePart = "00:00"] = value.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  const wallMs = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
  let utcMs = wallMs - zoneOffsetMinutes(wallMs) * 60000;
  // Re-check at the resolved instant so DST-change days land correctly.
  utcMs = wallMs - zoneOffsetMinutes(utcMs) * 60000;
  return new Date(utcMs).toISOString();
}

/** UTC ISO (from the API) → "YYYY-MM-DDTHH:mm" in Tirana, for prefilling inputs. */
export function utcToTiranaInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const utcMs = parseUTC(iso).getTime();
  if (Number.isNaN(utcMs)) return "";
  return new Date(utcMs + zoneOffsetMinutes(utcMs) * 60000).toISOString().slice(0, 16);
}
