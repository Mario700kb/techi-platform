// A device's presence — online, stale or offline — computed in the browser
// from the fields every device response and realtime event carries, so a row
// moves from online to stale to offline on time, between events, without a
// refetch.
//
// The rules mirror backend/app/models/device.py (freshness_for): the windows
// and the known-offline reasons below are kept equal to the backend's by
// backend/tests/test_status_realtime.py. Keep the three declarations in this
// exact form; that test reads them.

import { APP_TIME_ZONE, DISPLAY_LOCALE, parseUTC } from "./time";

export const ONLINE_WINDOW_MINUTES = 6;
export const STALE_WINDOW_MINUTES = 25;
export const EXPLICIT_OFFLINE_REASONS = ["shutdown", "sleep", "connection_lost"] as const;

export const ONLINE_WINDOW_MS = ONLINE_WINDOW_MINUTES * 60_000;
export const STALE_WINDOW_MS = STALE_WINDOW_MINUTES * 60_000;

/**
 * A "reconnecting" state older than this is over even if the event that
 * ended it was missed: the backend's grace is at most 150 s.
 */
export const RECONNECTING_MAX_MS = 3 * 60_000;

export type Freshness = "online" | "stale" | "offline";

/** The fields presence is computed from. Any device-like object has some. */
export interface PresenceFields {
  status?: string | null;
  last_seen?: string | null;
  offline_reason?: string | null;
  live?: boolean | null;
  live_lost_at?: string | null;
  /** The server's verdict at fetch time; used only when last_seen is absent. */
  freshness_state?: string | null;
}

// ─── Server clock ────────────────────────────────────────────────────────────
// Rows age against the server's clock, not the browser's: a PC whose clock is
// two minutes fast would otherwise show devices stale two minutes early, and
// disagree with the counts. Each realtime event says when the server sent it;
// network delay only makes a sample smaller, so the largest recent one is the
// best estimate of how far the server is ahead.

const CLOCK_SAMPLES = 20;
let clockSamples: number[] = [];
let clockOffsetMs = 0;

export function noteServerTime(iso: string | null | undefined, receivedAt: number = Date.now()): void {
  if (!iso) return;
  const sent = parseUTC(iso).getTime();
  if (Number.isNaN(sent)) return;
  clockSamples = [...clockSamples.slice(-(CLOCK_SAMPLES - 1)), sent - receivedAt];
  clockOffsetMs = Math.max(...clockSamples);
}

export function serverNow(): number {
  return Date.now() + clockOffsetMs;
}

/** A browser timestamp (useNow's tick) on the server's clock. */
export function onServerClock(clientMs: number): number {
  return clientMs + clockOffsetMs;
}

/** Tests only. */
export function resetServerClock(): void {
  clockSamples = [];
  clockOffsetMs = 0;
}

// ─── Freshness ───────────────────────────────────────────────────────────────

function isExplicitOffline(device: PresenceFields): boolean {
  return (
    device.status === "offline" && (EXPLICIT_OFFLINE_REASONS as readonly string[]).includes(device.offline_reason ?? "")
  );
}

function asFreshness(value: string | null | undefined): Freshness {
  return value === "online" || value === "stale" ? value : "offline";
}

/** online / stale / offline now, by the backend's rules. */
export function deviceFreshness(device: PresenceFields, now: number = serverNow()): Freshness {
  if (isExplicitOffline(device)) return "offline";
  if (device.live) return "online";
  if (device.last_seen === undefined) {
    // A summary without timestamps (directory entries): the server's word.
    return asFreshness(device.freshness_state ?? device.status);
  }
  if (!device.last_seen) return "offline";
  const age = now - parseUTC(device.last_seen).getTime();
  if (Number.isNaN(age)) return asFreshness(device.freshness_state ?? device.status);
  if (age <= ONLINE_WINDOW_MS) return "online";
  if (age <= STALE_WINDOW_MS) return "stale";
  return "offline";
}

/** The live channel dropped moments ago and the backend has not decided yet. */
export function isReconnecting(device: PresenceFields, now: number = serverNow()): boolean {
  if (device.live || !device.live_lost_at) return false;
  const lost = parseUTC(device.live_lost_at).getTime();
  return !Number.isNaN(lost) && now - lost < RECONNECTING_MAX_MS && deviceFreshness(device, now) !== "offline";
}

// ─── Words ───────────────────────────────────────────────────────────────────

const REASON_LABELS: Record<string, string> = {
  shutdown: "Shut down",
  sleep: "Asleep",
  hibernate: "Asleep",
  connection_lost: "Connection lost",
};

const LABELS: Record<Freshness, string> = { online: "Online", stale: "Stale", offline: "Offline" };

// The same tokens as TONE in deviceStatus.ts (which imports this module).
const TONES: Record<Freshness, string> = {
  online: "var(--th-status-online)",
  stale: "var(--th-status-stale)",
  offline: "var(--th-status-offline)",
};

function clockTime(ms: number, withSeconds = false): string {
  return new Date(ms).toLocaleTimeString(DISPLAY_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
    timeZone: APP_TIME_ZONE,
  });
}

function dayKey(ms: number): string {
  return new Date(ms).toLocaleDateString(DISPLAY_LOCALE, { timeZone: APP_TIME_ZONE });
}

/** "just now", "4m ago", "3h ago", "2d ago". */
export function shortAge(ms: number, now: number): string {
  const sec = Math.max(0, (now - ms) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86_400 * 30) return `${Math.floor(sec / 86_400)}d ago`;
  return new Date(ms).toLocaleDateString(DISPLAY_LOCALE, { day: "numeric", month: "short", timeZone: APP_TIME_ZONE });
}

/** "since 14:05" the same day (Tirana), otherwise "3d ago". */
function offlineSince(ms: number, now: number): string {
  return dayKey(ms) === dayKey(now) ? `since ${clockTime(ms)}` : shortAge(ms, now);
}

export interface PresenceView {
  state: Freshness;
  /** "Online", "Stale", "Offline". */
  label: string;
  /** After the label: "live", "2m ago", "reconnecting…", "Shut down · since 14:05". */
  detail: string;
  /** Why it is offline: "Shut down", "Asleep", "Connection lost", "No heartbeat", "Never seen". */
  reason: string | null;
  /** Offline only: "since 14:05" or "2d ago". */
  since?: string | null;
  tone: string;
  live: boolean;
  reconnecting: boolean;
  /** The full sentence, for the tooltip and screen readers. */
  title: string;
}

/** Everything a status chip shows, for this device now. */
export function presenceView(device: PresenceFields, now: number = serverNow()): PresenceView {
  const state = deviceFreshness(device, now);
  const seenMs = device.last_seen ? parseUTC(device.last_seen).getTime() : NaN;
  const seen = !Number.isNaN(seenMs);
  const base = { state, label: LABELS[state], tone: TONES[state], live: false, reconnecting: false };

  if (state === "offline") {
    const reason = isExplicitOffline(device)
      ? (REASON_LABELS[device.offline_reason ?? ""] ?? "Offline")
      : seen
        ? "No heartbeat"
        : device.last_seen === undefined
          ? null
          : "Never seen";
    const since = seen ? offlineSince(seenMs, now) : null;
    const detail = [reason, reason === "Never seen" ? null : since].filter(Boolean).join(" · ");
    const title =
      reason === "Never seen"
        ? "Offline — the agent has never reported"
        : `Offline${reason ? ` — ${reason.toLowerCase()}` : ""}${seen ? `; last contact ${clockTime(seenMs)} (${shortAge(seenMs, now)})` : ""}`;
    return { ...base, reason, detail, title, since: reason === "Never seen" ? null : since };
  }

  if (device.live) {
    return {
      ...base,
      live: true,
      reason: null,
      detail: "live",
      title: "Online — the agent's live connection is open; status changes show at once",
    };
  }

  if (isReconnecting(device, now)) {
    const lost = parseUTC(device.live_lost_at!).getTime();
    return {
      ...base,
      reconnecting: true,
      reason: null,
      detail: "reconnecting…",
      title: `Live connection dropped at ${clockTime(lost, true)}; waiting for it to return before marking the device offline`,
    };
  }

  const age = seen ? shortAge(seenMs, now) : "—";
  return {
    ...base,
    reason: null,
    detail: age,
    title:
      state === "stale"
        ? `Stale — no heartbeat for ${age.replace(" ago", "")}; offline after ${STALE_WINDOW_MINUTES} minutes`
        : `Online — last heartbeat ${seen ? `${clockTime(seenMs)} (${age})` : "unknown"}`,
  };
}
