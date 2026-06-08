import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  HeartPulse,
  Loader2,
  RefreshCcw,
  Server,
  Shield,
  ShieldCheck,
  Terminal,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Device, getDevicesSummary } from "../api/devices";
import { getRecentDeployments, RecentDeployment } from "../api/deployments";
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
import { Badge, Button } from "../components/ui";
import { parseUTC, timeAgo } from "../utils/time";
import { useDeviceRealtime } from "../hooks/useDeviceRealtime";
import { usePollingRefresh } from "../hooks/usePollingRefresh";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";

const formatDate = (iso?: string) => {
  if (!iso) return "Unknown";
  return parseUTC(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const deploymentStatusColor = (status: RecentDeployment["status"]) => {
  if (status === "success") return "border-emerald-400/25 bg-emerald-400/10 text-emerald-200";
  if (status === "warning") return "border-amber-400/25 bg-amber-400/10 text-amber-200";
  return "border-rose-400/25 bg-rose-400/10 text-rose-200";
};

function actionTimeAgo(iso?: string | null): string {
  return iso ? timeAgo(iso) : "—";
}

const compactBadgeClass = "!px-1 !py-0 !text-[8px] !leading-3";
const assignmentBadgeClass = `${compactBadgeClass} !border-slate-500/30 !bg-slate-500/10 !text-slate-500`;
const METRIC_REFRESH_MIN_MS = 10000;

const assignmentSourceLabel = (device: Device) => {
  const source = device.assignment_source || "system_auto_unassigned";
  if (source === "enrollment_token") return "token";
  if (source === "manual") return "manual";
  if (source === "system_auto") return "auto";
  return "unassigned";
};

const statusBadgeClass = (device: Device) => {
  const state = device.freshness_state ?? device.status;
  if (state === "online") return "border-emerald-400/25 bg-emerald-400/10 text-emerald-200";
  if (state === "stale") return "border-amber-300/30 bg-amber-300/10 text-amber-100";
  return "border-slate-500/20 bg-slate-500/10 text-slate-300";
};

export default function Dashboard() {
  const { user, hasPermission } = useAuth();

  const [total, setTotal] = useState(0);
  const [online, setOnline] = useState(0);
  const [stale, setStale] = useState(0);
  const [offline, setOffline] = useState(0);
  const [averageHealth, setAverageHealth] = useState<number | null>(null);
  const [recentDevices, setRecentDevices] = useState<Device[]>([]);
  const [deployments, setDeployments] = useState<RecentDeployment[]>([]);
  const [recentActions, setRecentActions] = useState<RemoteActionWithDevice[]>([]);
  const [operators, setOperators] = useState<OperatorPresenceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [patchCount, setPatchCount] = useState(0);
  const [criticalCount, setCriticalCount] = useState(0);
  const [favoritesCount] = useState(() => { try { const raw = localStorage.getItem('techi.favorites'); return raw ? (JSON.parse(raw) as number[]).length : 0; } catch { return 0; } });
  const [error, setError] = useState<string | null>(null);
  const [lastRealtimeEvent, setLastRealtimeEvent] = useState<DeviceRealtimeEvent | null>(null);
  const firstLoadDoneRef = useRef(false);
  const refreshTimerRef = useRef<number | undefined>();
  const lastMetricRefreshRef = useRef(0);

  const loadDashboard = useCallback(async () => {
    const showLoading = !firstLoadDoneRef.current;
    const canDeployment = hasPermission("deployment");
    try {
      if (showLoading) {
        setLoading(true);
      }
      setError(null);

      const [snapshot, recentDeployments, latestActions, presenceList] = await Promise.all([
        getDevicesSummary().catch(err => {
          console.error("Fleet summary error:", err);
          setError("Fleet statistics are temporarily unavailable. Other dashboard data is still shown.");
          return null;
        }),
        canDeployment ? getRecentDeployments().catch(() => [] as RecentDeployment[]) : Promise.resolve([] as RecentDeployment[]),
        getRecentActions(10).catch(() => [] as RemoteActionWithDevice[]),
        getOperatorPresence().catch(() => [] as OperatorPresenceRecord[]),
      ]);
      const stats = snapshot?.stats;
      const healthSummary = snapshot?.health ?? [];
      const scoreTotal = healthSummary.reduce((sum, item) => sum + item.health_score, 0);
      const sortedDevices = snapshot?.devices ?? [];

      if (stats) {
        setTotal(stats.total);
        setOnline(stats.online);
        setStale(stats.stale);
        setOffline(stats.offline);
      }
      setAverageHealth(healthSummary.length > 0 ? Math.round(scoreTotal / healthSummary.length) : null);
      setPatchCount((snapshot?.patches ?? []).filter(p => p.patch_state === "updates_available" || p.patch_state === "reboot_required").length);
      setCriticalCount(healthSummary.filter(h => h.health_score < 50).length);
      setRecentDevices(sortedDevices.slice(0, 5));
      setDeployments(recentDeployments.slice(0, 4));
      setRecentActions(latestActions);
      setOperators(presenceList);
      firstLoadDoneRef.current = true;
    } catch (err) {
      console.error('Dashboard load error:', err);
      setError(err instanceof Error ? err.message : "Unable to load dashboard data");
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [hasPermission]);

  const loadDashboardMetrics = useCallback(async () => {
    try {
      const snapshot = await getDevicesSummary();
      const stats = snapshot.stats;
      const healthSummary = snapshot.health;
      const scoreTotal = healthSummary.reduce((sum, item) => sum + item.health_score, 0);
      setTotal(stats.total);
      setOnline(stats.online);
      setStale(stats.stale);
      setOffline(stats.offline);
      setAverageHealth(healthSummary.length > 0 ? Math.round(scoreTotal / healthSummary.length) : null);
      setCriticalCount(healthSummary.filter(h => h.health_score < 50).length);
      setPatchCount(snapshot.patches.filter(p => p.patch_state === "updates_available" || p.patch_state === "reboot_required").length);
    } catch {
      // dashboard metrics are refreshed again by fallback polling/manual refresh
    }
  }, []);

  const scheduleDashboardRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      return;
    }
    const elapsed = Date.now() - lastMetricRefreshRef.current;
    const delay = Math.max(5000, METRIC_REFRESH_MIN_MS - elapsed);
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = undefined;
      lastMetricRefreshRef.current = Date.now();
      void loadDashboardMetrics();
    }, delay);
  }, [loadDashboardMetrics]);

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

  const realtimeStatus = useDeviceRealtime({
    onEvent: (event) => {
      if (event.type === "connection_ready") {
        return;
      }
      setLastRealtimeEvent(event);
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
        scheduleDashboardRefresh();
      }
      if (event.type === "deployment_event" && hasPermission("deployment")) {
        void getRecentDeployments().then((items) => setDeployments(items.slice(0, 4))).catch(() => undefined);
      }
    },
  });

  const { runNow: refreshDashboard } = usePollingRefresh(loadDashboard, {
    intervalMs: 120000,
    enabled: realtimeStatus !== "connected",
    immediate: !firstLoadDoneRef.current,
  });

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

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
  const healthBar =
    averageHealth == null
      ? "bg-amber-400"
      : averageHealth < 50
      ? "bg-red-400"
      : averageHealth < 80
      ? "bg-amber-400"
      : "bg-emerald-400";
  const canDeployment = hasPermission("deployment");

  return (
    <section className="premium-page space-y-4">
      <div className="premium-card overflow-hidden p-4 md:p-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="premium-kicker">TECHI Mission Control</p>
              <Badge variant="ghost">Live API</Badge>
            </div>
            <h1 className="mt-1.5 text-2xl font-semibold text-white md:text-3xl">
              Remote operations <span className="premium-accent-text">dashboard</span>
            </h1>
            <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-300">
              Dense MSP visibility for device health, deployment cadence, and active operations. Metrics continue to refresh from the existing backend polling flow.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void refreshDashboard()}>
              <RefreshCcw className="h-4 w-4" />
              Refresh
            </Button>
            <Badge variant="primary">{loading ? "Syncing" : `${availability}% availability`}</Badge>
              <Badge variant="ghost">{realtimeStatus === "connected" ? "Realtime" : "Polling fallback"}</Badge>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          {error}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="premium-metric p-4">
          <div className="flex items-center justify-between">
            <p className="premium-kicker">Total Devices</p>
            <Server className="h-4 w-4 text-orange-400/60" />
          </div>
          <p className="mt-2 text-3xl font-bold text-white">{loading ? "—" : total}</p>
          <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
            <span>Managed endpoints</span>
            <Badge variant="ghost">Inventory</Badge>
          </div>
        </div>

        <div className="premium-metric metric-online p-4">
          <div className="flex items-center justify-between">
            <p className="premium-kicker">Online</p>
            <Wifi className="h-4 w-4 text-emerald-400/70" />
          </div>
          <p className="mt-2 text-3xl font-bold text-emerald-300">{loading ? "—" : online}</p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.04]">
            <div className="h-full rounded-full bg-emerald-400/70 transition-all duration-500" style={{ width: loading ? "0%" : `${availability}%` }} />
          </div>
        </div>

        <div className="premium-metric metric-warning p-4">
          <div className="flex items-center justify-between">
            <p className="premium-kicker">Stale</p>
            <Clock3 className="h-4 w-4 text-amber-400/80" />
          </div>
          <p className="mt-2 text-3xl font-bold text-amber-200">{loading ? "—" : stale}</p>
          <p className="mt-3 text-xs text-slate-400">Seen within the last 15 minutes.</p>
        </div>

        <div className="premium-metric metric-offline p-4">
          <div className="flex items-center justify-between">
            <p className="premium-kicker">Offline</p>
            <WifiOff className="h-4 w-4 text-slate-500" />
          </div>
          <p className="mt-2 text-3xl font-bold text-slate-200">{loading ? "—" : offline}</p>
          <p className="mt-3 text-xs text-slate-400">Triage queue for unreachable devices.</p>
        </div>
      </div>

      {/* Fleet Operations Quick Access */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Link to="/devices?filter=favorites" className="group rounded-xl p-4 transition-all hover:opacity-90"
          style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}>
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--th-text-muted)" }}>My Devices</p>
            <span className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: "#fbbf24" }}>★ Fav</span>
          </div>
          <p className="mt-2 text-2xl font-bold" style={{ color: favoritesCount > 0 ? "#fbbf24" : "var(--th-text-muted)" }}>
            {favoritesCount}
          </p>
          <p className="mt-1 text-[10px]" style={{ color: "var(--th-text-muted)" }}>Starred devices</p>
        </Link>

        <Link to="/devices?filter=low_health" className="group rounded-xl p-4 transition-all hover:opacity-90"
          style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}>
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--th-text-muted)" }}>Critical Health</p>
          </div>
          <p className="mt-2 text-2xl font-bold" style={{ color: criticalCount > 0 ? "#f87171" : "var(--th-text-muted)" }}>
            {loading ? "—" : criticalCount}
          </p>
          <p className="mt-1 text-[10px]" style={{ color: "var(--th-text-muted)" }}>Health score &lt; 50</p>
        </Link>

        <Link to="/devices?filter=offline" className="group rounded-xl p-4 transition-all hover:opacity-90"
          style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}>
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--th-text-muted)" }}>Offline Now</p>
          </div>
          <p className="mt-2 text-2xl font-bold" style={{ color: offline > 0 ? "#94a3b8" : "var(--th-text-muted)" }}>
            {loading ? "—" : offline}
          </p>
          <p className="mt-1 text-[10px]" style={{ color: "var(--th-text-muted)" }}>Not responding</p>
        </Link>

        <Link to="/devices?filter=needs_updates" className="group rounded-xl p-4 transition-all hover:opacity-90"
          style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}>
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--th-text-muted)" }}>Needs Updates</p>
          </div>
          <p className="mt-2 text-2xl font-bold" style={{ color: patchCount > 0 ? "#fbbf24" : "var(--th-text-muted)" }}>
            {loading ? "—" : patchCount}
          </p>
          <p className="mt-1 text-[10px]" style={{ color: "var(--th-text-muted)" }}>Pending patches</p>
        </Link>
      </div>

      <div className="premium-card-soft p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className={`flex h-10 w-10 items-center justify-center rounded-lg border ${healthTone}`}>
              <HeartPulse className="h-5 w-5" />
            </div>
            <div>
              <p className="premium-kicker">Fleet Health</p>
              <p className="mt-0.5 text-sm font-medium text-slate-300">
                Active-device average excludes archived devices.
              </p>
            </div>
          </div>
          <div className="min-w-[220px]">
            <div className="flex items-end justify-between gap-3">
              <span className="text-2xl font-bold text-white">{loading || averageHealth == null ? "—" : averageHealth}</span>
              <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${healthTone}`}>
                {averageHealth == null ? "No score" : averageHealth < 50 ? "Critical" : averageHealth < 80 ? "Warning" : "Healthy"}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
              <div
                className={`${healthBar} h-full rounded-full transition-all duration-500`}
                style={{ width: loading || averageHealth == null ? "0%" : `${averageHealth}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_360px]">
        <div className="space-y-3">
          <div className="premium-card p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="premium-kicker">Recent Devices</p>
                <h2 className="mt-1.5 text-xl font-semibold text-white">Latest enrollments</h2>
              </div>
              <Link
                to="/devices"
                className="inline-flex items-center rounded-md border border-white/10 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.06] hover:text-white"
              >
                View all
              </Link>
            </div>

            <div className="mt-4 grid gap-3 xl:grid-cols-[220px_minmax(0,1fr)]">
              <div className="rounded-lg border border-white/[0.08] bg-slate-950/55 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="premium-kicker">Status mix</p>
                    <p className="mt-1 text-2xl font-bold text-white">{loading ? "—" : total}</p>
                  </div>
                  <Server className="h-4 w-4 text-orange-300/70" />
                </div>
                <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
                  <div className="bg-emerald-400/80" style={{ width: loading ? "0%" : `${onlinePct}%` }} />
                  <div className="bg-amber-300/80" style={{ width: loading ? "0%" : `${stalePct}%` }} />
                  <div className="bg-slate-500/90" style={{ width: loading ? "0%" : `${offlinePct}%` }} />
                </div>
                <div className="mt-3 space-y-1.5 text-[10px] font-semibold">
                  <div className="flex items-center justify-between text-emerald-300">
                    <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Online</span>
                    <span>{loading ? "—" : online}</span>
                  </div>
                  <div className="flex items-center justify-between text-amber-200">
                    <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-amber-300" />Stale</span>
                    <span>{loading ? "—" : stale}</span>
                  </div>
                  <div className="flex items-center justify-between text-slate-400">
                    <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-slate-500" />Offline</span>
                    <span>{loading ? "—" : offline}</span>
                  </div>
                </div>
              </div>

            <div className="overflow-hidden rounded-lg border border-white/[0.08]">
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-[10px]">
                  <thead className="bg-slate-950/90">
                    <tr className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                      <th className="px-2 py-1">Remote Support ID</th>
                      <th className="px-2 py-1">Hostname</th>
                      <th className="px-2 py-1">User</th>
                      <th className="px-2 py-1">Assignment</th>
                      <th className="px-2 py-1">Domain</th>
                      <th className="px-2 py-1">Public IP</th>
                      <th className="px-2 py-1">Local IP</th>
                      <th className="px-2 py-1">Type</th>
                      <th className="px-2 py-1">Registered At</th>
                      <th className="px-2 py-1">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04] bg-slate-950/50">
                    {loading ? (
                      <tr>
                        <td colSpan={10} className="px-2 py-3 text-center text-xs font-medium text-slate-500">Loading devices...</td>
                      </tr>
                    ) : recentDevices.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="px-2 py-3 text-center text-xs font-medium text-slate-500">No recent devices</td>
                      </tr>
                    ) : (
                      recentDevices.map((device) => (
                        <tr key={device.id} className="text-slate-300 hover:bg-white/[0.025]">
                          <td className="whitespace-nowrap px-2 py-1 font-semibold text-slate-100">{device.rustdesk_id || "—"}</td>
                          <td className="whitespace-nowrap px-2 py-1 font-semibold text-white">{device.hostname || "Unknown"}</td>
                          <td className="whitespace-nowrap px-2 py-1">{device.current_user || "—"}</td>
                          <td className="px-2 py-1">
                            <div className="whitespace-nowrap font-semibold text-slate-100">{device.client_name || "No client"}</div>
                            <div className="flex items-center gap-0.5 whitespace-nowrap text-[9px] text-slate-500">
                              <span>{device.group_name || "No group"}</span>
                              <Badge variant="neutral" className={assignmentBadgeClass}>{assignmentSourceLabel(device)}</Badge>
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-2 py-1">{device.domain || "—"}</td>
                          <td className="whitespace-nowrap px-2 py-1">{device.public_ip || "—"}</td>
                          <td className="whitespace-nowrap px-2 py-1">{device.local_ip || "—"}</td>
                          <td className="whitespace-nowrap px-2 py-1">{device.device_type}</td>
                          <td className="whitespace-nowrap px-2 py-1">{formatDate(device.registered_at)}</td>
                          <td className="whitespace-nowrap px-2 py-1">
                            <span className={`rounded-full border px-1 py-0 text-[9px] font-semibold leading-4 ${statusBadgeClass(device)}`}>
                              {device.freshness_state ?? device.status}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            </div>
          </div>

          {canDeployment && (
          <div className="premium-card p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="premium-kicker">Recent Deployments</p>
                <h2 className="mt-1.5 text-xl font-semibold text-white">Latest activity</h2>
              </div>
              <Badge variant="ghost">API driven</Badge>
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border border-white/[0.08]">
              {loading ? (
                <p className="px-2.5 py-3 text-center text-xs font-medium text-slate-500">Loading deployments...</p>
              ) : (
                <table className="min-w-full text-left text-[11px]">
                  <thead className="bg-slate-950/90">
                    <tr className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                      <th className="px-2.5 py-1">Title</th>
                      <th className="px-2.5 py-1">Environment</th>
                      <th className="px-2.5 py-1">Time</th>
                      <th className="px-2.5 py-1">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04] bg-slate-950/50">
                    {deployments.map((deployment) => (
                      <tr key={deployment.id} className="text-slate-300">
                        <td className="px-2.5 py-1.5 font-semibold text-white">{deployment.title}</td>
                        <td className="px-2.5 py-1.5 text-slate-400">{deployment.environment}</td>
                        <td className="px-2.5 py-1.5 text-slate-400">{formatDate(deployment.timestamp)}</td>
                        <td className="px-2.5 py-1.5">
                          <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${deploymentStatusColor(deployment.status)}`}>
                            {deployment.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          )}

          <div className="premium-card p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="premium-kicker">Remote Actions</p>
                <h2 className="mt-1.5 text-xl font-semibold text-white">Recent fleet actions</h2>
              </div>
              <Terminal className="h-4 w-4 text-orange-300/70" />
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border border-white/[0.08]">
              {loading ? (
                <p className="px-2.5 py-3 text-center text-xs font-medium text-slate-500">Loading actions...</p>
              ) : recentActions.length === 0 ? (
                <p className="px-2.5 py-3 text-center text-xs font-medium text-slate-500">No actions yet</p>
              ) : (
                <table className="min-w-full text-left text-[11px]">
                  <thead className="bg-slate-950/90">
                    <tr className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                      <th className="px-2.5 py-1">Device</th>
                      <th className="px-2.5 py-1">Action</th>
                      <th className="px-2.5 py-1">By</th>
                      <th className="px-2.5 py-1">Status</th>
                      <th className="px-2.5 py-1">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04] bg-slate-950/50">
                    {recentActions.map((action) => {
                      const isRunning = action.status === "running";
                      const relevantTime = action.completed_at ?? action.failed_at ?? action.started_at ?? action.sent_at ?? action.created_at;
                      return (
                        <tr key={action.id} className="text-slate-300 hover:bg-white/[0.025]">
                          <td className="whitespace-nowrap px-2.5 py-1.5 font-semibold text-slate-100">
                            {action.device_hostname ?? `#${action.device_id}`}
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 text-slate-200">
                            {ACTION_LABELS[action.action_type as ActionType] ?? action.action_type}
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 text-slate-500">
                            {action.created_by ?? "—"}
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-1.5">
                            <span className="inline-flex items-center gap-1">
                              {isRunning ? (
                                <Loader2 className="h-2.5 w-2.5 animate-spin text-sky-400" />
                              ) : (
                                <span className={`h-1.5 w-1.5 rounded-full ${statusDotColor(action.status)}`} />
                              )}
                              <span className={`text-[9px] font-semibold ${statusColor(action.status)}`}>
                                {ACTION_STATUS_LABELS[action.status] ?? action.status}
                              </span>
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 text-slate-500">
                            {actionTimeAgo(relevantTime)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        <aside className="space-y-3">
          <div className="premium-card p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="premium-kicker">Operators</p>
                <h2 className="mt-1.5 text-lg font-semibold text-white">Active panel</h2>
              </div>
              <Users className="h-5 w-5 text-orange-300" />
            </div>

            <div className="mt-4 space-y-2.5">
              {loading ? (
                <p className="py-2 text-center text-xs text-slate-500">Loading…</p>
              ) : operators.length === 0 ? (
                <p className="py-2 text-center text-xs text-slate-500">No active operators</p>
              ) : (
                operators.map((op) => {
                  const label = op.display_name ?? op.username;
                  const online = op.is_online;
                  const lastSeen = op.last_active_at
                    ? new Date(op.last_active_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
                    : null;
                  return (
                    <div key={op.id} className="premium-card-soft flex items-center justify-between gap-3 p-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={`mt-px h-2 w-2 shrink-0 rounded-full ${online ? "bg-emerald-400 shadow-[0_0_6px_1px_rgba(52,211,153,0.5)]" : "bg-slate-600"}`}
                          title={online ? "Online" : "Offline"}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <p className="truncate font-semibold text-white">{label}</p>
                            {op.id === user?.id && (
                              <span className="rounded-full border border-techi-orange/30 bg-techi-orange/10 px-1.5 py-0 text-[9px] font-bold uppercase tracking-wide text-techi-orange">
                                you
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-500">
                            <Shield className="h-2.5 w-2.5" />
                            <span className="capitalize">{op.role}</span>
                            {lastSeen && <><span className="text-slate-700">·</span><span>last {lastSeen}</span></>}
                          </div>
                        </div>
                      </div>
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                          online
                            ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"
                            : "border-slate-500/30 bg-slate-800/60 text-slate-400"
                        }`}
                      >
                        {online ? "Online" : "Offline"}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="premium-card p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="premium-kicker">Operations</p>
                <h2 className="mt-1.5 text-lg font-semibold text-white">Activity stream</h2>
              </div>
              <Activity className="h-5 w-5 text-pink-300" />
            </div>

            <div className="mt-4 space-y-2.5 text-sm font-medium text-slate-300">
              <div className="premium-card-soft flex items-start gap-3 p-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-300" />
                <div>
                  <p className="font-semibold text-white">Inventory synchronized</p>
                  <p className="mt-1">
                    {lastRealtimeEvent
                      ? `${lastRealtimeEvent.type.replace(/_/g, " ")}${lastRealtimeEvent.data?.hostname ? ` from ${lastRealtimeEvent.data.hostname}` : ""}`
                      : "Live counts refreshed from the backend."}
                  </p>
                </div>
              </div>
              <div className="premium-card-soft flex items-start gap-3 p-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-300" />
                <div>
                  <p className="font-semibold text-white">{offline} offline devices</p>
                  <p className="mt-1">Review the device tree for endpoint triage.</p>
                </div>
              </div>
              <div className="premium-card-soft flex items-start gap-3 p-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 text-orange-300" />
                <div>
                  <p className="font-semibold text-white">TECHI Remote Support native path</p>
                  <p className="mt-1">Connect action remains ready for native launch.</p>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
