import { useEffect, useState } from "react";
import { buildDeviceLiveUrl, deviceRealtimeProtocols } from "../services/deviceRealtime";
import { cachedLiveFrame, rememberLiveFrame } from "../store/liveCache";

export interface LiveDisk {
  mount: string;
  used_percent: number;
  free_gb: number;
  total_gb: number;
}

export interface LiveProcess {
  pid: number;
  name: string;
  cpu_percent: number;
  memory_mb: number;
}

export interface LiveSnapshot {
  at?: number;
  cpu_percent?: number;
  ram_percent?: number;
  ram_used_mb?: number;
  ram_total_mb?: number;
  disks?: LiveDisk[];
  net_rx_kbps?: number;
  net_tx_kbps?: number;
  uptime_seconds?: number;
  current_user?: string;
  user_session_state?: string;
  process_count?: number;
  processes?: LiveProcess[];
}

/**
 * connecting      — opening the page's live socket
 * waiting         — the agent is connected and asked to stream; no frame yet
 * live            — frames are arriving
 * paused          — frames arrived and then stopped (none for 12 s, or the
 *                   socket dropped and is reconnecting); the last ones stay
 * agent_offline   — the agent has no live channel (offline, or older than 2.1.27)
 * unavailable     — the socket could not be opened or was refused
 */
export type LiveState = "connecting" | "waiting" | "live" | "paused" | "agent_offline" | "unavailable";

export interface DeviceLive {
  state: LiveState;
  /**
   * The latest values: this subscription's last frame, or, until the first
   * one arrives, this session's last frame for the device (see
   * store/liveCache). Never cleared while the same device is shown.
   */
  snapshot: LiveSnapshot | null;
  /** When `snapshot` was received (ms since the epoch). */
  receivedAt: number | null;
  intervalSeconds: number;
  /** The socket is held open: enabled, and the browser tab is visible. */
  active: boolean;
}

const RECONNECT_DELAYS = [2000, 5000, 10000, 30000];
// No frame for this long while the agent is said to be connected: show the
// numbers as paused rather than pretending they are current.
const STALE_AFTER_MS = 12_000;

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

type LiveForDevice = DeviceLive & { deviceId: number | null | undefined };

/** A device's starting point: this session's last frame for it, if any. */
function seed(deviceId: number | null | undefined): LiveForDevice {
  const cached = deviceId ? cachedLiveFrame(deviceId) : null;
  return {
    deviceId,
    state: "connecting",
    snapshot: cached?.snapshot ?? null,
    receivedAt: cached?.receivedAt ?? null,
    intervalSeconds: 3,
    active: false,
  };
}

/**
 * Streams a device's live snapshot while `enabled` and the browser tab is
 * visible. The backend asks the agent to stream only while at least one page
 * holds this socket open (and renews that request itself), so closing the
 * drawer or hiding the tab stops the device's sampling within seconds.
 *
 * The values never go blank: a device shown again starts from this
 * session's last frame for it, and when the stream stops the last frame
 * stays (state "paused", `active` false once the socket is released).
 */
export function useDeviceLive(deviceId: number | null | undefined, enabled: boolean): DeviceLive {
  const [visible, setVisible] = useState(pageVisible);
  const [live, setLive] = useState<LiveForDevice>(() => seed(deviceId));
  // Another device: its own starting point, before this render paints.
  let current = live;
  if (live.deviceId !== deviceId) {
    current = seed(deviceId);
    setLive(current);
  }

  useEffect(() => {
    const onChange = () => setVisible(pageVisible());
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  useEffect(() => {
    if (!enabled || !visible || !deviceId || typeof WebSocket === "undefined") return;
    let socket: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let gotFrame = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    // Only this device's state: a late callback never writes into another's.
    const update = (next: (prev: LiveForDevice) => LiveForDevice) =>
      setLive((prev) => (prev.deviceId === deviceId ? next(prev) : prev));

    update((prev) => ({ ...prev, state: "connecting", active: true }));

    const markStaleLater = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        update((prev) => (prev.state === "live" ? { ...prev, state: "paused" } : prev));
      }, STALE_AFTER_MS);
    };

    const open = () => {
      socket = new WebSocket(buildDeviceLiveUrl(deviceId), deviceRealtimeProtocols());
      socket.onopen = () => {
        attempt = 0;
      };
      socket.onmessage = (event) => {
        if (closed) return;
        let message: { type?: string; agent_connected?: boolean; interval_seconds?: number; data?: LiveSnapshot };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === "live_status") {
          update((prev) => ({
            ...prev,
            intervalSeconds: message.interval_seconds ?? prev.intervalSeconds,
            state: !message.agent_connected
              ? "agent_offline"
              : prev.state === "live"
                ? "live"
                : gotFrame
                  ? "paused"
                  : "waiting",
          }));
        } else if (message.type === "live" && message.data) {
          const data = message.data;
          const receivedAt = Date.now();
          gotFrame = true;
          rememberLiveFrame(deviceId, data, receivedAt);
          update((prev) => ({ ...prev, state: "live", snapshot: data, receivedAt }));
          markStaleLater();
        }
      };
      socket.onclose = (event) => {
        socket = null;
        if (closed) return;
        if (staleTimer) clearTimeout(staleTimer);
        if (event.code === 4001) {
          // Refused: not signed in or not allowed to see this device.
          update((prev) => ({ ...prev, state: "unavailable" }));
          return;
        }
        update((prev) => ({ ...prev, state: gotFrame ? "paused" : "connecting" }));
        const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
        attempt += 1;
        if (attempt > RECONNECT_DELAYS.length + 2) {
          update((prev) => ({ ...prev, state: "unavailable" }));
        }
        reconnectTimer = setTimeout(open, delay);
      };
    };

    open();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (staleTimer) clearTimeout(staleTimer);
      socket?.close();
      // The values stay on screen, paused, until the device is shown again.
      update((prev) => ({
        ...prev,
        active: false,
        state: prev.state === "live" || (prev.snapshot && prev.state !== "unavailable") ? "paused" : prev.state,
      }));
    };
  }, [deviceId, enabled, visible]);

  return {
    state: current.state,
    snapshot: current.snapshot,
    receivedAt: current.receivedAt,
    intervalSeconds: current.intervalSeconds,
    active: current.active,
  };
}
