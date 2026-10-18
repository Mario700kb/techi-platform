import type { LiveSnapshot } from "../hooks/useDeviceLive";
import { appCache } from "./appCache";

/**
 * The last live frame seen for each device in this browser session, so a
 * drawer opened again paints the numbers at once instead of empty tiles
 * while the stream connects.
 *
 * One appCache entry keyed by device id: memory first, and a copy in
 * sessionStorage under the signed-in operator's scope ("page." keys persist
 * per operator and are cleared on sign-out). Bounded to the 20 devices
 * opened most recently; a frame older than 15 minutes is not shown.
 */
export const LIVE_CACHE_KEY = "page.device-live";
export const LIVE_CACHE_MAX_DEVICES = 20;
export const LIVE_CACHE_TTL_MS = 15 * 60_000;
// A frame lists up to 10 processes; nothing more is kept.
const MAX_PROCESSES = 10;

export interface CachedLiveFrame {
  snapshot: LiveSnapshot;
  /** When the browser received it (ms since the epoch). */
  receivedAt: number;
}

type LiveCache = Record<string, CachedLiveFrame>;

function read(): LiveCache {
  const value = appCache.peek<LiveCache>(LIVE_CACHE_KEY);
  return value && typeof value === "object" ? value : {};
}

/** This session's last frame for the device, or null if none or older than 15 min. */
export function cachedLiveFrame(deviceId: number, now = Date.now()): CachedLiveFrame | null {
  const entry = read()[String(deviceId)];
  if (!entry || typeof entry.receivedAt !== "number" || !entry.snapshot) return null;
  if (now - entry.receivedAt > LIVE_CACHE_TTL_MS) return null;
  return entry;
}

/** Remembers the device's latest frame; drops expired entries and keeps the 20 newest. */
export function rememberLiveFrame(deviceId: number, snapshot: LiveSnapshot, receivedAt = Date.now()): void {
  const next: LiveCache = {
    ...read(),
    [String(deviceId)]: {
      snapshot: snapshot.processes ? { ...snapshot, processes: snapshot.processes.slice(0, MAX_PROCESSES) } : snapshot,
      receivedAt,
    },
  };
  const kept = Object.entries(next)
    .filter(([, entry]) => receivedAt - entry.receivedAt <= LIVE_CACHE_TTL_MS)
    .sort(([, a], [, b]) => b.receivedAt - a.receivedAt)
    .slice(0, LIVE_CACHE_MAX_DEVICES);
  appCache.set(LIVE_CACHE_KEY, Object.fromEntries(kept));
}
