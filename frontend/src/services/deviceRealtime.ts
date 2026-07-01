export type DeviceRealtimeEventType =
  | "connection_ready"
  | "device_online"
  | "device_offline"
  | "device_updated"
  | "heartbeat_received"
  | "deployment_event"
  | "server_ping"
  | "rustdesk_updated"
  | "rustdesk_online"
  | "rustdesk_offline"
  | "sync_failed"
  | "telemetry_updated"
  | "health_warning"
  | "health_critical"
  | "health_recovered"
  | "alert_created"
  | "alert_resolved"
  | "action_queued"
  | "action_status_changed";

export interface DeviceRealtimeEvent {
  event_id?: string;
  version?: number;
  type: DeviceRealtimeEventType;
  tenant_id?: string;
  occurred_at?: string;
  reason?: string | null;
  data?: {
    id?: number;
    rustdesk_id?: string;
    hostname?: string | null;
    display_name?: string | null;
    current_user?: string | null;
    domain?: string | null;
    public_ip?: string | null;
    local_ip?: string | null;
    os_name?: string | null;
    os_version?: string | null;
    platform?: string | null;
    device_type?: string;
    status?: "online" | "offline" | "queued" | "sent" | "acknowledged" | "running" | "completed" | "failed" | "expired" | "cancelled";
    freshness_state?: "online" | "stale" | "offline";
    last_seen?: string | null;
    client_id?: number | null;
    group_id?: number | null;
    client_name?: string | null;
    group_name?: string | null;
    registered_at?: string | null;
    assignment_source?: string;
    resolved_client_id?: number | null;
    resolved_client_name?: string | null;
    resolved_group?: string | null;
    resolved_assignment_source?: string;
    resolved_device_category?: string;
    is_archived?: boolean;
    duplicate_candidate?: boolean;
    duplicate_of_device_id?: number | null;
    duplicate_score?: number | null;
    is_in_maintenance?: boolean;
    maintenance_ends_at?: string | null;
    maintenance_note?: string | null;
    heartbeat_id?: number;
    message?: string;
    connection_id?: string;
    channel?: string;
    rustdesk_install_status?: string;
    rustdesk_status?: string;
    rustdesk_version?: string | null;
    rustdesk_install_path?: string | null;
    rustdesk_sync_state?: string;
    rustdesk_sync_message?: string | null;
    rustdesk_last_seen_at?: string | null;
    rustdesk_synced_at?: string | null;
    rustdesk_verified_at?: string | null;
    rustdesk_manual_override?: boolean;
    rustdesk_conflict_detected?: boolean;
    rustdesk_last_repair_at?: string | null;
    rustdesk_repair_count?: number;
    cpu_percent?: number | null;
    ram_percent?: number | null;
    disk_percent?: number | null;
    uptime_seconds?: number | null;
    heartbeat_latency_ms?: number | null;
    health_score?: number | null;
    health_state?: string;
    health_reasons?: string[];
    reasons?: string[];
    device_id?: number;
    action_type?: string;
    created_at?: string;
    created_by?: string | null;
    queued_at?: string | null;
    sent_at?: string | null;
    acknowledged_at?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    failed_at?: string | null;
    cancelled_at?: string | null;
    expired_at?: string | null;
    result_message?: string | null;
    error_message?: string | null;
    execution_timeout_seconds?: number;
  };
}

export type DeviceRealtimeStatus = "connecting" | "connected" | "disconnected" | "fallback";

export interface DeviceRealtimeDiagnostics {
  attempt: number;
  lastMessageAt?: number;
  lastError?: string;
  nextRetryMs?: number;
}

type EventHandler = (event: DeviceRealtimeEvent) => void;
type StatusHandler = (status: DeviceRealtimeStatus, diagnostics: DeviceRealtimeDiagnostics) => void;

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 15000, 30000];
const STALE_CONNECTION_MS = 45000;
const CLIENT_PING_MS = 20000;

export function buildDeviceRealtimeUrl(tenantId: string = "default"): string {
  let wsBase: string;
  const configured = import.meta.env.VITE_WS_BASE_URL;
  if (configured) {
    wsBase = configured
      .replace(/^https:/i, "wss:")
      .replace(/^http:/i, "ws:");
  } else if (typeof window !== "undefined") {
    // Production reverse proxies normally expose WebSockets on the page origin.
    // Vite development still talks directly to the backend on port 8000.
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const isViteDev = window.location.port === "5173";
    wsBase = isViteDev
      ? `${wsProtocol}//${window.location.hostname}:8000`
      : `${wsProtocol}//${window.location.host}`;
  } else {
    wsBase = "ws://localhost:8000";
  }
  const url = new URL(wsBase);
  url.pathname = "/ws/devices";
  url.searchParams.set("tenant_id", tenantId);
  const token = window.localStorage.getItem("techi.auth.token");
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

export class DeviceRealtimeClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | undefined;
  private staleTimer: number | undefined;
  private pingTimer: number | undefined;
  private closedByClient = false;
  private attempt = 0;
  private lastMessageAt: number | undefined;
  private lastError: string | undefined;
  private eventHandlers = new Set<EventHandler>();
  private statusHandlers = new Set<StatusHandler>();

  constructor(private tenantId: string = "default") {}

  connect() {
    this.closedByClient = false;
    this.open();
  }

  disconnect() {
    this.closedByClient = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.emitStatus("disconnected");
  }

  onEvent(handler: EventHandler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler) {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private open() {
    if (this.closedByClient) {
      return;
    }

    this.emitStatus("connecting");
    this.socket = new WebSocket(buildDeviceRealtimeUrl(this.tenantId));

    this.socket.onopen = () => {
      this.attempt = 0;
      this.lastError = undefined;
      this.lastMessageAt = Date.now();
      this.emitStatus("connected");
      this.startHealthChecks();
      this.debug("connected");
    };

    this.socket.onmessage = (message) => {
      this.lastMessageAt = Date.now();
      try {
        const event = JSON.parse(message.data) as DeviceRealtimeEvent;
        this.eventHandlers.forEach((handler) => handler(event));
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : "Invalid realtime payload";
        this.debug("invalid message", this.lastError);
      }
    };

    this.socket.onerror = () => {
      this.lastError = "WebSocket error";
      this.debug("error");
      this.socket?.close();
    };

    this.socket.onclose = (event) => {
      this.clearTimers();
      this.socket = null;
      if (this.closedByClient) {
        this.emitStatus("disconnected");
        return;
      }
      if (event.code === 4001) {
        this.closedByClient = true;
        this.lastError = "Realtime authentication expired";
        this.emitStatus("fallback");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    const delay = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)];
    this.attempt += 1;
    this.emitStatus(this.attempt > 1 ? "fallback" : "disconnected", { nextRetryMs: delay });
    this.debug(`reconnect in ${delay}ms`);
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  private startHealthChecks() {
    this.staleTimer = window.setInterval(() => {
      if (!this.lastMessageAt) {
        return;
      }
      if (Date.now() - this.lastMessageAt > STALE_CONNECTION_MS) {
        this.lastError = "Realtime connection stale";
        this.emitStatus("fallback");
        this.socket?.close();
      }
    }, 5000);

    this.pingTimer = window.setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "client_ping", occurred_at: new Date().toISOString() }));
      }
    }, CLIENT_PING_MS);
  }

  private clearTimers() {
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.staleTimer) window.clearInterval(this.staleTimer);
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.reconnectTimer = undefined;
    this.staleTimer = undefined;
    this.pingTimer = undefined;
  }

  private emitStatus(status: DeviceRealtimeStatus, overrides: Partial<DeviceRealtimeDiagnostics> = {}) {
    const diagnostics = {
      attempt: this.attempt,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      ...overrides,
    };
    this.statusHandlers.forEach((handler) => handler(status, diagnostics));
  }

  private debug(message: string, detail?: unknown) {
    if (import.meta.env.VITE_REALTIME_DEBUG !== "true") {
      return;
    }
    console.debug("[device-realtime]", message, detail ?? "");
  }
}
