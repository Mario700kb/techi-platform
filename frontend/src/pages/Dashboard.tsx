import { useCallback, useEffect, useRef, useState } from "react";
import { appCache, CACHE_KEYS, CACHE_TTL } from "../store/appCache";
import {
  AlertTriangle,
  BellRing,
  Building2,
  ChevronRight,
  Clock3,
  Cpu,
  Download,
  HeartPulse,
  Loader2,
  Monitor,
  RefreshCcw,
  ShieldCheck,
  Star,
  Terminal,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import AlertKindIcon from "../components/AlertKindIcon";
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  MeterRow,
  RingLegend,
  RingSegment,
  SegmentRing,
  SubHead,
  percent,
} from "../components/MeterPanels";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Device,
  DeviceFleetOverview,
  FleetInsights,
  FleetRisk,
  getDevices,
  getFleetInsights,
  getFleetRisk,
} from "../api/devices";
import { getAlertQueue } from "../api/alerts";
import { AlertFlowChart, AvailabilityChart } from "../components/InsightCharts";
import { Client, getClients } from "../api/clients";
import SystemStatusCard from "../components/SystemStatusCard";
import { getOperatorPresence, OperatorPresenceRecord } from "../api/operators";
import { useAuth } from "../auth/AuthContext";
import {
  ACTION_STATUS_LABELS,
  actionTypeLabel,
  getRecentActions,
  RemoteActionWithDevice,
  statusColor,
  statusDotColor,
} from "../api/actions";
import {
  AnimatedNumber,
  Button,
  EmptyState,
  PageHeader,
  Select,
  SkeletonRows,
  TablePagination,
} from "../components/ui";
import { formatLocalDateTime, timeAgo } from "../utils/time";
import { formatCount } from "../utils/number";
import { freshnessTone, humanize, TERMS, TONE } from "../utils/deviceStatus";
import { deviceFreshness } from "../utils/devicePresence";
import { DeviceStatusChip } from "../components/DeviceStatusChip";
import { Alert, ALERT_KIND_LABELS, ALERT_SEVERITY_TONE, AlertCount, AlertKind } from "../types/alert";
import { usePollingRefresh } from "../hooks/usePollingRefresh";
import { useNow } from "../hooks/useNow";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";
import { useAppData } from "../contexts/AppDataContext";
import { actionRelevantTime, DASHBOARD_LABELS, DashboardMobile, MobilePanel } from "./DashboardMobile";
import {
  Briefing,
  BriefingItem,
  ClientRow,
  ClientStatusList,
  DashSection,
  DeltaChip,
  HealthRing,
  ScoreTile,
  scoreTone,
  shareOf,
  Sparkline,
  windowDelta,
} from "../components/DashboardWidgets";
import { AgentVersionsCard, SecurityRiskCard, SlaAtRiskCard } from "../components/DashboardPanels";
import { useClientScope } from "../hooks/useClientScope";
import "./Dashboard.css";

// Latest enrollments: the newest 50, shown 10, 20 or 50 to a page.
const RECENT_DEVICES_LIMIT = 50;
const ENROLLMENT_PAGE_SIZES = [10, 20, 50];
// Recent remote actions: the same — the newest 50, 10, 20 or 50 to a page.
const RECENT_ACTIONS_LIMIT = 50;
const ACTION_PAGE_SIZES = [10, 20, 50];
/**
 * Enrollments, actions and operator presence are re-read on this cadence
 * while the page is visible: events keep device rows and actions current, but
 * nothing announces an operator signing in or out.
 */
const ACTIVITY_POLL_MS = 60_000;
/** Without a socket there are no events, so the lists are polled faster. */
const ACTIVITY_POLL_OFFLINE_MS = 30_000;
/** The server recomputes the 30-day trends every 30 minutes. */
const INSIGHTS_REFRESH_MS = 30 * 60_000;
/** A tab hidden at least this long refreshes its lists when shown again. */
const CATCH_UP_AFTER_HIDDEN_MS = 30_000;

// Categories are not states, so their ring uses colours that never mean one.
const CATEGORY_TONES = [TONE.info, TONE.maintenance, "var(--th-accent)", TONE.neutral];

const CATEGORY_FILTERS: Record<string, string> = {
  servers: "/devices?filter=servers",
  clientpc: "/devices?filter=workstations",
};

/** Security and agent-version checks are cached five minutes on the server. */
const RISK_POLL_MS = 5 * 60_000;
/** Deadlines count down in the browser; the list itself is re-read every minute. */
const SLA_POLL_MS = 60_000;
const NO_ALERTS: AlertCount = { total_open: 0, by_severity: {}, by_kind: {}, devices_affected: 0 };

// Header chips sit next to a size="sm" Button, so they share its 32px height.
const HEADER_CHIP = "th-status-chip !h-8";

type ActivitySection = "devices" | "actions" | "operators";

function SectionError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <EmptyState
      className="flex-1"
      icon={<AlertTriangle className="h-5 w-5" />}
      title={`Couldn't load ${what}`}
      description="The server did not respond. Try again."
      action={
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RefreshCcw className="h-3.5 w-3.5" />
          Retry
        </Button>
      }
    />
  );
}

/** "updated just now" / "updated 2m ago" for the header chip. */
function updatedLabel(at: number): string {
  const ago = timeAgo(new Date(at).toISOString());
  return ago === "just now" ? "updated just now" : `updated ${ago}`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  useNow();
  const { user, hasPermission } = useAuth();
  const {
    alertCount: fleetAlertCount,
    alertCountReady: fleetAlertCountReady,
    fleetOverview: fleetWideOverview,
    fleetOverviewLoading,
    lastFetchTime,
    latestEvent,
    realtimeStatus,
    refreshFleetOverview,
    totalOpenAlerts: fleetOpenAlerts,
  } = useAppData();

  // ?client=<id> narrows the dashboard to one client: its profile stands in
  // for the fleet overview, so every card below reads the same fields.
  // Operators and system status stay platform-wide.
  const [searchParams, setSearchParams] = useSearchParams();
  const clientParam = Number(searchParams.get("client"));
  const clientId = Number.isInteger(clientParam) && clientParam > 0 ? clientParam : null;
  const { data: scoped, reload: reloadScoped } = useClientScope(clientId);
  const profile = clientId != null && scoped?.clientId === clientId ? scoped.profile : null;
  const fleetOverview: DeviceFleetOverview | null =
    clientId == null
      ? fleetWideOverview
      : profile
        ? {
            stats: profile.stats,
            tree_counts: {
              total: profile.stats.total,
              unassigned: 0,
              by_client: { [clientId]: profile.stats.total },
              by_category: profile.by_category,
              by_client_status: { [clientId]: profile.stats },
            },
            critical: profile.health_critical,
            warnings: profile.health_warning,
            average_health: profile.average_health,
            needs_updates: profile.needs_updates,
            agents_outdated: profile.agents_outdated,
            active_agent_version: fleetWideOverview?.active_agent_version ?? null,
            active_agent_sha256: fleetWideOverview?.active_agent_sha256 ?? null,
            active_agent_versions: fleetWideOverview?.active_agent_versions,
            loaded_at: fleetWideOverview?.loaded_at ?? new Date().toISOString(),
          }
        : null;
  const alertCount = clientId == null ? fleetAlertCount : (profile?.alerts ?? NO_ALERTS);
  const alertCountReady = clientId == null ? fleetAlertCountReady : profile != null;
  const totalOpenAlerts = clientId == null ? fleetOpenAlerts : (profile?.alerts.total_open ?? 0);
  const selectClient = (id: number | null) => {
    const next = new URLSearchParams(searchParams);
    if (id == null) next.delete("client");
    else next.set("client", String(id));
    setSearchParams(next, { replace: true });
  };

  const stats = fleetOverview?.stats ?? { total: 0, online: 0, stale: 0, offline: 0 };
  const total = stats.total;
  const online = stats.online;
  const stale = stats.stale;
  const offline = stats.offline;
  const averageHealth = fleetOverview?.average_health ?? null;
  const patchCount = fleetOverview?.needs_updates ?? 0;
  const criticalCount = fleetOverview?.critical ?? 0;
  const loading = clientId == null ? fleetOverviewLoading && fleetOverview === null : profile === null;
  const [allRecentDevices, setRecentDevices] = useState<Device[]>(
    () => appCache.peek<Device[]>(CACHE_KEYS.dashboardRecentDevices) ?? [],
  );
  // Mirrors recentDevices so realtime events can patch it without a stale closure.
  const recentDevicesRef = useRef(allRecentDevices);
  const [enrollmentPage, setEnrollmentPage] = useState(1);
  const [enrollmentPageSize, setEnrollmentPageSize] = useState(ENROLLMENT_PAGE_SIZES[0]);
  const [actionPage, setActionPage] = useState(1);
  const [actionPageSize, setActionPageSize] = useState(ACTION_PAGE_SIZES[0]);
  const [allRecentActions, setRecentActions] = useState<RemoteActionWithDevice[]>(
    () => appCache.peek<RemoteActionWithDevice[]>(CACHE_KEYS.recentActions) ?? [],
  );
  const [operators, setOperators] = useState<OperatorPresenceRecord[]>(
    () => appCache.peek<OperatorPresenceRecord[]>(CACHE_KEYS.operatorPresence) ?? [],
  );
  const [clients, setClients] = useState<Client[]>(() => appCache.peek<Client[]>(CACHE_KEYS.clientsList) ?? []);
  const clientNames: Record<number, string> = Object.fromEntries(clients.map((c) => [c.id, c.name]));
  useEffect(() => {
    getClients()
      .then(setClients)
      .catch(() => undefined);
  }, []);
  // Trends are kept per user, so returning to the dashboard shows the last
  // result at once while a fresh one loads.
  const insightsKey = `${CACHE_KEYS.dashboardInsights}.${user?.id ?? "anon"}`;
  const [allInsights, setInsights] = useState<FleetInsights | null>(() => appCache.peek<FleetInsights>(insightsKey));
  const [allInsightsFailed, setInsightsFailed] = useState(false);
  const insightsLoadedAt = useRef(0);
  const loadInsights = useCallback(() => {
    setInsightsFailed(false);
    getFleetInsights(30)
      .then((data) => {
        appCache.set(insightsKey, data);
        insightsLoadedAt.current = Date.now();
        setInsights(data);
      })
      .catch(() => setInsightsFailed(true));
  }, [insightsKey]);
  const refreshStaleInsights = useCallback(() => {
    if (Date.now() - insightsLoadedAt.current >= INSIGHTS_REFRESH_MS) loadInsights();
  }, [loadInsights]);
  useEffect(() => {
    loadInsights();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshStaleInsights();
    }, INSIGHTS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [loadInsights, refreshStaleInsights]);
  const [favoritesCount] = useState(() => {
    try {
      const raw = localStorage.getItem("techi.favorites");
      return raw ? (JSON.parse(raw) as number[]).length : 0;
    } catch {
      return 0;
    }
  });
  const [failed, setFailed] = useState<Record<ActivitySection, boolean>>({
    devices: false,
    actions: false,
    operators: false,
  });
  const [fleetActivityReady, setActivityReady] = useState(
    () => appCache.peek(CACHE_KEYS.dashboardRecentDevices) !== null,
  );

  /** Loads the sections whose cached copy is older than its TTL (or than maxAgeMs, if shorter). */
  const loadDashboard = useCallback(async (maxAgeMs = Infinity) => {
    const fresh = (key: string, ttl: number) => appCache.get(key, Math.min(ttl, maxAgeMs)) !== null;
    const devicesFresh = fresh(CACHE_KEYS.dashboardRecentDevices, CACHE_TTL.dashboardRecentDevices);
    const actionsFresh = fresh(CACHE_KEYS.recentActions, CACHE_TTL.recentActions);
    const presenceFresh = fresh(CACHE_KEYS.operatorPresence, CACHE_TTL.operatorPresence);

    if (devicesFresh && actionsFresh && presenceFresh) {
      setActivityReady(true);
      return;
    }

    // Each section shows as soon as its own request returns, not when the
    // slowest of the three does.
    const [devicesResult, actionsResult, presenceResult] = await Promise.allSettled([
      devicesFresh
        ? Promise.resolve(null)
        : getDevices({}, 0, RECENT_DEVICES_LIMIT).then((value) => {
            appCache.set(CACHE_KEYS.dashboardRecentDevices, value.devices);
            recentDevicesRef.current = value.devices;
            setRecentDevices(value.devices);
          }),
      actionsFresh
        ? Promise.resolve(null)
        : getRecentActions(RECENT_ACTIONS_LIMIT).then((value) => {
            appCache.set(CACHE_KEYS.recentActions, value);
            setRecentActions(value);
          }),
      presenceFresh
        ? Promise.resolve(null)
        : getOperatorPresence().then((value) => {
            appCache.set(CACHE_KEYS.operatorPresence, value);
            setOperators(value);
          }),
    ]);
    setFailed({
      devices: devicesResult.status === "rejected",
      actions: actionsResult.status === "rejected",
      operators: presenceResult.status === "rejected",
    });
    setActivityReady(true);
  }, []);

  const enrollmentReload = useRef(false);
  const patchRecentDevice = useCallback(
    (event: DeviceRealtimeEvent) => {
      const eventDevice = event.data;
      if (!eventDevice?.id) return;
      const items = recentDevicesRef.current;
      // Until the first list arrives there is nothing to patch or compare with.
      if (items.length === 0) return;
      const index = items.findIndex((item) => item.id === eventDevice.id);
      if (index >= 0) {
        const next = [...items];
        next[index] = { ...items[index], ...eventDevice } as Device;
        recentDevicesRef.current = next;
        setRecentDevices(next);
        return;
      }
      // The list is newest enrollment first and ids only grow, so a device
      // newer than every row is one that has just enrolled: re-read the list.
      const newest = items.reduce((max, item) => Math.max(max, item.id), 0);
      if (eventDevice.id > newest && !enrollmentReload.current) {
        enrollmentReload.current = true;
        appCache.invalidate(CACHE_KEYS.dashboardRecentDevices);
        void loadDashboard().finally(() => {
          enrollmentReload.current = false;
        });
      }
    },
    [loadDashboard],
  );

  const patchRecentAction = useCallback((event: DeviceRealtimeEvent) => {
    if (event.type !== "action_queued" && event.type !== "action_status_changed") return;
    const action = event.data;
    if (!action?.id || !action.device_id || !action.action_type || !action.status || !action.created_at) return;
    const nextAction = {
      id: action.id,
      device_id: action.device_id,
      action_type: action.action_type,
      status: action.status,
      created_at: action.created_at,
      created_by: action.created_by ?? null,
      queued_at: action.queued_at ?? null,
      sent_at: action.sent_at ?? null,
      acknowledged_at: action.acknowledged_at ?? null,
      started_at: action.started_at ?? null,
      completed_at: action.completed_at ?? null,
      failed_at: action.failed_at ?? null,
      cancelled_at: action.cancelled_at ?? null,
      expired_at: action.expired_at ?? null,
      result_message: action.result_message ?? null,
      error_message: action.error_message ?? null,
      execution_timeout_seconds: action.execution_timeout_seconds ?? 0,
    } as RemoteActionWithDevice;
    setRecentActions((items) => {
      const index = items.findIndex((item) => item.id === nextAction.id);
      if (index >= 0) {
        const next = [...items];
        next[index] = { ...items[index], ...nextAction };
        return next;
      }
      return [nextAction, ...items].slice(0, 10);
    });
  }, []);

  useEffect(() => {
    const event = latestEvent;
    if (!event || event.type === "connection_ready") return;
    patchRecentAction(event);
    if (
      event.type === "device_online" ||
      event.type === "device_offline" ||
      event.type === "device_updated" ||
      event.type === "heartbeat_received" ||
      event.type === "rustdesk_updated" ||
      event.type === "rustdesk_online" ||
      event.type === "rustdesk_offline" ||
      event.type === "sync_failed" ||
      event.type === "telemetry_updated" ||
      event.type === "health_warning" ||
      event.type === "health_critical" ||
      event.type === "health_recovered"
    ) {
      patchRecentDevice(event);
    }
  }, [latestEvent, patchRecentAction, patchRecentDevice]);

  const activityPollMs = realtimeStatus === "connected" ? ACTIVITY_POLL_MS : ACTIVITY_POLL_OFFLINE_MS;
  const pollDashboard = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    // Half the interval: each tick re-reads every section, a fresh cache
    // left by another page included.
    await loadDashboard(activityPollMs / 2);
  }, [activityPollMs, loadDashboard]);
  const { runNow: refreshDashboard } = usePollingRefresh(pollDashboard, {
    intervalMs: activityPollMs,
    immediate: false,
  });

  // The first load uses whatever is still fresh in the cache.
  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  // Coming back to a tab that was hidden a while: re-read the lists and, when
  // stale, the trends (the overview and alerts catch up in AppDataContext).
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt >= CATCH_UP_AFTER_HIDDEN_MS) {
        void refreshDashboard();
        refreshStaleInsights();
      }
      hiddenAt = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshDashboard, refreshStaleInsights]);

  const retryFleetActivity = useCallback(() => {
    setActivityReady(false);
    void refreshDashboard();
  }, [refreshDashboard]);

  // With a client chosen, the lists and trends are that client's.
  const scopedReady = clientId != null && scoped?.clientId === clientId;
  const recentDevices = clientId == null ? allRecentDevices : (scopedReady && scoped.devices) || [];
  const recentActions = clientId == null ? allRecentActions : (scopedReady && scoped.actions) || [];
  const insights = clientId == null ? allInsights : scopedReady ? scoped.insights : null;
  const insightsFailed = clientId == null ? allInsightsFailed : scopedReady && scoped.failed.insights;
  const activityReady =
    clientId == null
      ? fleetActivityReady
      : scopedReady &&
        (scoped.devices != null || scoped.failed.devices) &&
        (scoped.actions != null || scoped.failed.actions);
  const shownFailed =
    clientId == null
      ? failed
      : {
          devices: scopedReady && scoped.failed.devices,
          actions: scopedReady && scoped.failed.actions,
          operators: failed.operators,
        };
  const retryActivity = clientId == null ? retryFleetActivity : reloadScoped;
  const retryInsights = clientId == null ? loadInsights : reloadScoped;

  // Security & risk and agent versions: fleet-wide or for the chosen client.
  const clientIdRef = useRef(clientId);
  const [risk, setRisk] = useState<FleetRisk | null>(null);
  const [riskFailed, setRiskFailed] = useState(false);
  const loadRisk = useCallback(() => {
    setRiskFailed(false);
    const forClient = clientId;
    getFleetRisk(forClient ?? undefined)
      .then((data) => {
        if (forClient === clientIdRef.current) setRisk(data);
      })
      .catch(() => {
        if (forClient === clientIdRef.current) setRiskFailed(true);
      });
  }, [clientId]);
  // SLA at risk: open alerts with a running deadline, and how many are overdue.
  const [sla, setSla] = useState<{ alerts: Alert[] | null; overdue: number; failed: boolean }>({
    alerts: null,
    overdue: 0,
    failed: false,
  });
  const loadSla = useCallback(() => {
    const forClient = clientId ?? undefined;
    Promise.all([
      getAlertQueue({ view: "open", clientId: forClient, limit: 40 }),
      getAlertQueue({ view: "overdue", clientId: forClient, limit: 1 }),
    ])
      .then(([open, overdue]) => {
        if ((forClient ?? null) === clientIdRef.current)
          setSla({ alerts: open.items, overdue: overdue.total, failed: false });
      })
      .catch(() => {
        if ((forClient ?? null) === clientIdRef.current) setSla((prev) => ({ ...prev, failed: true }));
      });
  }, [clientId]);
  useEffect(() => {
    clientIdRef.current = clientId;
    setRisk(null);
    setSla({ alerts: null, overdue: 0, failed: false });
    loadRisk();
    loadSla();
    const riskTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") loadRisk();
    }, RISK_POLL_MS);
    const slaTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") loadSla();
    }, SLA_POLL_MS);
    return () => {
      window.clearInterval(riskTimer);
      window.clearInterval(slaTimer);
    };
  }, [clientId, loadRisk, loadSla]);

  const availability = total > 0 ? Math.round((online / total) * 100) : 0;
  const onlinePct = total > 0 ? (online / total) * 100 : 0;
  const stalePct = total > 0 ? (stale / total) * 100 : 0;
  const offlinePct = total > 0 ? (offline / total) * 100 : 0;
  const health =
    averageHealth == null
      ? { label: "No score", tone: TONE.neutral }
      : averageHealth < 50
        ? { label: "Critical", tone: TONE.critical }
        : averageHealth < 80
          ? { label: "Warning", tone: TONE.warning }
          : { label: "Healthy", tone: TONE.online };
  const canManageOperators = hasPermission("manage_operators");
  // System status is for owner and admin only (the API enforces it too).
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const onlineOperators = operators.filter((op) => op.is_online);
  const alertsByKind = Object.entries(alertCount.by_kind ?? {})
    .filter(([, count]) => count > 0)
    .sort(([, x], [, y]) => y - x);
  const severitySegments: RingSegment[] = (["critical", "warning", "info"] as const).map((severity) => ({
    key: severity,
    label: humanize(severity),
    value: alertCount.by_severity?.[severity] ?? 0,
    tone: ALERT_SEVERITY_TONE[severity],
  }));
  const devicesByCategory = Object.entries(fleetOverview?.tree_counts.by_category ?? {})
    .filter(([, counts]) => counts.total > 0)
    .sort(([, x], [, y]) => y.total - x.total);
  // Fleet health already splits the fleet by status; this ring splits it by category.
  const categorySegments: RingSegment[] = devicesByCategory.map(([category, counts], index) => ({
    key: category,
    label: CATEGORY_LABELS[category] ?? humanize(category),
    value: counts.total,
    tone: CATEGORY_TONES[index % CATEGORY_TONES.length],
  }));
  const clientStatus = fleetOverview?.tree_counts.by_client_status ?? {};
  const clientCount = Object.keys(fleetOverview?.tree_counts.by_client ?? {}).length;
  const groupCount = profile?.groups.length ?? 0;
  const clientName = clientId != null ? (profile?.client.name ?? clientNames[clientId] ?? `Client #${clientId}`) : null;
  const clientBreakdown: ClientRow[] = (() => {
    if (clientId != null) {
      // One client: its groups, each opening the client's folder.
      return [...(profile?.groups ?? [])]
        .filter((group) => group.devices > 0)
        .sort((a, b) => b.devices - a.devices)
        .map((group) => ({
          id: `g${group.id}`,
          name: group.name,
          count: group.devices,
          to: `/devices?folder=client-${clientId}`,
        }));
    }
    const byClient = fleetOverview?.tree_counts.by_client ?? {};
    const rows: ClientRow[] = Object.entries(byClient)
      .map(([id, count]) => ({
        id,
        name: clientNames[Number(id)] ?? `Client #${id}`,
        count,
        ...(clientStatus[id]
          ? { online: clientStatus[id].online, stale: clientStatus[id].stale, offline: clientStatus[id].offline }
          : {}),
      }))
      .sort((a, b) => b.count - a.count);
    const top = rows.slice(0, 6);
    const others = rows.slice(6);
    const sumOthers = (pick: (row: ClientRow) => number) => others.reduce((sum, row) => sum + pick(row), 0);
    const rest = sumOthers((row) => row.count);
    // The other clients' bar tells their status too, as long as every one of them reports it.
    const othersStatus = others.every((row) => row.online != null)
      ? {
          online: sumOthers((row) => row.online ?? 0),
          stale: sumOthers((row) => row.stale ?? 0),
          offline: sumOthers((row) => row.offline ?? 0),
        }
      : {};
    const unassigned = fleetOverview?.tree_counts.unassigned ?? 0;
    return [
      ...top,
      ...(rest > 0 ? [{ id: "other", name: `${rows.length - 6} more clients`, count: rest, ...othersStatus }] : []),
      ...(unassigned > 0 ? [{ id: "none", name: TERMS.noClient, count: unassigned }] : []),
    ];
  })();

  const agentsOutdated = fleetOverview?.agents_outdated ?? 0;
  const activeAgentVersion = fleetOverview?.active_agent_version ?? null;
  const availabilityValues = insights?.availability.series.map((day) => day.availability_pct) ?? [];
  const availabilityDelta = windowDelta(availabilityValues, 7);
  const criticalAlerts = alertCount.by_severity?.critical ?? 0;

  const firstName = (user?.display_name ?? user?.username ?? "").split(" ")[0];
  const hour = new Date().getHours();
  const greeting = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}${firstName ? `, ${firstName}` : ""}`;

  // The briefing names what deserves a look first, most urgent first.
  const briefing: BriefingItem[] = [
    criticalCount > 0 && {
      key: "critical",
      text: `${formatCount(criticalCount)} ${criticalCount === 1 ? "device" : "devices"} in critical health`,
      tone: TONE.critical,
      to: "/devices?filter=critical",
    },
    totalOpenAlerts > 0 && {
      key: "alerts",
      text:
        `${formatCount(totalOpenAlerts)} open ${totalOpenAlerts === 1 ? "alert" : "alerts"}` +
        (criticalAlerts > 0 ? `, ${formatCount(criticalAlerts)} critical` : ""),
      tone: criticalAlerts > 0 ? TONE.critical : TONE.warning,
      to: "/alerts",
    },
    offline > 0 && {
      key: "offline",
      text: `${formatCount(offline)} not responding`,
      tone: TONE.offline,
      to: "/devices?filter=offline",
    },
    agentsOutdated > 0 && {
      key: "agents",
      text: `${formatCount(agentsOutdated)} ${agentsOutdated === 1 ? "agent" : "agents"} behind${activeAgentVersion ? ` ${activeAgentVersion}` : ""}`,
      tone: "var(--th-status-agent)",
      to: "/devices?filter=needs_agent_update",
    },
    patchCount > 0 && {
      key: "patches",
      text: `${formatCount(patchCount)} with patches waiting`,
      tone: TONE.warning,
      to: "/devices?filter=needs_updates",
    },
  ].filter((item): item is BriefingItem => Boolean(item));
  if (briefing.length === 0 && total > 0) {
    briefing.push({ key: "clear", text: "All clear: nothing needs attention", tone: TONE.online, to: "/devices" });
  }

  const kpis = [
    {
      to: "/devices",
      label: "All devices",
      value: total,
      tone: TONE.neutral,
      hint: "Managed endpoints",
      icon: Monitor,
      share: total > 0 ? 100 : 0,
    },
    {
      to: "/devices?filter=online",
      label: "Online",
      value: online,
      tone: TONE.online,
      hint: `${availability}% available`,
      icon: Wifi,
      share: onlinePct,
    },
    {
      to: "/devices?filter=stale",
      label: "Stale",
      value: stale,
      tone: TONE.stale,
      hint: "Heartbeat 6–25 min ago",
      icon: Clock3,
      share: stalePct,
    },
    {
      to: "/devices?filter=offline",
      label: "Offline",
      value: offline,
      tone: TONE.offline,
      hint: "Not responding",
      icon: WifiOff,
      share: offlinePct,
    },
    {
      to: "/devices?filter=critical",
      label: "Critical health",
      value: criticalCount,
      tone: TONE.critical,
      hint: "Health score below 50",
      icon: HeartPulse,
      share: shareOf(criticalCount, total) ?? 0,
    },
    {
      to: "/devices?filter=needs_updates",
      label: DASHBOARD_LABELS.needsUpdates,
      value: patchCount,
      tone: TONE.warning,
      hint: "Pending patches",
      icon: Download,
      share: shareOf(patchCount, total) ?? 0,
    },
  ];

  const patchCompliance = shareOf(Math.max(0, total - patchCount), total);
  const agentCurrency = shareOf(Math.max(0, total - agentsOutdated), total);
  const alertDays = insights?.alerts.days ?? 7;
  const resolution =
    insights && insights.alerts.opened_total > 0
      ? Math.min(100, (insights.alerts.resolved_total / insights.alerts.opened_total) * 100)
      : null;
  const pctLabel = (value: number | null, digits = 0) => (value == null ? "—" : `${value.toFixed(digits)}%`);
  const scorecard = [
    {
      label: "Availability",
      value: insights?.availability.overall_pct ?? null,
      display: pctLabel(insights?.availability.overall_pct ?? null, 2),
      caption: "Online, last 30 days",
      tone: scoreTone(insights?.availability.overall_pct ?? null, 99, 95),
      to: "/devices?filter=offline",
    },
    {
      label: "Average health",
      value: loading ? null : averageHealth,
      display: loading || averageHealth == null ? "—" : `${averageHealth} / 100`,
      caption: `${formatCount(criticalCount)} critical · ${formatCount(fleetOverview?.warnings ?? 0)} warning`,
      tone: scoreTone(loading ? null : averageHealth, 80, 50),
      to: "/devices?filter=critical",
    },
    {
      label: "Patch compliance",
      value: loading ? null : patchCompliance,
      display: loading ? "—" : pctLabel(patchCompliance),
      caption: "No patch waiting",
      tone: scoreTone(loading ? null : patchCompliance, 90, 70),
      to: "/devices?filter=needs_updates",
    },
    {
      label: "Agent currency",
      value: loading ? null : agentCurrency,
      display: loading ? "—" : pctLabel(agentCurrency),
      caption: activeAgentVersion ? `On active agent ${activeAgentVersion}` : "On the active agent",
      tone: scoreTone(loading ? null : agentCurrency, 90, 70),
      to: "/devices?filter=needs_agent_update",
    },
    {
      label: "Alert resolution",
      value: resolution,
      display: insights ? pctLabel(resolution) : "—",
      caption: `Resolved / opened · ${alertDays} d`,
      tone: scoreTone(resolution, 90, 70),
      to: "/alerts",
    },
  ];

  const clientPicker = (className: string) => (
    <Select
      value={clientId != null ? String(clientId) : "all"}
      onChange={(value) => selectClient(value === "all" ? null : Number(value))}
      aria-label="Show the dashboard for"
      className={className}
      options={[
        { value: "all", label: "All clients" },
        ...[...clients]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => ({ value: String(c.id), label: c.name })),
        ...(clientId != null && !clients.some((c) => c.id === clientId)
          ? [{ value: String(clientId), label: clientName ?? `Client #${clientId}` }]
          : []),
      ]}
    />
  );

  // Shared by the desktop cards and the mobile insights.
  const alertBreakdown = (
    <>
      <div className="th-cp-hero">
        <SegmentRing
          segments={severitySegments}
          total={totalOpenAlerts}
          center={formatCount(totalOpenAlerts)}
          caption={totalOpenAlerts === 1 ? "open alert" : "open alerts"}
          size={108}
        />
        <RingLegend segments={severitySegments} total={totalOpenAlerts} onSelect={() => navigate("/alerts")} />
      </div>
      <SubHead>By type</SubHead>
      <ul className="th-cp-meters" data-dense="true">
        {alertsByKind.map(([kind, count], index) => (
          <MeterRow
            key={kind}
            index={index}
            mark={
              <span className="th-cp-mark-sm" aria-hidden="true">
                <AlertKindIcon kind={kind as AlertKind} className="h-3.5 w-3.5" />
              </span>
            }
            label={ALERT_KIND_LABELS[kind as AlertKind] ?? humanize(kind)}
            count={count}
            total={totalOpenAlerts}
            tone={TONE.warning}
            to="/alerts"
          />
        ))}
      </ul>
    </>
  );
  const categoryBreakdown = (
    <>
      <div className="th-cp-hero">
        <SegmentRing
          segments={categorySegments}
          total={total}
          center={formatCount(total)}
          caption="devices"
          size={108}
        />
        <RingLegend
          segments={categorySegments}
          total={total}
          onSelect={(key) => navigate(CATEGORY_FILTERS[key] ?? "/devices")}
        />
      </div>
      <SubHead>Online by category</SubHead>
      <ul className="th-cp-meters" data-dense="true">
        {devicesByCategory.map(([category, counts], index) => {
          const Icon = CATEGORY_ICONS[category] ?? Monitor;
          return (
            <MeterRow
              key={category}
              index={index}
              mark={
                <span className="th-cp-mark-sm" aria-hidden="true">
                  <Icon className="h-3.5 w-3.5" />
                </span>
              }
              label={CATEGORY_LABELS[category] ?? humanize(category)}
              count={counts.online}
              total={counts.total}
              share={percent(counts.online, counts.total)}
              segments={[
                { key: "online", label: "online", value: counts.online, tone: TONE.online },
                { key: "stale", label: "stale", value: counts.stale, tone: TONE.stale },
                { key: "offline", label: "offline", value: counts.offline, tone: TONE.offline },
              ]}
              title={`${formatCount(counts.online)} online · ${formatCount(counts.stale)} stale · ${formatCount(counts.offline)} offline of ${formatCount(counts.total)}`}
              to={CATEGORY_FILTERS[category] ?? "/devices"}
            />
          );
        })}
      </ul>
    </>
  );
  const clientBreakdownFoot =
    clientId != null
      ? `${formatCount(groupCount)} ${groupCount === 1 ? "group" : "groups"} · bar length is the share of the client's devices.`
      : `${formatCount(clientCount)} ${clientCount === 1 ? "client" : "clients"} · bar length is the share of the fleet, colours its status.`;
  const alertTrendFigures = (
    <div className="mb-3 grid grid-cols-3 gap-3">
      {(
        [
          ["Opened", insights ? formatCount(insights.alerts.opened_total) : undefined],
          ["Resolved", insights ? formatCount(insights.alerts.resolved_total) : undefined],
          [
            "Avg. time to resolve",
            insights?.alerts.mean_time_to_resolve_hours != null
              ? `${insights.alerts.mean_time_to_resolve_hours} h`
              : undefined,
          ],
        ] as const
      ).map(([label, value]) => (
        <div key={label}>
          <p className="th-metric-big">{value ?? "—"}</p>
          <p className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
            {label}
          </p>
        </div>
      ))}
    </div>
  );
  const problemDeviceRows = (
    <ul className="flex-1 px-2 pb-2">
      {insights?.problem_devices.map((d, i) => (
        <li key={d.device_id}>
          <Link to={`/devices?device=${d.device_id}`} className="th-list-row">
            <span
              className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-[12px] font-semibold tabular-nums"
              style={{ background: "var(--th-chip-bg)", color: "var(--th-text-muted)" }}
            >
              {i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
                {d.name}
              </span>
              <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                {d.client_name ?? TERMS.noClient}
              </span>
            </span>
            <span
              className="text-right text-[12px] leading-5 tabular-nums"
              style={{ color: "var(--th-text-secondary)" }}
            >
              <span className="block">
                <strong className="font-semibold" style={{ color: "var(--th-text-primary)" }}>
                  {formatCount(d.offline_events)}
                </strong>{" "}
                offline
              </span>
              <span className="block">
                <strong className="font-semibold" style={{ color: "var(--th-text-primary)" }}>
                  {formatCount(d.alerts)}
                </strong>{" "}
                alerts
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
  const enrollmentRow = (device: Device, index: number) => {
    const tone = freshnessTone(deviceFreshness(device));
    return (
      <li key={device.id} className="th-share-row" style={{ "--i": Math.min(index, 12) } as React.CSSProperties}>
        <Link to={`/devices?device=${device.id}`} className="th-list-row">
          <span className="th-palette-icon !h-8 !w-8">
            <Monitor className="h-4 w-4" />
            <i style={{ background: tone }} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
              {device.hostname || "Unknown"}
            </span>
            <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              {[device.client_name || TERMS.noClient, device.current_user, device.public_ip]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          <span className="text-right">
            <DeviceStatusChip device={device} />
            <span className="mt-0.5 block text-[11px] tabular-nums" style={{ color: "var(--th-text-faint)" }}>
              {formatLocalDateTime(device.registered_at)}
            </span>
          </span>
        </Link>
      </li>
    );
  };

  // On a phone every other analysis waits behind a tap; each renders only when opened.
  const flaggedChecks = risk?.checks.filter((check) => check.count > 0).length ?? 0;
  const newestDevice = recentDevices[0]?.hostname;
  const quietLine = (text: string) => (
    <p className="th-mcard-note" style={{ paddingBottom: 8 }}>
      {text}
    </p>
  );
  const insightOr = (ready: () => React.ReactNode, what: string) =>
    insights ? (
      ready()
    ) : insightsFailed ? (
      <SectionError what={what} onRetry={retryInsights} />
    ) : (
      <SkeletonRows rows={3} />
    );
  const mobilePanels: MobilePanel[] = [
    {
      key: "alerts",
      title: "Alerts by type",
      summary: !alertCountReady
        ? "Loading…"
        : totalOpenAlerts === 0
          ? "No open alerts"
          : `${formatCount(totalOpenAlerts)} open${alertCount.devices_affected ? ` on ${formatCount(alertCount.devices_affected)} devices` : ""}`,
      icon: BellRing,
      tone: totalOpenAlerts > 0 ? TONE.warning : TONE.neutral,
      render: () => (alertsByKind.length > 0 ? alertBreakdown : quietLine("Every alert has been resolved.")),
    },
    {
      key: "risk",
      title: "Security & risk",
      summary: !risk
        ? riskFailed
          ? "Couldn't load the checks"
          : "Loading…"
        : `${flaggedChecks} of ${risk.checks.length} checks flagged${risk.security.average_score != null ? ` · score ${Math.round(risk.security.average_score)}` : ""}`,
      icon: ShieldCheck,
      tone: flaggedChecks > 0 ? TONE.warning : TONE.online,
      render: () => <SecurityRiskCard risk={risk} failed={riskFailed} onRetry={loadRisk} />,
    },
    {
      key: "agents",
      title: "Agent versions",
      summary:
        agentsOutdated > 0
          ? `${formatCount(agentsOutdated)} behind${activeAgentVersion ? ` ${activeAgentVersion}` : ""}`
          : "All on the active agent",
      icon: Cpu,
      tone: "var(--th-status-agent)",
      render: () => (
        <AgentVersionsCard
          risk={risk}
          failed={riskFailed}
          onRetry={loadRisk}
          activeWindows={activeAgentVersion}
          activeLinux={[...new Set(Object.values(fleetOverview?.active_agent_versions ?? {}))]}
        />
      ),
    },
    {
      key: "clients",
      title: clientId != null ? "Groups" : "Clients",
      summary:
        clientId != null
          ? `${formatCount(groupCount)} ${groupCount === 1 ? "group" : "groups"}`
          : `${formatCount(clientCount)} ${clientCount === 1 ? "client" : "clients"} · status of each`,
      icon: Building2,
      tone: TONE.info,
      render: () =>
        clientBreakdown.length > 0 ? (
          <>
            <div className="th-mpanel-pad">
              <ClientStatusList rows={clientBreakdown} total={total} />
            </div>
            <p className="th-panel-foot">{clientBreakdownFoot}</p>
          </>
        ) : (
          quietLine("Devices are grouped here by client once they enroll.")
        ),
    },
    {
      key: "categories",
      title: "Device categories",
      summary: devicesByCategory
        .slice(0, 2)
        .map(([category, counts]) => `${formatCount(counts.total)} ${CATEGORY_LABELS[category] ?? humanize(category)}`)
        .join(" · "),
      icon: Monitor,
      tone: TONE.maintenance,
      render: () => (devicesByCategory.length > 0 ? categoryBreakdown : quietLine("No devices to group.")),
    },
    {
      key: "availability",
      title: "Availability trend",
      summary:
        insights?.availability.overall_pct != null
          ? `${insights.availability.overall_pct.toFixed(2)}% over 30 days`
          : "Last 30 days",
      icon: Wifi,
      tone: TONE.online,
      render: () => (
        <div className="th-mpanel-pad">
          {insightOr(() => insights && <AvailabilityChart series={insights.availability.series} />, "availability")}
        </div>
      ),
    },
    {
      key: "alert-trend",
      title: "Alerts this week",
      summary: insights
        ? `${formatCount(insights.alerts.opened_total)} opened · ${formatCount(insights.alerts.resolved_total)} resolved`
        : "Opened against resolved",
      icon: Clock3,
      tone: TONE.warning,
      render: () => (
        <div className="th-mpanel-pad">
          {alertTrendFigures}
          {insightOr(() => insights && <AlertFlowChart series={insights.alerts.series} />, "alert trends")}
        </div>
      ),
    },
    {
      key: "problem-devices",
      title: "Problem devices",
      summary: insights
        ? insights.problem_devices.length > 0
          ? `${formatCount(insights.problem_devices.length)} ${insights.problem_devices.length === 1 ? "device" : "devices"} · last 7 days`
          : "None this week"
        : "Last 7 days",
      icon: HeartPulse,
      tone: TONE.critical,
      render: () =>
        insightOr(
          () => (insights?.problem_devices.length ? problemDeviceRows : quietLine("No device went offline this week.")),
          "problem devices",
        ),
    },
    {
      key: "enrollments",
      title: "Latest enrollments",
      summary: newestDevice ? `Latest: ${newestDevice}` : "Latest enrollments",
      icon: Download,
      tone: TONE.online,
      render: () =>
        recentDevices.length > 0 ? (
          <ul className="th-menroll px-2">{recentDevices.slice(0, 5).map(enrollmentRow)}</ul>
        ) : (
          quietLine(shownFailed.devices ? "Couldn't load devices." : "Enrolled devices appear here.")
        ),
    },
    {
      key: "team",
      title: "Who's online",
      summary: `${formatCount(onlineOperators.length)} online · ${formatCount(operators.length)} in the team`,
      icon: Users,
      tone: TONE.info,
      render: () => (
        <OperatorsPanel
          operators={operators}
          loading={operators.length === 0 && !activityReady}
          failed={shownFailed.operators}
          onRetry={retryActivity}
          currentUserId={user?.id}
          canManage={canManageOperators}
        />
      ),
    },
    ...(isAdmin
      ? [
          {
            key: "system",
            title: "System status",
            summary: "Services, API and realtime",
            icon: Terminal,
            tone: TONE.neutral,
            render: () => <SystemStatusCard compact />,
          },
        ]
      : []),
  ];

  return (
    <section className="premium-page space-y-5">
      {/* Mobile dashboard — shown only below md (768px) */}
      <div className="md:hidden">
        <DashboardMobile
          total={total}
          online={online}
          stale={stale}
          offline={offline}
          criticalCount={criticalCount}
          patchCount={patchCount}
          alertsTotal={totalOpenAlerts}
          agentsOutdated={fleetOverview?.agents_outdated ?? 0}
          actions={recentActions}
          actionsLoading={recentActions.length === 0 && !activityReady}
          loading={loading}
          greeting={greeting}
          clientName={clientName}
          clientPicker={clientPicker("th-mdash-client-picker")}
          averageHealth={averageHealth}
          health={health}
          availabilityPct={insights?.availability.overall_pct ?? null}
          availabilityValues={availabilityValues}
          availabilityDelta={availabilityDelta}
          briefing={briefing}
          scorecard={scorecard}
          sla={sla}
          panels={mobilePanels}
        />
      </div>

      {/* Desktop dashboard — shown only at md+ (768px) */}
      <div className="th-dash hidden md:block">
        <PageHeader
          title="Dashboard"
          description={
            clientName
              ? `${clientName}: health, open issues and recent activity. Operators and system status are platform-wide.`
              : "Fleet health, open issues and recent activity across all clients."
          }
          actions={
            <>
              {clientPicker("th-dash-client-picker")}
              {onlineOperators.length > 0 &&
                (() => {
                  const content = (
                    <>
                      <Users className="h-3.5 w-3.5" style={{ color: "var(--th-text-muted)" }} />
                      {formatCount(onlineOperators.length)} {onlineOperators.length === 1 ? "operator" : "operators"}{" "}
                      online
                    </>
                  );
                  const title = onlineOperators.map((op) => op.display_name ?? op.username).join(", ");
                  return canManageOperators ? (
                    <Link to="/operators" className={HEADER_CHIP} title={title}>
                      {content}
                    </Link>
                  ) : (
                    <span className={HEADER_CHIP} title={title}>
                      {content}
                    </span>
                  );
                })()}
              <span
                className={HEADER_CHIP}
                style={
                  { "--chip-tone": realtimeStatus === "connected" ? TONE.online : TONE.warning } as React.CSSProperties
                }
                title={
                  (realtimeStatus === "connected"
                    ? "Live updates over WebSocket"
                    : "WebSocket unavailable, refreshing every 30 s") +
                  (lastFetchTime
                    ? ` · fleet counts updated ${formatLocalDateTime(new Date(lastFetchTime).toISOString())}`
                    : "")
                }
              >
                <i />
                {realtimeStatus === "connected" ? "Live" : "Polling"}
                {lastFetchTime && (
                  <span style={{ color: "var(--th-text-secondary)" }} data-testid="dashboard-updated">
                    · {updatedLabel(lastFetchTime)}
                  </span>
                )}
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  appCache.invalidate();
                  setActivityReady(false);
                  loadInsights();
                  loadRisk();
                  loadSla();
                  if (clientId != null) reloadScoped();
                  void Promise.all([refreshFleetOverview(true), refreshDashboard()]);
                }}
              >
                <RefreshCcw className="h-3.5 w-3.5" />
                Refresh
              </Button>
            </>
          }
        />

        {/* Fleet pulse: health, status mix, availability and what to look at first */}
        <section className="th-dash-hero" aria-labelledby="fleet-health-title">
          <div className="th-dash-hero-health">
            <HealthRing value={loading ? null : averageHealth} />
            <div className="min-w-0 flex-1">
              <p className="th-dash-greeting">{greeting}</p>
              <h2 id="fleet-health-title" className="th-dash-hero-title">
                Fleet health
                <span className="th-status-chip" style={{ "--chip-tone": health.tone } as React.CSSProperties}>
                  <i />
                  {health.label}
                </span>
              </h2>
              <p className="th-dash-hero-note">
                {clientName ? `${clientName} · ` : ""}Average health score of active devices. Archived devices are
                excluded.
              </p>
            </div>
          </div>

          <div className="th-dash-hero-mix">
            <p className="th-dash-hero-label">Status mix</p>
            <div
              className="th-mix-bar th-dash-mix flex overflow-hidden rounded-full"
              style={{ background: "var(--th-ring-track)" }}
              role="img"
              aria-label={
                loading
                  ? "Device status mix, loading"
                  : `Device status mix: ${Math.round(onlinePct)}% online, ${Math.round(stalePct)}% stale, ${Math.round(offlinePct)}% offline`
              }
            >
              <div style={{ width: loading ? "0%" : `${onlinePct}%`, background: TONE.online }} />
              <div style={{ width: loading ? "0%" : `${stalePct}%`, background: TONE.stale }} />
              <div style={{ width: loading ? "0%" : `${offlinePct}%`, background: TONE.offline }} />
            </div>
            <ul className="th-dash-legend">
              {(
                [
                  ["Online", online, onlinePct, TONE.online, "/devices?filter=online"],
                  ["Stale", stale, stalePct, TONE.stale, "/devices?filter=stale"],
                  ["Offline", offline, offlinePct, TONE.offline, "/devices?filter=offline"],
                ] as const
              ).map(([label, count, pct, tone, to]) => (
                <li key={label}>
                  <Link
                    to={to}
                    className="th-dash-legend-item"
                    style={{ "--legend-tone": tone } as React.CSSProperties}
                  >
                    <span className="th-dash-legend-label">
                      <i aria-hidden="true" />
                      {label}
                    </span>
                    <strong className="tabular-nums">{loading ? "—" : formatCount(count)}</strong>
                    <small className="tabular-nums">{loading ? "" : `${Math.round(pct)}%`}</small>
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="th-dash-hero-trend">
            <p className="th-dash-hero-label">Availability · last 30 days</p>
            <p className="th-dash-hero-big tabular-nums">
              {insights?.availability.overall_pct != null ? `${insights.availability.overall_pct.toFixed(2)}%` : "—"}
            </p>
            <DeltaChip delta={availabilityDelta} caption="last 7 days vs the 7 before" />
            <Sparkline
              values={availabilityValues}
              tone={TONE.online}
              label="Daily availability over the last 30 days"
              height={52}
            />
          </div>

          <div className="th-dash-hero-brief">
            <Briefing items={briefing} loading={loading} />
          </div>
        </section>

        {/* KPIs */}
        <div className="th-dash-kpis grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {kpis.map((kpi, index) => {
            const Icon = kpi.icon;
            return (
              <Link
                key={kpi.label}
                to={kpi.to}
                className="th-kpi th-dash-kpi"
                style={{ "--kpi-tone": kpi.tone, "--i": index } as React.CSSProperties}
              >
                <span className="th-kpi-label">
                  <span className="th-kpi-dot" />
                  {kpi.label}
                  <Icon className="th-dash-kpi-icon" aria-hidden="true" />
                </span>
                <span className="th-kpi-value">
                  {loading ? "—" : <AnimatedNumber value={kpi.value} format={formatCount} />}
                </span>
                <span className="th-kpi-hint">{kpi.hint}</span>
                <span className="th-dash-kpi-bar" aria-hidden="true">
                  <span style={{ width: loading ? "0%" : `${kpi.share}%` }} />
                </span>
              </Link>
            );
          })}
        </div>

        {/* Fleet scorecard: how good, next to how many */}
        <DashSection label="Scorecard" hint="Share of the fleet meeting each measure">
          <div className="th-dash-scores grid gap-3">
            {scorecard.map((score, index) => (
              <ScoreTile key={score.label} index={index} {...score} />
            ))}
          </div>
        </DashSection>

        {/* What needs a decision now */}
        <DashSection label="Right now" hint={realtimeStatus === "connected" ? "Live" : "Refreshing every 30 s"}>
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] lg:col-span-2 xl:col-span-1">
              <SlaAtRiskCard
                alerts={sla.alerts}
                overdue={sla.overdue}
                loading={sla.alerts === null && !sla.failed}
                failed={sla.failed}
                onRetry={loadSla}
              />
            </div>
            <section className="premium-card th-dash-card flex h-full flex-col p-0" aria-labelledby="attention-title">
              <div className="th-panel-head">
                <h2 id="attention-title">Needs attention</h2>
                <Link to="/alerts" className="th-link-btn">
                  View alerts
                </Link>
              </div>
              <ul className="flex-1 px-2 pb-2">
                {[
                  {
                    to: "/alerts",
                    label: DASHBOARD_LABELS.openAlerts,
                    count: totalOpenAlerts,
                    tone: TONE.critical,
                    icon: BellRing,
                  },
                  {
                    to: "/devices?filter=offline",
                    label: DASHBOARD_LABELS.offline,
                    count: offline,
                    tone: TONE.offline,
                    icon: WifiOff,
                  },
                  {
                    to: "/devices?filter=stale",
                    label: DASHBOARD_LABELS.stale,
                    count: stale,
                    tone: TONE.stale,
                    icon: Clock3,
                  },
                  {
                    to: "/devices?filter=critical",
                    label: DASHBOARD_LABELS.critical,
                    count: criticalCount,
                    tone: TONE.critical,
                    icon: HeartPulse,
                  },
                  {
                    to: "/devices?filter=needs_updates",
                    label: DASHBOARD_LABELS.needsUpdates,
                    count: patchCount,
                    tone: TONE.warning,
                    icon: Download,
                  },
                  {
                    to: "/devices?filter=needs_agent_update",
                    label: DASHBOARD_LABELS.agentUpdates,
                    count: fleetOverview?.agents_outdated ?? 0,
                    tone: "var(--th-status-agent)",
                    icon: Cpu,
                  },
                  {
                    to: "/devices?folder=unassigned",
                    label: "Devices without a client",
                    count: fleetOverview?.tree_counts.unassigned ?? 0,
                    tone: TONE.info,
                    icon: Building2,
                  },
                  {
                    to: "/devices?filter=favorites",
                    label: "Favorite devices",
                    count: favoritesCount,
                    tone: TONE.warning,
                    icon: Star,
                  },
                ]
                  // Rows with something to do first; empty ones keep their order below.
                  .sort((a, b) => Number(!loading && b.count > 0) - Number(!loading && a.count > 0))
                  .map(({ to, label, count, tone, icon: Icon }) => (
                    <li key={label}>
                      <Link
                        to={to}
                        className="th-attention-row"
                        data-empty={!loading && count === 0}
                        style={{ "--row-tone": tone } as React.CSSProperties}
                      >
                        <span className="th-attention-icon">
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                        <span className="flex-1 truncate">{label}</span>
                        <span className="th-attention-count">{loading ? "—" : formatCount(count)}</span>
                        <ChevronRight className="h-3.5 w-3.5 flex-none" style={{ color: "var(--th-text-faint)" }} />
                      </Link>
                    </li>
                  ))}
              </ul>
            </section>

            <section
              className="premium-card th-dash-card th-cp-overview flex h-full flex-col p-0"
              aria-labelledby="alerts-by-kind-title"
            >
              <div className="th-panel-head">
                <h2 id="alerts-by-kind-title">Open alerts by type</h2>
                <Link to="/alerts" className="th-link-btn">
                  View alerts
                </Link>
              </div>
              {!alertCountReady ? (
                <div className="flex-1" aria-busy="true" />
              ) : alertsByKind.length === 0 ? (
                <EmptyState
                  className="flex-1"
                  icon={<BellRing className="h-5 w-5" />}
                  title="No open alerts"
                  description="Every alert raised for your devices has been resolved."
                />
              ) : (
                alertBreakdown
              )}
              <p className="th-panel-foot mt-auto">
                {alertCountReady ? (
                  <>
                    {formatCount(totalOpenAlerts)} open
                    {alertCount.devices_affected ? ` on ${formatCount(alertCount.devices_affected)} devices` : ""}.
                  </>
                ) : (
                  "Loading alerts…"
                )}
              </p>
            </section>
          </div>
        </DashSection>

        {/* Protection, device health, agents and the platform itself */}
        <DashSection label="Security & platform" hint="Refreshed every 5 minutes">
          <div className={`grid gap-4 lg:grid-cols-2 ${isAdmin ? "xl:grid-cols-3" : ""}`}>
            <SecurityRiskCard risk={risk} failed={riskFailed} onRetry={loadRisk} />
            <AgentVersionsCard
              risk={risk}
              failed={riskFailed}
              onRetry={loadRisk}
              activeWindows={fleetOverview?.active_agent_version ?? null}
              activeLinux={[...new Set(Object.values(fleetOverview?.active_agent_versions ?? {}))]}
            />
            {isAdmin && (
              <div className="grid lg:col-span-2 xl:col-span-1">
                <SystemStatusCard compact />
              </div>
            )}
          </div>
        </DashSection>

        {/* Where the fleet is and who is on it */}
        <DashSection label="Fleet composition">
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <section
              className="premium-card th-dash-card flex h-full flex-col p-0"
              aria-labelledby="devices-by-client-title"
            >
              <div className="th-panel-head">
                <h2 id="devices-by-client-title">{clientId != null ? "Devices by group" : "Devices by client"}</h2>
                <Link to={clientId != null ? `/clients/${clientId}` : "/clients"} className="th-link-btn">
                  {clientId != null ? "Client profile" : "View clients"}
                </Link>
              </div>
              {loading ? (
                <SkeletonRows rows={4} />
              ) : clientBreakdown.length === 0 ? (
                <EmptyState
                  className="flex-1"
                  icon={<Building2 className="h-5 w-5" />}
                  title="No clients to show"
                  description="Devices are grouped here by client once they enroll."
                />
              ) : (
                <div className="flex-1 px-5 pb-3">
                  <ClientStatusList rows={clientBreakdown} total={total} />
                </div>
              )}
              <p className="th-panel-foot mt-auto">{clientBreakdownFoot}</p>
            </section>

            <section
              className="premium-card th-dash-card th-cp-overview flex h-full flex-col p-0"
              aria-labelledby="devices-by-category-title"
            >
              <div className="th-panel-head">
                <h2 id="devices-by-category-title">Devices by category</h2>
                <Link to="/devices" className="th-link-btn">
                  View all devices
                </Link>
              </div>
              {loading ? (
                <SkeletonRows rows={4} />
              ) : devicesByCategory.length === 0 ? (
                <EmptyState className="flex-1" icon={<Monitor className="h-5 w-5" />} title="No devices to group" />
              ) : (
                categoryBreakdown
              )}
              <p className="th-panel-foot mt-auto">
                {formatCount(total)} active devices by current status. Archived devices are excluded.
              </p>
            </section>

            <OperatorsPanel
              operators={operators}
              loading={operators.length === 0 && !activityReady}
              failed={shownFailed.operators}
              onRetry={retryActivity}
              currentUserId={user?.id}
              canManage={canManageOperators}
            />
          </div>
        </DashSection>

        {/* Trends */}
        <DashSection label="Trends" hint="Recomputed every 30 minutes">
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <section
              className="premium-card th-dash-card flex h-full flex-col p-0"
              aria-labelledby="availability-title"
            >
              <div className="th-panel-head">
                <h2 id="availability-title">Availability</h2>
                <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                  Last 30 days
                </span>
              </div>
              <div className="flex flex-1 flex-col px-5 pb-4">
                <p className="th-metric-big">
                  {insights?.availability.overall_pct != null
                    ? `${insights.availability.overall_pct.toFixed(2)}%`
                    : "—"}
                </p>
                <p className="mb-3 mt-1 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                  Share of time managed devices were online
                </p>
                <div className="min-h-0 flex-1">
                  {insights ? (
                    <AvailabilityChart series={insights.availability.series} />
                  ) : insightsFailed ? (
                    <SectionError what="availability" onRetry={retryInsights} />
                  ) : (
                    <div
                      className="h-full min-h-[120px] animate-pulse rounded-lg"
                      style={{ background: "var(--th-chip-bg)" }}
                    />
                  )}
                </div>
              </div>
              <p className="th-panel-foot">
                {insights?.availability.coverage_pct != null && insights.availability.coverage_pct < 99
                  ? `Based on ${insights.availability.coverage_pct}% of device time with a known status.`
                  : "Measured from recorded online/offline transitions."}
              </p>
            </section>

            <section className="premium-card th-dash-card flex h-full flex-col p-0" aria-labelledby="alert-trend-title">
              <div className="th-panel-head">
                <h2 id="alert-trend-title">Alerts this week</h2>
                <span className="flex items-center gap-3 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                  <span className="flex items-center gap-1.5">
                    <i className="th-legend-swatch" data-series="1" />
                    Opened
                  </span>
                  <span className="flex items-center gap-1.5">
                    <i className="th-legend-swatch" data-series="2" />
                    Resolved
                  </span>
                </span>
              </div>
              <div className="flex flex-1 flex-col px-5 pb-4">
                {alertTrendFigures}
                <div className="min-h-0 flex-1">
                  {insights ? (
                    <AlertFlowChart series={insights.alerts.series} />
                  ) : insightsFailed ? (
                    <SectionError what="alert trends" onRetry={retryInsights} />
                  ) : (
                    <div
                      className="h-full min-h-[120px] animate-pulse rounded-lg"
                      style={{ background: "var(--th-chip-bg)" }}
                    />
                  )}
                </div>
              </div>
              <p className="th-panel-foot">
                {insights
                  ? `${formatCount(insights.alerts.open_now)} still open right now.`
                  : insightsFailed
                    ? "Trends unavailable."
                    : "Loading…"}
              </p>
            </section>

            <section
              className="premium-card th-dash-card flex h-full flex-col p-0 lg:col-span-2 xl:col-span-1"
              aria-labelledby="problem-devices-title"
            >
              <div className="th-panel-head">
                <h2 id="problem-devices-title">Problem devices</h2>
                <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                  Last 7 days
                </span>
              </div>
              {!insights && insightsFailed ? (
                <SectionError what="problem devices" onRetry={retryInsights} />
              ) : !insights ? (
                <SkeletonRows rows={4} />
              ) : insights.problem_devices.length === 0 ? (
                <EmptyState
                  className="flex-1"
                  icon={<HeartPulse className="h-5 w-5" />}
                  title="No repeat offenders"
                  description="No device went offline or raised an alert this week."
                />
              ) : (
                problemDeviceRows
              )}
              <p className="th-panel-foot">Ranked by offline events plus alerts raised.</p>
            </section>
          </div>
        </DashSection>

        {/* Enrollments · activity */}
        <DashSection label="Activity">
          <div
            className={`grid gap-4 lg:grid-cols-2 ${enrollmentPageSize > 10 || actionPageSize > 10 ? "lg:items-start" : ""}`}
          >
            <section className="premium-card th-dash-card flex h-full flex-col p-0" aria-labelledby="enrollments-title">
              <div className="th-panel-head">
                <h2 id="enrollments-title">Latest enrollments</h2>
                <Link to="/devices" className="th-link-btn">
                  View all devices
                </Link>
              </div>
              {recentDevices.length === 0 && !activityReady ? (
                <p className="flex-1 px-5 py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                  Loading devices…
                </p>
              ) : recentDevices.length === 0 && shownFailed.devices ? (
                <SectionError what="devices" onRetry={retryActivity} />
              ) : recentDevices.length === 0 ? (
                <EmptyState
                  className="flex-1"
                  icon={<Monitor className="h-5 w-5" />}
                  title="No devices yet"
                  description="Enrolled devices appear here as soon as their agent checks in."
                />
              ) : (
                <ul className="flex-1 px-2 pb-2" key={`${enrollmentPage}:${enrollmentPageSize}`}>
                  {recentDevices
                    .slice((enrollmentPage - 1) * enrollmentPageSize, enrollmentPage * enrollmentPageSize)
                    .map(enrollmentRow)}
                </ul>
              )}
              {recentDevices.length > ENROLLMENT_PAGE_SIZES[0] && (
                <TablePagination
                  page={enrollmentPage}
                  pageSize={enrollmentPageSize}
                  total={recentDevices.length}
                  onPageChange={setEnrollmentPage}
                  onPageSizeChange={(size) => {
                    setEnrollmentPageSize(size);
                    setEnrollmentPage(1);
                  }}
                  pageSizeOptions={ENROLLMENT_PAGE_SIZES}
                  itemLabel="latest enrollments"
                />
              )}
            </section>

            <section className="premium-card th-dash-card flex h-full flex-col p-0" aria-labelledby="activity-title">
              <div className="th-panel-head">
                <h2 id="activity-title">{DASHBOARD_LABELS.recentActions}</h2>
                {hasPermission("audit_log") && (
                  <Link to="/audit" className="th-link-btn">
                    Audit log
                  </Link>
                )}
              </div>
              {recentActions.length === 0 && !activityReady ? (
                <p className="flex-1 px-5 py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                  Loading actions…
                </p>
              ) : recentActions.length === 0 && shownFailed.actions ? (
                <SectionError what="remote actions" onRetry={retryActivity} />
              ) : recentActions.length === 0 ? (
                <EmptyState
                  className="flex-1 justify-center"
                  icon={<Terminal className="h-5 w-5" />}
                  title="No remote actions yet"
                  description="Restarts, syncs and scripts sent to devices show up here with their result."
                />
              ) : (
                <ul className="flex-1 px-2 pb-2" key={`${actionPage}:${actionPageSize}`}>
                  {recentActions
                    .slice((actionPage - 1) * actionPageSize, actionPage * actionPageSize)
                    .map((action, index) => {
                      const isRunning = action.status === "running";
                      return (
                        <li
                          key={action.id}
                          className="th-share-row"
                          style={{ "--i": Math.min(index, 12) } as React.CSSProperties}
                        >
                          <div className="th-list-row">
                            <span className="th-palette-icon !h-8 !w-8">
                              {isRunning ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Terminal className="h-4 w-4" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span
                                className="block truncate text-[13px] font-medium"
                                style={{ color: "var(--th-text-primary)" }}
                              >
                                {actionTypeLabel(action.action_type)}
                                <span style={{ color: "var(--th-text-muted)" }}>
                                  {" "}
                                  · {action.device_hostname ?? `Device #${action.device_id}`}
                                </span>
                              </span>
                              <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                                {action.created_by ? `by ${action.created_by} · ` : ""}
                                {timeAgo(actionRelevantTime(action))}
                              </span>
                            </span>
                            <span
                              className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${statusColor(action.status)}`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${statusDotColor(action.status)}`} />
                              {ACTION_STATUS_LABELS[action.status] ?? action.status}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                </ul>
              )}
              {recentActions.length > ACTION_PAGE_SIZES[0] && (
                <TablePagination
                  page={actionPage}
                  pageSize={actionPageSize}
                  total={recentActions.length}
                  onPageChange={setActionPage}
                  onPageSizeChange={(size) => {
                    setActionPageSize(size);
                    setActionPage(1);
                  }}
                  pageSizeOptions={ACTION_PAGE_SIZES}
                  itemLabel="recent actions"
                />
              )}
            </section>
          </div>
        </DashSection>
      </div>
      {/* end hidden md:block */}
    </section>
  );
}

function OperatorsPanel({
  operators,
  loading,
  failed,
  onRetry,
  currentUserId,
  canManage,
}: {
  operators: OperatorPresenceRecord[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  currentUserId?: number;
  canManage: boolean;
}) {
  const onlineCount = operators.filter((op) => op.is_online).length;
  return (
    <section
      className="premium-card th-dash-card flex h-full flex-col p-0 lg:col-span-2 xl:col-span-1"
      aria-labelledby="operators-title"
    >
      <div className="th-panel-head">
        <h2 id="operators-title">Operators</h2>
        <span className="flex items-center gap-3">
          <span key={onlineCount} className="th-nav-badge th-share-count">
            {formatCount(onlineCount)} online
          </span>
          {canManage && (
            <Link to="/operators" className="th-link-btn">
              View all
            </Link>
          )}
        </span>
      </div>
      {loading ? (
        <SkeletonRows rows={4} />
      ) : operators.length === 0 && failed ? (
        <SectionError what="operators" onRetry={onRetry} />
      ) : operators.length === 0 ? (
        <EmptyState className="flex-1" icon={<Users className="h-5 w-5" />} title="No operators yet" />
      ) : (
        <ul className="grid flex-1 grid-cols-2 content-start gap-x-1 px-2 pb-2 lg:grid-cols-3 xl:grid-cols-2">
          {[...operators]
            .sort(
              (a, b) =>
                Number(b.is_online) - Number(a.is_online) ||
                (a.display_name ?? a.username).localeCompare(b.display_name ?? b.username),
            )
            .map((op, index) => {
              const label = op.display_name ?? op.username;
              const status = op.is_online ? "Online" : op.last_active_at ? timeAgo(op.last_active_at) : "Offline";
              return (
                <li
                  key={op.id}
                  className="th-share-row flex min-w-0 items-center gap-2.5 rounded-lg px-3 py-2"
                  style={{ "--i": index } as React.CSSProperties}
                  title={`${label} · ${op.role} · ${op.is_online || !op.last_active_at ? status : `active ${status}`}`}
                >
                  <span className="th-avatar relative">
                    {label.charAt(0).toUpperCase()}
                    <i className="th-presence-dot" data-online={op.is_online} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-[13px] font-medium"
                      style={{ color: "var(--th-text-primary)" }}
                    >
                      {label}
                      {op.id === currentUserId && <span style={{ color: "var(--th-text-muted)" }}> (you)</span>}
                    </span>
                    <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                      <span className="capitalize">{op.role}</span> · {status}
                    </span>
                  </span>
                </li>
              );
            })}
        </ul>
      )}
    </section>
  );
}
