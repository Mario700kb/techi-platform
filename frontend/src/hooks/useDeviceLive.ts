import { useEffect, useState } from "react";
import { buildDeviceLiveUrl, deviceRealtimeProtocols } from "../services/deviceRealtime";

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
 * agent_offline   — the agent has no live channel (offline, or older than 2.1.27)
 * unavailable     — the socket could not be opened or was refused
 */
export type LiveState = "connecting" | "waiting" | "live" | "agent_offline" | "unavailable";

export interface DeviceLive {
  state: LiveState;
  snapshot: LiveSnapshot | null;
  receivedAt: number | null;
  intervalSeconds: number;
}

const RECONNECT_DELAYS = [2000, 5000, 10000, 30000];
// No frame for this long while the agent is said to be connected: show the
// numbers as paused rather than pretending they are current.
const STALE_AFTER_MS = 12_000;

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Streams a device's live snapshot while `enabled` and the browser tab is
 * visible. The backend asks the agent to stream only while at least one page
 * holds this socket open, so closing the drawer or hiding the tab stops the
 * device's sampling within seconds.
 */
export function useDeviceLive(deviceId: number | null | undefined, enabled: boolean): DeviceLive {
  const [visible, setVisible] = useState(pageVisible);
  const [live, setLive] = useState<DeviceLive>({
    state: "connecting",
    snapshot: null,
    receivedAt: null,
    intervalSeconds: 3,
  });

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
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;

    setLive({ state: "connecting", snapshot: null, receivedAt: null, intervalSeconds: 3 });

    const markStaleLater = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        setLive((prev) => (prev.state === "live" ? { ...prev, state: "waiting" } : prev));
      }, STALE_AFTER_MS);
    };

    const open = () => {
      socket = new WebSocket(buildDeviceLiveUrl(deviceId), deviceRealtimeProtocols());
      socket.onopen = () => {
        attempt = 0;
      };
      socket.onmessage = (event) => {
        let message: { type?: string; agent_connected?: boolean; interval_seconds?: number; data?: LiveSnapshot };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === "live_status") {
          setLive((prev) => ({
            ...prev,
            intervalSeconds: message.interval_seconds ?? prev.intervalSeconds,
            state: !message.agent_connected ? "agent_offline" : prev.state === "live" ? "live" : "waiting",
          }));
        } else if (message.type === "live" && message.data) {
          const data = message.data;
          setLive((prev) => ({ ...prev, state: "live", snapshot: data, receivedAt: Date.now() }));
          markStaleLater();
        }
      };
      socket.onclose = (event) => {
        socket = null;
        if (closed) return;
        if (event.code === 4001) {
          // Refused: not signed in or not allowed to see this device.
          setLive((prev) => ({ ...prev, state: "unavailable" }));
          return;
        }
        setLive((prev) => ({ ...prev, state: prev.snapshot ? "waiting" : "connecting" }));
        const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
        attempt += 1;
        if (attempt > RECONNECT_DELAYS.length + 2) {
          setLive((prev) => ({ ...prev, state: "unavailable" }));
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
    };
  }, [deviceId, enabled, visible]);

  return live;
}
