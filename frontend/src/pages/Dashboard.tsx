import { useCallback, useEffect, useState } from "react";
import { appCache, CACHE_KEYS, CACHE_TTL } from "../store/appCache";
import {
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
import { Link } from "react-router-dom";
import { Device, FleetInsights, getDevices, getFleetInsights } from "../api/devices";
import { AlertFlowChart, AvailabilityChart } from "../components/InsightCharts";
import { Client, getClients } from "../api/clients";
import SystemStatusCard from "../components/SystemStatusCard";
import { getOperatorPresence, OperatorPresenceRecord } from "../api/operators";
import { useAuth } from "../auth/AuthContext";
import {
  ACTION_LABELS,
  ACTION_STATUS_LABELS,
  ActionType,
  getRecentActions,
  RemoteActionWithDevice,
  statusColor,
  statusDotColor,
} from "../api/actions";
import { Button, EmptyState, PageHeader } from "../components/ui";
import { APP_TIME_ZONE, parseUTC, timeAgo, DISPLAY_LOCALE } from "../utils/time";
import { usePollingRefresh } from "../hooks/usePollingRefresh";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";
import { useAppData } from "../contexts/AppDataContext";
import { DashboardMobile } from "./DashboardMobile";

const formatDate = (iso?: string) => {
  if (!iso) return "Unknown";
  return parseUTC(iso).toLocaleString(DISPLAY_LOCALE, { hourCycle: "h23", timeZone: APP_TIME_ZONE, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

function actionTimeAgo(iso?: string | null): string {
  return iso ? timeAgo(iso) : "—";
}

const statusBadgeClass = (device: Device) => {
  const state = device.freshness_state ?? device.status;
  if (state === "online") return "border-emerald-400/25 bg-emerald-400/10 text-emerald-200";
  if (state === "stale") return "border-amber-300/30 bg-amber-300/10 text-amber-100";
  return "border-slate-500/20 bg-slate-500/10 text-slate-300";
};

export default function Dashboard() {
  const { user, hasPermission } = useAuth();
  const {
    fleetOverview,
    fleetOverviewLoading,
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
  const [enrollmentLimit] = useState(8);
  const [recentActions, setRecentActions] = useState<RemoteActionWithDevice[]>(() => appCache.peek<RemoteActionWithDevice[]>(CACHE_KEYS.recentActions) ?? []);
  const [operators, setOperators] = useState<OperatorPresenceRecord[]>(() => appCache.peek<OperatorPresenceRecord[]>(CACHE_KEYS.operatorPresence) ?? []);
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
  const loadInsights = useCallback(() => {
    getFleetInsights(30)
      .then((data) => {
        appCache.set(insightsKey, data);
        setInsights(data);
      })
      .catch(() => undefined);
  }, [insightsKey]);
  useEffect(() => { loadInsights(); }, [loadInsights]);
  const [favoritesCount] = useState(() => { try { const raw = localStorage.getItem('techi.favorites'); return raw ? (JSON.parse(raw) as number[]).length : 0; } catch { return 0; } });
  const [error, setError] = useState<string | null>(null);
  const [activityReady, setActivityReady] = useState(
    () => appCache.peek(CACHE_KEYS.dashboardRecentDevices) !== null,
  );

  const loadDashboard = useCallback(async () => {
    const devicesFresh = appCache.get(CACHE_KEYS.dashboardRecentDevices, CACHE_TTL.dashboardRecentDevices) !== null;
    const actionsFresh = appCache.get(CACHE_KEYS.recentActions, CACHE_TTL.recentActions) !== null;
    const presenceFresh = appCache.get(CACHE_KEYS.operatorPresence, CACHE_TTL.operatorPresence) !== null;

    if (devicesFresh && actionsFresh && presenceFresh) {
      setActivityReady(true);
      return;
    }

    try {
      setError(null);

      const [deviceResponse, latestActions, presenceList] = await Promise.all([
        devicesFresh
          ? Promise.resolve({ devices: appCache.peek<Device[]>(CACHE_KEYS.dashboardRecentDevices) ?? [] })
          : getDevices({}, 0, enrollmentLimit).catch(() => ({ devices: [] as Device[], total: 0 })),
        actionsFresh
          ? Promise.resolve(appCache.peek<RemoteActionWithDevice[]>(CACHE_KEYS.recentActions) ?? [] as RemoteActionWithDevice[])
          : getRecentActions(10).catch(() => [] as RemoteActionWithDevice[]),
        presenceFresh
          ? Promise.resolve(appCache.peek<OperatorPresenceRecord[]>(CACHE_KEYS.operatorPresence) ?? [] as OperatorPresenceRecord[])
          : getOperatorPresence().catch(() => [] as OperatorPresenceRecord[]),
      ]);

      if (!devicesFresh) {
        appCache.set(CACHE_KEYS.dashboardRecentDevices, deviceResponse.devices);
        setRecentDevices(deviceResponse.devices);
      }
      if (!actionsFresh) {
        appCache.set(CACHE_KEYS.recentActions, latestActions);
        setRecentActions(latestActions);
      }
      if (!presenceFresh) {
        appCache.set(CACHE_KEYS.operatorPresence, presenceList);
        setOperators(presenceList);
      }

      setActivityReady(true);
    } catch (err) {
      console.error('Dashboard load error:', err);
      setError(err instanceof Error ? err.message : "Unable to load dashboard data");
    } finally {
      setActivityReady(true);
    }
  }, [hasPermission, enrollmentLimit]);

  const patchRecentDevice = useCallback((event: DeviceRealtimeEvent) => {
    const eventDevice = event.data;
    if (!eventDevice?.id) return false;
    let patched = false;
    setRecentDevices((items) => {
      const index = items.findIndex((item) => item.id === eventDevice.id);
      if (index === -1) {
        return items;
      }
      const next = [...items];
      next[index] = { ...items[index], ...eventDevice } as Device;
      patched = true;
      return next;
    });
    return patched;
  }, []);

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
  }, [hasPermission, latestEvent, patchRecentAction, patchRecentDevice]);

  const { runNow: refreshDashboard } = usePollingRefresh(loadDashboard, {
    intervalMs: 120000,
    enabled: realtimeStatus !== "connected",
    immediate: !activityReady,
  });

  // Re-fetch devices when limit selector changes
  useEffect(() => {
    appCache.invalidate(CACHE_KEYS.dashboardRecentDevices);
    void refreshDashboard();
  }, [enrollmentLimit]); // eslint-disable-line react-hooks/exhaustive-deps

  const availability = total > 0 ? Math.round((online / total) * 100) : 0;
  const onlinePct = total > 0 ? (online / total) * 100 : 0;
  const stalePct = total > 0 ? (stale / total) * 100 : 0;
  const offlinePct = total > 0 ? (offline / total) * 100 : 0;
  const healthTone =
    averageHealth == null
      ? "border-amber-400/25 bg-amber-400/10 text-amber-200"
      : averageHealth < 50
      ? "border-red-400/25 bg-red-400/10 text-red-200"
      : averageHealth < 80
      ? "border-amber-400/25 bg-amber-400/10 text-amber-200"
      : "border-emerald-400/25 bg-emerald-400/10 text-emerald-200";
  // System status is for owner and admin only (the API enforces it too).
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const onlineOperators = operators.filter((op) => op.is_online);
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
      ...(unassigned > 0 ? [{ id: "none", name: "No client", count: unassigned }] : []),
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
            {onlineOperators.length > 0 && (
              <Link to={hasPermission("manage_operators") ? "/operators" : "/"} className="th-status-chip" title={onlineOperators.map((op) => op.display_name ?? op.username).join(", ")}>
                <Users className="h-3.5 w-3.5" style={{ color: "var(--th-text-muted)" }} />
                {onlineOperators.length} {onlineOperators.length === 1 ? "operator" : "operators"} online
              </Link>
            )}
            <span
              className="th-status-chip"
              style={{ "--chip-tone": realtimeStatus === "connected" ? "var(--th-status-online)" : "var(--th-status-warning)" } as React.CSSProperties}
              title={realtimeStatus === "connected" ? "Live updates over WebSocket" : "WebSocket unavailable, refreshing by polling"}
            >
              <i />
              {realtimeStatus === "connected" ? "Live" : "Polling"}
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

      {error && (
        <div className="th-auth-notice" data-tone="error" role="alert">
          {error}
        </div>
      )}

      {/* KPIs */}
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        {([
          { to: "/devices", label: "All devices", value: total, tone: "var(--th-text-faint)", hint: "Managed endpoints" },
          { to: "/devices?filter=online", label: "Online", value: online, tone: "var(--th-status-online)", hint: `${availability}% available` },
          { to: "/devices?filter=stale", label: "Stale", value: stale, tone: "var(--th-status-stale)", hint: "No heartbeat for 15 min" },
          { to: "/devices?filter=offline", label: "Offline", value: offline, tone: "var(--th-status-offline)", hint: "Not responding" },
          { to: "/devices?filter=critical", label: "Critical health", value: criticalCount, tone: "var(--th-status-critical)", hint: "Health score below 50" },
          { to: "/devices?filter=needs_updates", label: "Needs updates", value: patchCount, tone: "var(--th-status-warning)", hint: "Pending patches" },
        ]).map((kpi) => (
          <Link key={kpi.label} to={kpi.to} className="th-kpi" style={{ "--kpi-tone": kpi.tone } as React.CSSProperties}>
            <span className="th-kpi-label"><span className="th-kpi-dot" />{kpi.label}</span>
            <span className="th-kpi-value">{loading ? "—" : kpi.value}</span>
            <span className="th-kpi-hint">{kpi.hint}</span>
          </Link>
        ))}
      </div>

      {/* Health · attention · platform */}
      <div className="grid gap-4 xl:grid-cols-3">
        <section className="premium-card flex h-full flex-col p-0" aria-labelledby="fleet-health-title">
          <div className="th-panel-head">
            <h2 id="fleet-health-title">Fleet health</h2>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${healthTone}`}>
              {averageHealth == null ? "No score" : averageHealth < 50 ? "Critical" : averageHealth < 80 ? "Warning" : "Healthy"}
            </span>
          </div>
          <div className="flex items-center gap-6 px-5 pb-4">
            <HealthRing value={loading ? null : averageHealth} />
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex h-2 overflow-hidden rounded-full" style={{ background: "var(--th-ring-track)" }} aria-label="Device status mix">
                <div style={{ width: loading ? "0%" : `${onlinePct}%`, background: "var(--th-status-online)" }} />
                <div style={{ width: loading ? "0%" : `${stalePct}%`, background: "var(--th-status-stale)" }} />
                <div style={{ width: loading ? "0%" : `${offlinePct}%`, background: "var(--th-status-offline)" }} />
              </div>
              <ul className="space-y-2 text-[13px]">
                {([
                  ["Online", online, onlinePct, "var(--th-status-online)"],
                  ["Stale", stale, stalePct, "var(--th-status-stale)"],
                  ["Offline", offline, offlinePct, "var(--th-status-offline)"],
                ] as const).map(([label, count, pct, tone]) => (
                  <li key={label} className="flex items-center gap-2">
                    <span className="h-2 w-2 flex-none rounded-full" style={{ background: tone }} />
                    <span style={{ color: "var(--th-text-secondary)" }}>{label}</span>
                    <span className="ml-auto font-semibold tabular-nums" style={{ color: "var(--th-text-primary)" }}>{loading ? "—" : count}</span>
                    <span className="w-10 text-right tabular-nums" style={{ color: "var(--th-text-faint)" }}>{loading ? "" : `${Math.round(pct)}%`}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex flex-1 flex-col px-5 pb-3 pt-3" style={{ borderTop: "1px solid var(--th-border-subtle)" }}>
            <p className="th-menu-label !px-0 !pt-0">Devices by client</p>
            {clientBreakdown.length === 0 ? (
              <p className="py-3 text-[13px]" style={{ color: "var(--th-text-muted)" }}>No devices yet.</p>
            ) : (
              <ul className="mt-1 flex flex-1 flex-col justify-between gap-1">
                {clientBreakdown.map((row) => (
                  <li key={row.id} className="text-[13px]">
                    <Link
                      to={row.id === "none" ? "/devices?folder=unassigned" : row.id === "other" ? "/clients" : `/devices?folder=client-${row.id}`}
                      className="-mx-2 block rounded-md px-2 py-1 transition-colors hover:bg-[var(--th-sidebar-nav-hover)]"
                    >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate" style={{ color: row.id === "none" ? "var(--th-text-muted)" : "var(--th-text-secondary)" }}>{row.name}</span>
                      <span className="font-semibold tabular-nums" style={{ color: "var(--th-text-primary)" }}>{row.count}</span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full" style={{ background: "var(--th-ring-track)" }}>
                      <div className="h-full rounded-full" style={{ width: `${total ? (row.count / total) * 100 : 0}%`, background: row.id === "none" ? "var(--th-text-faint)" : "var(--th-accent)" }} />
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
            <Link to="/alerts" className="th-link-btn">View alerts</Link>
          </div>
          <ul className="flex-1 px-2 pb-2">
            {([
              { to: "/alerts", label: "Open alerts", count: totalOpenAlerts, tone: "var(--th-status-critical)", icon: BellRing },
              { to: "/devices?filter=offline", label: "Offline devices", count: offline, tone: "var(--th-status-offline)", icon: WifiOff },
              { to: "/devices?filter=stale", label: "Stale devices", count: stale, tone: "var(--th-status-stale)", icon: Clock3 },
              { to: "/devices?filter=critical", label: "Critical health", count: criticalCount, tone: "var(--th-status-critical)", icon: HeartPulse },
              { to: "/devices?filter=needs_updates", label: "Pending updates", count: patchCount, tone: "var(--th-status-warning)", icon: Download },
              { to: "/devices?filter=needs_agent_update", label: "Agent updates", count: fleetOverview?.agents_outdated ?? 0, tone: "var(--th-status-agent)", icon: Cpu },
              { to: "/devices?folder=unassigned", label: "Devices without a client", count: fleetOverview?.tree_counts.unassigned ?? 0, tone: "var(--th-status-info)", icon: Building2 },
              { to: "/devices?filter=favorites", label: "Starred devices", count: favoritesCount, tone: "var(--th-status-warning)", icon: Star },
            ]).map(({ to, label, count, tone, icon: Icon }) => (
              <li key={label}>
                <Link to={to} className="th-attention-row" data-empty={!loading && count === 0} style={{ "--row-tone": tone } as React.CSSProperties}>
                  <span className="th-attention-icon"><Icon className="h-3.5 w-3.5" /></span>
                  <span className="flex-1 truncate">{label}</span>
                  <span className="th-attention-count">{loading ? "—" : count}</span>
                  <ChevronRight className="h-3.5 w-3.5 flex-none" style={{ color: "var(--th-text-faint)" }} />
                </Link>
              </li>
            ))}
          </ul>
        </section>

        {isAdmin ? <SystemStatusCard compact /> : <OperatorsPanel operators={operators} loading={loading} currentUserId={user?.id} />}
      </div>

      {/* Trends */}
      <div className="grid gap-4 xl:grid-cols-3">
        <section className="premium-card flex h-full flex-col p-0" aria-labelledby="availability-title">
          <div className="th-panel-head">
            <h2 id="availability-title">Availability</h2>
            <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>Last 30 days</span>
          </div>
          <div className="flex flex-1 flex-col px-5 pb-4">
            <p className="th-metric-big">{insights?.availability.overall_pct != null ? `${insights.availability.overall_pct.toFixed(2)}%` : "—"}</p>
            <p className="mb-3 mt-1 text-[12px]" style={{ color: "var(--th-text-muted)" }}>Share of time managed devices were online</p>
            <div className="min-h-0 flex-1">
              {insights ? <AvailabilityChart series={insights.availability.series} /> : <div className="h-full min-h-[120px] animate-pulse rounded-lg" style={{ background: "var(--th-chip-bg)" }} />}
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
              <span className="flex items-center gap-1.5"><i className="th-legend-swatch" data-series="1" />Opened</span>
              <span className="flex items-center gap-1.5"><i className="th-legend-swatch" data-series="2" />Resolved</span>
            </span>
          </div>
          <div className="flex flex-1 flex-col px-5 pb-4">
            <div className="mb-3 grid grid-cols-3 gap-3">
              {([
                ["Opened", insights?.alerts.opened_total],
                ["Resolved", insights?.alerts.resolved_total],
                ["Avg. time to resolve", insights?.alerts.mean_time_to_resolve_hours != null ? `${insights.alerts.mean_time_to_resolve_hours} h` : undefined],
              ] as const).map(([label, value]) => (
                <div key={label}>
                  <p className="text-[20px] font-semibold tabular-nums" style={{ color: "var(--th-text-primary)" }}>{value ?? "—"}</p>
                  <p className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>{label}</p>
                </div>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {insights ? <AlertFlowChart series={insights.alerts.series} /> : <div className="h-full min-h-[120px] animate-pulse rounded-lg" style={{ background: "var(--th-chip-bg)" }} />}
            </div>
          </div>
          <p className="th-panel-foot">{insights ? `${insights.alerts.open_now} still open right now.` : "Loading…"}</p>
        </section>

        <section className="premium-card flex h-full flex-col p-0" aria-labelledby="problem-devices-title">
          <div className="th-panel-head">
            <h2 id="problem-devices-title">Problem devices</h2>
            <span className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>Last 7 days</span>
          </div>
          {!insights ? (
            <p className="flex-1 px-5 py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>Loading…</p>
          ) : insights.problem_devices.length === 0 ? (
            <EmptyState className="flex-1" icon={<HeartPulse className="h-5 w-5" />} title="No repeat offenders" description="No device went offline or raised an alert this week." />
          ) : (
            <ul className="flex-1 px-2 pb-2">
              {insights.problem_devices.map((d, i) => (
                <li key={d.device_id}>
                  <Link to={`/devices?device=${d.device_id}`} className="th-list-row">
                    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-[12px] font-semibold tabular-nums" style={{ background: "var(--th-chip-bg)", color: "var(--th-text-muted)" }}>{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>{d.name}</span>
                      <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>{d.client_name ?? "No client"}</span>
                    </span>
                    <span className="text-right text-[12px] leading-5 tabular-nums" style={{ color: "var(--th-text-secondary)" }}>
                      <span className="block"><strong className="font-semibold" style={{ color: "var(--th-text-primary)" }}>{d.offline_events}</strong> offline</span>
                      <span className="block"><strong className="font-semibold" style={{ color: "var(--th-text-primary)" }}>{d.alerts}</strong> alerts</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="th-panel-foot">Ranked by offline events plus alerts raised.</p>
        </section>
      </div>

      {/* Enrollments · activity */}
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="premium-card flex h-full flex-col p-0" aria-labelledby="enrollments-title">
          <div className="th-panel-head">
            <h2 id="enrollments-title">Latest enrollments</h2>
            <Link to="/devices" className="th-link-btn">View all devices</Link>
          </div>
          {loading ? (
            <p className="flex-1 px-5 py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>Loading devices…</p>
          ) : recentDevices.length === 0 ? (
            <EmptyState className="flex-1" icon={<Monitor className="h-5 w-5" />} title="No devices yet" description="Enrolled devices appear here as soon as their agent checks in." />
          ) : (
            <ul className="flex-1 px-2 pb-2">
              {recentDevices.slice(0, 6).map((device) => (
                <li key={device.id}>
                  <Link to={`/devices?device=${device.id}`} className="th-list-row">
                    <span className="th-palette-icon !h-8 !w-8">
                      <Monitor className="h-4 w-4" />
                      <i style={{ background: device.freshness_state === "online" ? "var(--th-status-online)" : device.freshness_state === "stale" ? "var(--th-status-stale)" : "var(--th-status-offline)" }} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>{device.hostname || "Unknown"}</span>
                      <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                        {[device.client_name || "No client", device.current_user, device.public_ip].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${statusBadgeClass(device)}`}>
                        {device.freshness_state ?? device.status}
                      </span>
                      <span className="mt-0.5 block text-[11px] tabular-nums" style={{ color: "var(--th-text-faint)" }}>{formatDate(device.registered_at)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="premium-card flex h-full flex-col p-0" aria-labelledby="activity-title">
          <div className="th-panel-head">
            <h2 id="activity-title">Recent remote actions</h2>
            {hasPermission("audit_log") && <Link to="/audit" className="th-link-btn">Audit log</Link>}
          </div>
          {loading ? (
            <p className="flex-1 px-5 py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>Loading actions…</p>
          ) : recentActions.length === 0 ? (
            <EmptyState className="flex-1 justify-center" icon={<Terminal className="h-5 w-5" />} title="No remote actions yet" description="Restarts, syncs and scripts sent to devices show up here with their result." />
          ) : (
            <ul className="flex-1 px-2 pb-2">
              {recentActions.slice(0, 6).map((action) => {
                const isRunning = action.status === "running";
                const relevantTime = action.completed_at ?? action.failed_at ?? action.started_at ?? action.sent_at ?? action.created_at;
                return (
                  <li key={action.id}>
                    <div className="th-list-row">
                      <span className="th-palette-icon !h-8 !w-8">
                        {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Terminal className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
                          {ACTION_LABELS[action.action_type as ActionType] ?? action.action_type}
                          <span style={{ color: "var(--th-text-muted)" }}> · {action.device_hostname ?? `Device #${action.device_id}`}</span>
                        </span>
                        <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                          {action.created_by ? `by ${action.created_by} · ` : ""}{actionTimeAgo(relevantTime)}
                        </span>
                      </span>
                      <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${statusColor(action.status)}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${statusDotColor(action.status)}`} />
                        {ACTION_STATUS_LABELS[action.status] ?? action.status}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      </div>{/* end hidden md:block */}
    </section>
  );
}

function HealthRing({ value }: { value: number | null }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const tone = value == null ? "var(--th-text-faint)" : value < 50 ? "var(--th-status-critical)" : value < 80 ? "var(--th-status-warning)" : "var(--th-status-online)";
  return (
    <div className="relative h-[88px] w-[88px] flex-none" role="img" aria-label={value == null ? "No health score" : `Average health ${value} of 100`}>
      <svg viewBox="0 0 88 88" className="h-full w-full -rotate-90">
        <circle cx="44" cy="44" r={r} fill="none" strokeWidth="8" style={{ stroke: "var(--th-ring-track)" }} />
        <circle cx="44" cy="44" r={r} fill="none" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(pct / 100) * c} ${c}`} style={{ stroke: tone, transition: "stroke-dasharray 600ms ease" }} />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[22px] font-semibold leading-none tabular-nums" style={{ color: "var(--th-text-primary)" }}>{value ?? "—"}</span>
        <span className="mt-1 text-[11px]" style={{ color: "var(--th-text-faint)" }}>of 100</span>
      </span>
    </div>
  );
}

function OperatorsPanel({ operators, loading, currentUserId }: { operators: OperatorPresenceRecord[]; loading: boolean; currentUserId?: number }) {
  return (
    <section className="premium-card flex h-full flex-col p-0" aria-labelledby="operators-title">
      <div className="th-panel-head">
        <h2 id="operators-title">Operators</h2>
        <span className="th-nav-badge">{operators.filter((op) => op.is_online).length} online</span>
      </div>
      {loading ? (
        <p className="flex-1 px-5 py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>Loading…</p>
      ) : operators.length === 0 ? (
        <EmptyState className="flex-1" icon={<Users className="h-5 w-5" />} title="No operators online" />
      ) : (
        <ul className="flex-1 px-2 pb-2">
          {operators.map((op) => {
            const label = op.display_name ?? op.username;
            return (
              <li key={op.id} className="th-list-row">
                <span className="th-avatar">{label.charAt(0).toUpperCase()}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
                    {label}{op.id === currentUserId && <span style={{ color: "var(--th-text-muted)" }}> (you)</span>}
                  </span>
                  <span className="block truncate text-[12px] capitalize" style={{ color: "var(--th-text-muted)" }}>{op.role}</span>
                </span>
                <span className="th-status-chip" style={{ "--chip-tone": op.is_online ? "var(--th-status-online)" : "var(--th-status-offline)" } as React.CSSProperties}>
                  <i />{op.is_online ? "Online" : "Offline"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
