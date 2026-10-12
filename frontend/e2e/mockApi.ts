/**
 * An in-browser stand-in for the TECHI API: a small fictional fleet, the
 * session/MFA endpoints, and a recorder for unexpected calls. Typed against
 * the app's own API types, so a contract change breaks `npm run typecheck:e2e`
 * here instead of silently drifting.
 */
import type { Page, Route } from "@playwright/test";
import type { RemoteActionWithDevice } from "../src/api/actions";
import type { AuditFacets, AuditLogPage } from "../src/api/audit";
import type { AuthSession, AuthUser, MfaStatus, OperatorSession } from "../src/api/auth";
import type { Client, DeviceGroup } from "../src/api/clients";
import type { ConnectPreference } from "../src/api/connect";
import type {
  Device,
  DeviceFleetOverview,
  DeviceQuickCounts,
  DevicesResponse,
  FleetInsights,
} from "../src/api/devices";
import type { OperatorPresenceRecord, OperatorRecord } from "../src/api/operators";
import type { NotificationChannel, NotificationDeliveryList, NotificationRule } from "../src/api/notifications";
import type { PlatformFeatures } from "../src/api/platform";
import type { SystemStatus } from "../src/api/system";
import type { TeamWithStats } from "../src/api/teams";
import type { Alert, AlertCount } from "../src/types/alert";

const NOW = new Date();
const iso = (minutesAgo = 0) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

export const OWNER: AuthUser = {
  id: 1,
  username: "ana.owner",
  email: "ana@example.test",
  display_name: "Ana Owner",
  role: "owner",
  is_active: true,
  is_superuser: true,
  created_at: "2025-01-15T09:00:00Z",
  last_login_at: iso(60),
  mfa_enabled: false,
};

export const READONLY: AuthUser = {
  ...OWNER,
  id: 4,
  username: "rina.view",
  display_name: "Rina View",
  role: "readonly",
};

const CLIENTS: Client[] = [
  { id: 1, name: "Northwind Clinic", slug: "northwind", is_active: true, created_at: "2025-02-01T00:00:00Z" },
  { id: 2, name: "Blue Harbor Logistics", slug: "blue-harbor", is_active: true, created_at: "2025-03-01T00:00:00Z" },
];

const GROUPS: DeviceGroup[] = [
  { id: 1, client_id: 1, name: "Front desk", created_at: "2025-02-02T00:00:00Z" },
  { id: 2, client_id: 2, name: "Warehouse", created_at: "2025-03-02T00:00:00Z" },
];

function device(id: number, hostname: string, overrides: Partial<Device> = {}): Device {
  return {
    id,
    rustdesk_id: String(100_000_000 + id),
    hostname,
    display_name: null,
    current_user: "user",
    domain: "WORKGROUP",
    local_ip: `10.0.0.${id}`,
    public_ip: "203.0.113.10",
    os_name: "Windows",
    os_caption: "Microsoft Windows 11 Pro",
    platform: "windows",
    device_type: "client",
    status: "online",
    freshness_state: "online",
    registered_at: "2025-04-01T00:00:00Z",
    last_seen: iso(1),
    client_id: 1,
    client_name: "Northwind Clinic",
    group_id: 1,
    group_name: "Front desk",
    cpu: "Intel Core i5",
    ram: "16 GB",
    storage: "512 GB",
    rustdesk_install_status: "installed",
    rustdesk_status: "running",
    rustdesk_version: "1.4.6",
    rustdesk_sync_state: "synced",
    rustdesk_manual_override: false,
    rustdesk_conflict_detected: false,
    agent_version: "2.1.20",
    ...overrides,
  };
}

export const DEVICES: Device[] = [
  device(1, "NW-RECEPTION-01"),
  device(2, "NW-DOCTOR-02", { freshness_state: "stale", last_seen: iso(14) }),
  device(3, "NW-SRV-01", { device_type: "server", os_caption: "Windows Server 2022 Standard" }),
  device(4, "BH-WH-SCANNER", {
    client_id: 2,
    client_name: "Blue Harbor Logistics",
    group_id: 2,
    group_name: "Warehouse",
    status: "offline",
    freshness_state: "offline",
    last_seen: iso(60 * 26),
    offline_reason: "shutdown",
  }),
  device(5, "BH-OFFICE-LAPTOP", {
    client_id: 2,
    client_name: "Blue Harbor Logistics",
    group_id: 2,
    group_name: "Warehouse",
  }),
];

const ALERTS: Alert[] = [
  {
    id: 11,
    device_id: 4,
    kind: "device_offline",
    severity: "critical",
    state: "open",
    message: "BH-WH-SCANNER is offline",
    created_at: iso(60 * 26),
    updated_at: iso(60 * 26),
    device_name: "BH-WH-SCANNER",
    client_name: "Blue Harbor Logistics",
  },
  {
    id: 12,
    device_id: 2,
    kind: "low_disk",
    severity: "warning",
    state: "open",
    message: "C: has 6% free",
    created_at: iso(90),
    updated_at: iso(90),
    device_name: "NW-DOCTOR-02",
    client_name: "Northwind Clinic",
  },
];

const OPERATORS: OperatorRecord[] = [
  { ...OWNER, last_active_at: iso(0), mfa_enabled: true },
  {
    id: 2,
    username: "besi.ops",
    email: "besi@example.test",
    display_name: "Besi Ops",
    role: "operator",
    is_active: true,
    is_superuser: false,
    created_at: "2025-05-01T00:00:00Z",
    last_login_at: iso(300),
    last_active_at: iso(20),
    mfa_enabled: false,
  },
];

export interface MockState {
  /** Who is signed in; null = signed out. */
  user: AuthUser | null;
  /** The password step answers with an MFA challenge. */
  mfaOnLogin: boolean;
  mfaEnrollmentRequired: boolean;
  /** Every API call that had no handler, as "METHOD /path". */
  unhandled: string[];
}

type Handler = (route: Route, state: MockState, url: URL) => Promise<void> | void;

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });

function sessionBody(state: MockState): AuthSession {
  return {
    user: state.user!,
    permissions: state.user!.role === "readonly" ? ["view_devices"] : [],
    denied: [],
    session_expires_at: new Date(NOW.getTime() + 8 * 3_600_000).toISOString(),
    mfa_enrollment_required: state.mfaEnrollmentRequired,
  };
}

const overview: DeviceFleetOverview = {
  stats: { total: 5, online: 3, stale: 1, offline: 1 },
  tree_counts: { total: 5, unassigned: 0, by_client: { "1": 3, "2": 2 } },
  critical: 1,
  warnings: 1,
  average_health: 92,
  needs_updates: 0,
  agents_outdated: 0,
  active_agent_version: "2.1.20",
  active_agent_sha256: null,
  loaded_at: iso(0),
};

const insights: FleetInsights = {
  availability: {
    days: 30,
    series: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(NOW.getTime() - (29 - i) * 86_400_000).toISOString().slice(0, 10),
      availability_pct: 95 + (i % 5),
    })),
    overall_pct: 97.2,
    coverage_pct: 100,
    device_count: 5,
  },
  alerts: { days: 30, series: [], opened_total: 4, resolved_total: 2, open_now: 2, mean_time_to_resolve_hours: 3.5 },
  problem_devices: [
    {
      device_id: 4,
      name: "BH-WH-SCANNER",
      client_name: "Blue Harbor Logistics",
      offline_events: 3,
      alerts: 1,
      freshness_state: "offline",
    },
  ],
  generated_at: iso(0),
};

const quickCounts: DeviceQuickCounts = {
  counts: {
    all: 5,
    online: 3,
    stale: 1,
    offline: 1,
    servers: 1,
    workstations: 4,
    needs_updates: 0,
    favorites: 0,
  } as DeviceQuickCounts["counts"],
  agent_versions: { "2.1.20": 5 },
};

const features: PlatformFeatures = {
  FEATURE_PLATFORM_CORE: true,
  FEATURE_LINUX: true,
  FEATURE_VAULT: true,
  FEATURE_TERMINAL: true,
  FEATURE_MIKROTIK: true,
  FEATURE_STORAGE: false,
  FEATURE_HYPERVISOR: false,
  FEATURE_NOTIFICATIONS: true,
  FEATURE_REPORTING: true,
};

const alertCount: AlertCount = { total_open: 2, by_severity: { critical: 1, warning: 1 }, devices_affected: 2 };
const recentActions: RemoteActionWithDevice[] = [];
const presence: OperatorPresenceRecord[] = OPERATORS.map((o) => ({
  id: o.id,
  username: o.username,
  display_name: o.display_name,
  role: o.role,
  is_online: o.id === 1,
  last_active_at: o.last_active_at,
}));
const teams: TeamWithStats[] = [
  {
    id: 1,
    name: "Helpdesk",
    description: "First line",
    color: "#3b82f6",
    permissions: ["view_devices"],
    created_at: "2025-05-01T00:00:00Z",
    member_count: 1,
    client_count: 1,
    group_count: 0,
    explicit_device_count: 0,
    effective_device_count: 3,
    operator_ids: [2],
  },
];
const audit: AuditLogPage = {
  total: 2,
  items: [
    {
      id: 2,
      operator_id: 1,
      operator_username: "ana.owner",
      action: "login",
      entity_type: null,
      entity_id: null,
      details_json: null,
      created_at: iso(60),
    },
    {
      id: 1,
      operator_id: 2,
      operator_username: "besi.ops",
      action: "device_archived",
      entity_type: "device",
      entity_id: 9,
      details_json: null,
      created_at: iso(600),
    },
  ],
};
const auditFacets: AuditFacets = {
  actions: [
    { value: "login", count: 1 },
    { value: "device_archived", count: 1 },
  ],
  entity_types: [{ value: "device", count: 1 }],
  operators: [
    { value: "ana.owner", count: 1 },
    { value: "besi.ops", count: 1 },
  ],
};
const systemStatus: SystemStatus = {
  checked_at: iso(0),
  services: [{ key: "backend", state: "ok", label: "Backend", detail: "Healthy" }],
};
const mfaStatus: MfaStatus = { enabled: false, enabled_at: null, required: false, recovery_codes_remaining: 0 };
const sessions: OperatorSession[] = [
  {
    id: "current",
    created_at: iso(60),
    last_used_at: iso(0),
    expires_at: iso(-600),
    ip_address: "203.0.113.20",
    user_agent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    current: true,
  },
];
const connectPreferences: ConnectPreference[] = [];

const channels: NotificationChannel[] = [
  {
    id: 1,
    name: "Ops email",
    channel_type: "email",
    enabled: true,
    config: { to: ["ops@example.test"] },
    has_secret: false,
    created_by: "ana.owner",
    created_at: "2025-06-01T00:00:00Z",
    updated_at: "2025-06-01T00:00:00Z",
  },
];
const rules: NotificationRule[] = [
  {
    id: 1,
    event_type: "device_offline",
    scope_type: "global",
    client_id: null,
    channel_id: 1,
    enabled: true,
    min_severity: null,
    cooldown_seconds: 900,
    rate_limit_per_hour: null,
    created_by: "ana.owner",
    created_at: "2025-06-01T00:00:00Z",
    updated_at: "2025-06-01T00:00:00Z",
  },
];
const deliveries: NotificationDeliveryList = {
  total: 1,
  items: [
    {
      id: 1,
      rule_id: 1,
      channel_id: 1,
      event_type: "device_offline",
      device_id: 4,
      client_id: 2,
      title: "BH-WH-SCANNER is offline",
      status: "sent",
      attempt_count: 1,
      last_error: null,
      created_at: iso(60 * 26),
      sent_at: iso(60 * 26),
    },
  ],
};

function devicesPage(url: URL): DevicesResponse {
  const status = url.searchParams.get("freshness_state") ?? url.searchParams.get("quick_filter");
  const rows =
    status && ["online", "stale", "offline"].includes(status)
      ? DEVICES.filter((d) => d.freshness_state === status)
      : DEVICES;
  return { devices: rows, total: rows.length };
}

const HANDLERS: Record<string, Handler> = {
  "GET /api/v1/auth/session": (route, state) =>
    state.user ? json(route, sessionBody(state)) : json(route, { detail: "Not authenticated" }, 401),
  "POST /api/v1/auth/refresh": (route, state) =>
    state.user
      ? json(route, { session_expires_at: sessionBody(state).session_expires_at })
      : json(route, { detail: "Session expired" }, 401),
  "POST /api/v1/auth/logout": (route, state) => {
    state.user = null;
    return route.fulfill({ status: 204 });
  },
  "POST /api/v1/auth/login": async (route, state) => {
    const body = route.request().postDataJSON() as { username: string; password: string };
    if (body.password !== "correct-password") return json(route, { detail: "Invalid username or password" }, 401);
    if (state.mfaOnLogin)
      return json(route, { mfa_required: true, mfa_token: "challenge-token", user: null, session_expires_at: null });
    state.user = body.username === READONLY.username ? READONLY : OWNER;
    return json(route, {
      mfa_required: false,
      mfa_token: null,
      user: state.user,
      session_expires_at: sessionBody(state).session_expires_at,
    });
  },
  "POST /api/v1/auth/login/mfa": async (route, state) => {
    const body = route.request().postDataJSON() as { code: string };
    if (body.code !== "123456") return json(route, { detail: "That code is not valid" }, 401);
    state.user = OWNER;
    return json(route, {
      mfa_required: false,
      mfa_token: null,
      user: OWNER,
      session_expires_at: sessionBody(state).session_expires_at,
    });
  },
  "GET /api/v1/auth/mfa": (route) => json(route, mfaStatus),
  "GET /api/v1/auth/sessions": (route) => json(route, sessions),
  "GET /api/v1/platform/features": (route) => json(route, features),
  "GET /api/v1/devices/overview": (route) => json(route, overview),
  "GET /api/v1/devices/insights": (route) => json(route, insights),
  "GET /api/v1/devices/quick-counts": (route) => json(route, quickCounts),
  "GET /api/v1/devices/": (route, _state, url) => json(route, devicesPage(url)),
  "GET /api/v1/alerts/": (route) => json(route, ALERTS),
  "GET /api/v1/alerts/count": (route) => json(route, alertCount),
  "GET /api/v1/actions/recent": (route) => json(route, recentActions),
  "GET /api/v1/operators": (route) => json(route, OPERATORS),
  "GET /api/v1/operators/presence": (route) => json(route, presence),
  "GET /api/v1/teams/": (route) => json(route, teams),
  "GET /api/v1/clients": (route) => json(route, CLIENTS),
  "GET /api/v1/groups": (route) => json(route, GROUPS),
  "GET /api/v1/audit": (route) => json(route, audit),
  "GET /api/v1/audit/facets": (route) => json(route, auditFacets),
  "GET /api/v1/system/status": (route) => json(route, systemStatus),
  "GET /api/v1/connect-preferences": (route) => json(route, connectPreferences),
  "GET /api/v1/notifications/channels": (route) => json(route, channels),
  "GET /api/v1/notifications/rules": (route) => json(route, rules),
  "GET /api/v1/notifications/deliveries": (route) => json(route, deliveries),
  "POST /api/v1/system/client-errors": (route) => route.fulfill({ status: 204 }),
};

/** Installs the mock API on a page. Returns the mutable state the test can inspect or change. */
export async function mockApi(page: Page, initial: Partial<Omit<MockState, "unhandled">> = {}): Promise<MockState> {
  const state: MockState = { user: OWNER, mfaOnLogin: false, mfaEnrollmentRequired: false, ...initial, unhandled: [] };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const key = `${route.request().method()} ${url.pathname}`;
    const handler = HANDLERS[key];
    if (handler) return handler(route, state, url);
    state.unhandled.push(key);
    return json(route, { detail: "Not mocked" }, 404);
  });
  // No realtime server: the app falls back to polling, as it does when the socket drops.
  await page.routeWebSocket(/\/ws\//, (ws) => ws.close());
  return state;
}
