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
  Star,
  Terminal,
  Users,
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
import { Link, useNavigate } from "react-router-dom";
import { Device, FleetInsights, getDevices, getFleetInsights } from "../api/devices";
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
import { AnimatedNumber, Button, EmptyState, PageHeader, TablePagination } from "../components/ui";
import { formatLocalDateTime, timeAgo } from "../utils/time";
import { formatCount } from "../utils/number";
import { freshnessTone, humanize, TERMS, TONE } from "../utils/deviceStatus";
import { deviceFreshness } from "../utils/devicePresence";
import { DeviceStatusChip } from "../components/DeviceStatusChip";
import { ALERT_KIND_LABELS, ALERT_SEVERITY_TONE, AlertKind } from "../types/alert";
import { usePollingRefresh } from "../hooks/usePollingRefresh";
import { useNow } from "../hooks/useNow";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";
import { useAppData } from "../contexts/AppDataContext";
import { actionRelevantTime, DASHBOARD_LABELS, DashboardMobile } from "./DashboardMobile";

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
    alertCount,
    alertCountReady,
    fleetOverview,
    fleetOverviewLoading,
    lastFetchTime,
    latestEvent,
    realtimeStatus,
    refreshFleetOverview,
    totalOpenAlerts,
  } = useAppData();

  const stats = fleetOverview?.stats ?? { total: 0, online: 0, stale: 0, offline: 0 };
  const total = stats.total;
  const online = stats.online;
  const stale = stats.stale;
  const offline = stats.offline;
  const averageHealth = fleetOverview?.average_health ?? null;
  const patchCount = fleetOverview?.needs_updates ?? 0;
  const criticalCount = fleetOverview?.critical ?? 0;
  const loading = fleetOverviewLoading && fleetOverview === null;
  const [recentDevices, setRecentDevices] = useState<Device[]>(
    () => appCache.peek<Device[]>(CACHE_KEYS.dashboardRecentDevices) ?? [],
  );
  // Mirrors recentDevices so realtime events can patch it without a stale closure.
  const recentDevicesRef = useRef(recentDevices);
  const [enrollmentPage, setEnrollmentPage] = useState(1);
  const [enrollmentPageSize, setEnrollmentPageSize] = useState(ENROLLMENT_PAGE_SIZES[0]);
  const [actionPage, setActionPage] = useState(1);
  const [actionPageSize, setActionPageSize] = useState(ACTION_PAGE_SIZES[0]);
  const [recentActions, setRecentActions] = useState<RemoteActionWithDevice[]>(
    () => appCache.peek<RemoteActionWithDevice[]>(CACHE_KEYS.recentActions) ?? [],
  );
  const [operators, setOperators] = useState<OperatorPresenceRecord[]>(
    () => appCache.peek<OperatorPresenceRecord[]>(CACHE_KEYS.operatorPresence) ?? [],
  );
  const [clientNames, setClientNames] = useState<Record<number, string>>(() =>
    Object.fromEntries((appCache.peek<Client[]>(CACHE_KEYS.clientsList) ?? []).map((c) => [c.id, c.name])),
  );
  useEffect(() => {
    getClients()
      .then((list) => setClientNames(Object.fromEntries(list.map((c) => [c.id, c.name]))))
      .catch(() => undefined);
  }, []);
  // Trends are kept per user, so returning to the dashboard shows the last
  // result at once while a fresh one loads.
  const insightsKey = `${CACHE_KEYS.dashboardInsights}.${user?.id ?? "anon"}`;
  const [insights, setInsights] = useState<FleetInsights | null>(() => appCache.peek<FleetInsights>(insightsKey));
  const [insightsFailed, setInsightsFailed] = useState(false);
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
  const [activityReady, setActivityReady] = useState(() => appCache.peek(CACHE_KEYS.dashboardRecentDevices) !== null);

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

  const retryActivity = useCallback(() => {
    setActivityReady(false);
    void refreshDashboard();
  }, [refreshDashboard]);

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
  const clientBreakdown = (() => {
    const byClient = fleetOverview?.tree_counts.by_client ?? {};
    const rows = Object.entries(byClient)
      .map(([id, count]) => ({ id, name: clientNames[Number(id)] ?? `Client #${id}`, count }))
      .sort((a, b) => b.count - a.count);
    const top = rows.slice(0, 4);
    const rest = rows.slice(4).reduce((sum, r) => sum + r.count, 0);
    const unassigned = fleetOverview?.tree_counts.unassigned ?? 0;
    return [
      ...top,
      ...(rest > 0 ? [{ id: "other", name: `${rows.length - 4} more clients`, count: rest }] : []),
      ...(unassigned > 0 ? [{ id: "none", name: TERMS.noClient, count: unassigned }] : []),
    ];
  })();

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
        />
      </div>

      {/* Desktop dashboard — shown only at md+ (768px) */}
      <div className="hidden md:block space-y-4">
        <PageHeader
          title="Dashboard"
          description="Fleet health, open issues and recent activity across all clients."
          actions={
            <>
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
                  void Promise.all([refreshFleetOverview(true), refreshDashboard()]);
                }}
              >
                <RefreshCcw className="h-3.5 w-3.5" />
                Refresh
              </Button>
            </>
          }
        />

        {/* KPIs */}
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          {[
            { to: "/devices", label: "All devices", value: total, tone: TONE.neutral, hint: "Managed endpoints" },
            {
              to: "/devices?filter=online",
              label: "Online",
              value: online,
              tone: TONE.online,
              hint: `${availability}% available`,
            },
            {
              to: "/devices?filter=stale",
              label: "Stale",
              value: stale,
              tone: TONE.stale,
              hint: "Last heartbeat 6–25 min ago",
            },
            {
              to: "/devices?filter=offline",
              label: "Offline",
              value: offline,
              tone: TONE.offline,
              hint: "Not responding",
            },
            {
              to: "/devices?filter=critical",
              label: "Critical health",
              value: criticalCount,
              tone: TONE.critical,
              hint: "Health score below 50",
            },
            {
              to: "/devices?filter=needs_updates",
              label: DASHBOARD_LABELS.needsUpdates,
              value: patchCount,
              tone: TONE.warning,
              hint: "Pending patches",
            },
          ].map((kpi) => (
            <Link
              key={kpi.label}
              to={kpi.to}
              className="th-kpi"
              style={{ "--kpi-tone": kpi.tone } as React.CSSProperties}
            >
              <span className="th-kpi-label">
                <span className="th-kpi-dot" />
                {kpi.label}
              </span>
              <span className="th-kpi-value">
                {loading ? "—" : <AnimatedNumber value={kpi.value} format={formatCount} />}
              </span>
              <span className="th-kpi-hint">{kpi.hint}</span>
            </Link>
          ))}
        </div>

        {/* Health · attention · platform */}
        <div className={`grid gap-4 lg:grid-cols-2 ${isAdmin ? "xl:grid-cols-3" : ""}`}>
          <section className="premium-card flex h-full flex-col p-0" aria-labelledby="fleet-health-title">
            <div className="th-panel-head">
              <h2 id="fleet-health-title">Fleet health</h2>
              <span className="th-status-chip" style={{ "--chip-tone": health.tone } as React.CSSProperties}>
                <i />
                {health.label}
              </span>
            </div>
            <div className="flex items-center gap-6 px-5 pb-4">
              <HealthRing value={loading ? null : averageHealth} />
              <div className="min-w-0 flex-1 space-y-3">
                <div
                  className="th-mix-bar flex h-2 overflow-hidden rounded-full"
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
                <ul className="space-y-2 text-[13px]">
                  {(
                    [
                      ["Online", online, onlinePct, TONE.online],
                      ["Stale", stale, stalePct, TONE.stale],
                      ["Offline", offline, offlinePct, TONE.offline],
                    ] as const
                  ).map(([label, count, pct, tone]) => (
                    <li key={label} className="flex items-center gap-2">
                      <span className="h-2 w-2 flex-none rounded-full" style={{ background: tone }} />
                      <span style={{ color: "var(--th-text-secondary)" }}>{label}</span>
                      <span className="ml-auto font-semibold tabular-nums" style={{ color: "var(--th-text-primary)" }}>
                        {loading ? "—" : formatCount(count)}
                      </span>
                      <span className="w-10 text-right tabular-nums" style={{ color: "var(--th-text-faint)" }}>
                        {loading ? "" : `${Math.round(pct)}%`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div
              className="flex flex-1 flex-col px-5 pb-3 pt-3"
              style={{ borderTop: "1px solid var(--th-border-subtle)" }}
            >
              <p className="th-menu-label !px-0 !pt-0">Devices by client</p>
              {clientBreakdown.length === 0 ? (
                <p className="py-3 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                  No devices yet.
                </p>
              ) : (
                <ul className="mt-1 flex flex-1 flex-col justify-between gap-1">
                  {clientBreakdown.map((row, index) => (
                    <li key={row.id} className="text-[13px]" style={{ "--i": index } as React.CSSProperties}>
                      <Link
                        to={
                          row.id === "none"
                            ? "/devices?folder=unassigned"
                            : row.id === "other"
                              ? "/clients"
                              : `/devices?folder=client-${row.id}`
                        }
                        className="-mx-2 block rounded-md px-2 py-1 transition-colors hover:bg-[var(--th-sidebar-nav-hover)]"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span
                            className="truncate"
                            style={{ color: row.id === "none" ? "var(--th-text-muted)" : "var(--th-text-secondary)" }}
                          >
                            {row.name}
                          </span>
                          <span className="font-semibold tabular-nums" style={{ color: "var(--th-text-primary)" }}>
                            {formatCount(row.count)}
                          </span>
                        </div>
                        <div
                          className="mt-1 h-1 overflow-hidden rounded-full"
                          style={{ background: "var(--th-ring-track)" }}
                        >
                          <div
                            className="th-share-fill h-full rounded-full"
                            style={{
                              width: `${total ? (row.count / total) * 100 : 0}%`,
                              background: row.id === "none" ? TONE.neutral : "var(--th-accent)",
                            }}
                          />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="th-panel-foot">Average health score of active devices. Archived devices are excluded.</p>
          </section>

          <section className="premium-card flex h-full flex-col p-0" aria-labelledby="attention-title">
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
              ].map(({ to, label, count, tone, icon: Icon }) => (
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

          {isAdmin && (
            <div className="grid lg:col-span-2 xl:col-span-1">
              <SystemStatusCard compact />
            </div>
          )}
        </div>

        {/* Operators · alerts by type · devices by category */}
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          <OperatorsPanel
            operators={operators}
            loading={operators.length === 0 && !activityReady}
            failed={failed.operators}
            onRetry={retryActivity}
            currentUserId={user?.id}
            canManage={canManageOperators}
          />

          <section
            className="premium-card th-cp-overview flex h-full flex-col p-0"
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
              <>
                <div className="th-cp-hero">
                  <SegmentRing
                    segments={severitySegments}
                    total={totalOpenAlerts}
                    center={formatCount(totalOpenAlerts)}
                    caption={totalOpenAlerts === 1 ? "open alert" : "open alerts"}
                    size={108}
                  />
                  <RingLegend
                    segments={severitySegments}
                    total={totalOpenAlerts}
                    onSelect={() => navigate("/alerts")}
                  />
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

          <section
            className="premium-card th-cp-overview flex h-full flex-col p-0 lg:col-span-2 xl:col-span-1"
            aria-labelledby="devices-by-category-title"
          >
            <div className="th-panel-head">
              <h2 id="devices-by-category-title">Devices by category</h2>
              <Link to="/devices" className="th-link-btn">
                View all devices
              </Link>
            </div>
            {loading ? (
              <p className="flex-1 px-5 py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                Loading…
              </p>
            ) : devicesByCategory.length === 0 ? (
              <EmptyState className="flex-1" icon={<Monitor className="h-5 w-5" />} title="No devices to group" />
            ) : (
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
            )}
            <p className="th-panel-foot mt-auto">
              {formatCount(total)} active devices by current status. Archived devices are excluded.
            </p>
          </section>
        </div>

        {/* Trends */}
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          <section className="premium-card flex h-full flex-col p-0" aria-labelledby="availability-title">
            <div className="th-panel-head">
              <h2 id="availability-title">Availability</h2>
              <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                Last 30 days
              </span>
            </div>
            <div className="flex flex-1 flex-col px-5 pb-4">
              <p className="th-metric-big">
                {insights?.availability.overall_pct != null ? `${insights.availability.overall_pct.toFixed(2)}%` : "—"}
              </p>
              <p className="mb-3 mt-1 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                Share of time managed devices were online
              </p>
              <div className="min-h-0 flex-1">
                {insights ? (
                  <AvailabilityChart series={insights.availability.series} />
                ) : insightsFailed ? (
                  <SectionError what="availability" onRetry={loadInsights} />
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

          <section className="premium-card flex h-full flex-col p-0" aria-labelledby="alert-trend-title">
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
              <div className="min-h-0 flex-1">
                {insights ? (
                  <AlertFlowChart series={insights.alerts.series} />
                ) : insightsFailed ? (
                  <SectionError what="alert trends" onRetry={loadInsights} />
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
            className="premium-card flex h-full flex-col p-0 lg:col-span-2 xl:col-span-1"
            aria-labelledby="problem-devices-title"
          >
            <div className="th-panel-head">
              <h2 id="problem-devices-title">Problem devices</h2>
              <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                Last 7 days
              </span>
            </div>
            {!insights && insightsFailed ? (
              <SectionError what="problem devices" onRetry={loadInsights} />
            ) : !insights ? (
              <p className="flex-1 px-5 py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                Loading…
              </p>
            ) : insights.problem_devices.length === 0 ? (
              <EmptyState
                className="flex-1"
                icon={<HeartPulse className="h-5 w-5" />}
                title="No repeat offenders"
                description="No device went offline or raised an alert this week."
              />
            ) : (
              <ul className="flex-1 px-2 pb-2">
                {insights.problem_devices.map((d, i) => (
                  <li key={d.device_id}>
                    <Link to={`/devices?device=${d.device_id}`} className="th-list-row">
                      <span
                        className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-[12px] font-semibold tabular-nums"
                        style={{ background: "var(--th-chip-bg)", color: "var(--th-text-muted)" }}
                      >
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate text-[13px] font-medium"
                          style={{ color: "var(--th-text-primary)" }}
                        >
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
            )}
            <p className="th-panel-foot">Ranked by offline events plus alerts raised.</p>
          </section>
        </div>

        {/* Enrollments · activity. Beyond ten rows a page the two cards keep
            their own heights, so the shorter one is not stretched empty. */}
        <div
          className={`grid gap-4 lg:grid-cols-2 ${enrollmentPageSize > 10 || actionPageSize > 10 ? "lg:items-start" : ""}`}
        >
          <section className="premium-card flex h-full flex-col p-0" aria-labelledby="enrollments-title">
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
            ) : recentDevices.length === 0 && failed.devices ? (
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
                  .map((device, index) => {
                    const tone = freshnessTone(deviceFreshness(device));
                    return (
                      <li
                        key={device.id}
                        className="th-share-row"
                        style={{ "--i": Math.min(index, 12) } as React.CSSProperties}
                      >
                        <Link to={`/devices?device=${device.id}`} className="th-list-row">
                          <span className="th-palette-icon !h-8 !w-8">
                            <Monitor className="h-4 w-4" />
                            <i style={{ background: tone }} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              className="block truncate text-[13px] font-medium"
                              style={{ color: "var(--th-text-primary)" }}
                            >
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
                            <span
                              className="mt-0.5 block text-[11px] tabular-nums"
                              style={{ color: "var(--th-text-faint)" }}
                            >
                              {formatLocalDateTime(device.registered_at)}
                            </span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
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

          <section className="premium-card flex h-full flex-col p-0" aria-labelledby="activity-title">
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
            ) : recentActions.length === 0 && failed.actions ? (
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
      </div>
      {/* end hidden md:block */}
    </section>
  );
}

function HealthRing({ value }: { value: number | null }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const tone = value == null ? TONE.neutral : value < 50 ? TONE.critical : value < 80 ? TONE.warning : TONE.online;
  return (
    <div
      className="relative h-[88px] w-[88px] flex-none"
      role="img"
      aria-label={value == null ? "No health score" : `Average health ${value} of 100`}
    >
      <svg viewBox="0 0 88 88" className="h-full w-full -rotate-90">
        <circle cx="44" cy="44" r={r} fill="none" strokeWidth="8" style={{ stroke: "var(--th-ring-track)" }} />
        <circle
          cx="44"
          cy="44"
          r={r}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          className="th-ring-value"
          style={{ stroke: tone }}
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="th-metric-big" style={{ lineHeight: 1 }}>
          {value ?? "—"}
        </span>
        <span className="mt-1 text-[11px]" style={{ color: "var(--th-text-faint)" }}>
          of 100
        </span>
      </span>
    </div>
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
    <section className="premium-card flex h-full flex-col p-0" aria-labelledby="operators-title">
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
        <p className="flex-1 px-5 py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
          Loading…
        </p>
      ) : operators.length === 0 && failed ? (
        <SectionError what="operators" onRetry={onRetry} />
      ) : operators.length === 0 ? (
        <EmptyState className="flex-1" icon={<Users className="h-5 w-5" />} title="No operators yet" />
      ) : (
        <ul className="grid flex-1 grid-cols-2 content-start gap-x-1 px-2 pb-2">
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
