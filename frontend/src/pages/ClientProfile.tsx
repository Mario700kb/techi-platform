import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BellRing,
  BookOpen,
  ExternalLink,
  HeartPulse,
  LayoutDashboard,
  Layers,
  Monitor,
  PackageCheck,
  RefreshCcw,
  Search,
  ServerOff,
  Ticket,
  Wifi,
} from "lucide-react";

import { ACTION_LABELS } from "../api/audit";
import { useAuth } from "../auth/AuthContext";
import ClientDocuments from "../components/ClientDocuments";
import { getAlerts } from "../api/alerts";
import { ClientProfile, getClientActivity, getClientProfile, getClients, getGroups } from "../api/clients";
import { CONNECT_REFRESH_EVENT, ConnectRowStatus, getConnectStatuses } from "../api/connect";
import { Device, DeviceStats, getDevice, getDevices, getDeviceTableDetails, getFleetInsights } from "../api/devices";
import { getConnectUrl } from "../api/remoteSupport";
import AlertKindIcon from "../components/AlertKindIcon";
import BreakdownBars, { BreakdownRow, CATEGORY_LABELS } from "../components/BreakdownBars";
import ConnectMenu from "../components/ConnectMenu";
import DeviceDrawer from "../components/DeviceDrawer";
import GenericDeviceDrawer from "../components/GenericDeviceDrawer";
import HealthBadge from "../components/HealthBadge";
import { AlertFlowChart, AvailabilityChart } from "../components/InsightCharts";
import PlatformIcon from "../components/PlatformIcon";
import { Button, ConnectButton, EmptyState, TablePagination } from "../components/ui";
import { useAppData } from "../contexts/AppDataContext";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { useFavorites } from "../hooks/useFavorites";
import { DESKTOP_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { useNow } from "../hooks/useNow";
import { usePlatformFeatures } from "../hooks/usePlatformFeatures";
import { useTabIndicator } from "../hooks/useTabIndicator";
import { DeviceRealtimeEvent } from "../services/deviceRealtime";
import { buildRustDeskFallbackUrlFromTechiUrl, isValidRustDeskId, launchConnect } from "../services/rustdeskLaunch";
import { ALERT_KIND_LABELS, ALERT_SEVERITY_TONE, AlertKind } from "../types/alert";
import { deviceDisplayName } from "../utils/deviceLabel";
import {
  DEVICE_PATCH_EVENTS,
  freshnessTone,
  hasStructuralConnectMethod,
  humanize,
  isDeviceOffline,
  OFFLINE_CONNECT_REASON,
  TERMS,
  TONE,
} from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { detectOperatorOS } from "../utils/operatorOs";
import { formatDateTime, formatLocalDateTime, timeAgo } from "../utils/time";

type Tab = "overview" | "devices" | "alerts" | "activity" | "analytics" | "documents";

const DEVICE_PAGE_SIZES = [20, 50];
const ACTIVITY_PAGE_SIZE = 25;

function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_.]+/)
    .filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

function healthTone(score: number | null): string {
  if (score == null) return TONE.neutral;
  if (score < 50) return TONE.critical;
  if (score < 80) return TONE.warning;
  return TONE.online;
}

function parseDetails(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The event's fields over the device it names; the same object when nothing it shows changed. */
function mergeDeviceEvent(device: Device, event: DeviceRealtimeEvent | null): Device {
  const data = event?.data;
  if (!event || !data || data.id !== device.id || !DEVICE_PATCH_EVENTS.has(event.type)) return device;
  const next = { ...device, ...data } as Device;
  const changed = (Object.keys(data) as (keyof typeof data)[]).some(
    (field) => device[field as keyof Device] !== next[field as keyof Device],
  );
  return changed ? next : device;
}

// Same window as the Devices page opens: one per device, so a second click
// focuses the open terminal instead of starting another session.
function openTerminalWindow(device: Device): boolean {
  const name = deviceDisplayName(device);
  const win = window.open(
    `/terminal/${device.id}?name=${encodeURIComponent(name)}`,
    `techi-terminal-${device.id}`,
    "width=1024,height=640,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes",
  );
  win?.focus();
  return Boolean(win);
}

function SectionCard({
  title,
  action,
  children,
  index,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  index: number;
}) {
  return (
    <section className="premium-card th-onb-enter flex h-full flex-col p-0" style={{ "--i": index } as CSSProperties}>
      <div className="th-panel-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function PanelSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="px-5 pb-4" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.15 }} />
      ))}
    </div>
  );
}

export default function ClientProfilePage() {
  useNow();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const clientId = id ? Number(id) : NaN;
  const valid = Number.isInteger(clientId) && clientId > 0;

  const [tab, setTab] = useState<Tab>("overview");
  const [opened, setOpened] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(["overview"]));
  const tabsRef = useTabIndicator<HTMLDivElement>(tab);
  const openTab = (next: Tab) => {
    setTab(next);
    setOpened((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  };

  const profileQuery = useCachedQuery(valid ? `page.client.${clientId}.profile` : null, () =>
    getClientProfile(clientId),
  );
  const activityPreview = useCachedQuery(valid ? `mem.client.${clientId}.activity:0` : null, () =>
    getClientActivity(clientId, 6, 0),
  );
  const profile = profileQuery.data;
  const reloadProfile = profileQuery.reload;

  // ── device drawer ── opened in place from any device on the profile, the
  // same drawer the Devices page uses. Phones open the device's own page.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const { latestEvent } = useAppData();
  const { favorites, toggle: toggleFavorite } = useFavorites();
  const [drawerDevice, setDrawerDevice] = useState<Device | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [updatedDevice, setUpdatedDevice] = useState<Device | null>(null);
  const [orgWanted, setOrgWanted] = useState(false);
  const drawerCloseTimer = useRef<number | undefined>();
  const drawerRequest = useRef(0);
  // Clients and groups for the drawer's Management tab, loaded on first open.
  const org = useCachedQuery(orgWanted ? "page.client-profile.org" : null, () =>
    Promise.all([getClients(), getGroups()]),
  );

  const openDevice = useCallback(
    (target: Device | number) => {
      const id = typeof target === "number" ? target : target.id;
      if (!isDesktop) {
        navigate(`/devices/${id}`);
        return;
      }
      window.clearTimeout(drawerCloseTimer.current);
      setOrgWanted(true);
      const request = ++drawerRequest.current;
      if (typeof target !== "number") {
        setDrawerDevice(target);
        setDrawerOpen(true);
        return;
      }
      getDevice(id)
        .then((device) => {
          if (request !== drawerRequest.current) return;
          setDrawerDevice(device);
          setDrawerOpen(true);
        })
        .catch(() => {
          if (request === drawerRequest.current) navigate(`/devices?device=${id}`);
        });
    },
    [isDesktop, navigate],
  );

  const closeDrawer = useCallback(() => {
    drawerRequest.current += 1;
    setDrawerOpen(false);
    window.clearTimeout(drawerCloseTimer.current);
    // Unmount only after the close slide (260ms in index.css) has finished.
    drawerCloseTimer.current = window.setTimeout(() => setDrawerDevice(null), 300);
  }, []);
  useEffect(() => () => window.clearTimeout(drawerCloseTimer.current), []);

  const handleDeviceUpdated = useCallback(
    (device: Device) => {
      setDrawerDevice(device);
      setUpdatedDevice(device);
      void reloadProfile();
    },
    [reloadProfile],
  );

  // Live: the open drawer follows its device, and a status change on one of
  // this client's devices refreshes the figures (once, after a short quiet).
  const profileRefreshTimer = useRef<number | undefined>();
  useEffect(() => {
    if (!latestEvent) return;
    setDrawerDevice((prev) => (prev ? mergeDeviceEvent(prev, latestEvent) : prev));
    const data = latestEvent.data;
    const ownDevice = data && (data.client_id === clientId || data.resolved_client_id === clientId);
    if (
      ownDevice &&
      ["device_online", "device_offline", "alert_created", "alert_resolved"].includes(latestEvent.type)
    ) {
      window.clearTimeout(profileRefreshTimer.current);
      profileRefreshTimer.current = window.setTimeout(() => void reloadProfile(), 4000);
    }
  }, [latestEvent, clientId, reloadProfile]);
  useEffect(() => () => window.clearTimeout(profileRefreshTimer.current), []);

  if (!valid || (profileQuery.error && !profile)) {
    return (
      <section className="premium-page th-onb space-y-4">
        <div className="th-onb-card">
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title="Couldn't open this client"
            description={valid ? (profileQuery.error ?? "Client not found.") : "Invalid client ID."}
            action={
              <Button size="sm" variant="secondary" onClick={() => navigate("/devices")}>
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to devices
              </Button>
            }
          />
        </div>
      </section>
    );
  }

  if (!profile) {
    return (
      <section className="premium-page th-onb space-y-4" aria-busy="true">
        <div className="th-onb-card">
          <PanelSkeleton rows={3} />
        </div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="th-onb-card th-onb-stat">
              <div className="th-alerts-skeleton w-full" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const { client, stats, alerts } = profile;
  const onlinePct = stats.total > 0 ? Math.round((stats.online / stats.total) * 100) : null;
  const critical = alerts.by_severity.critical ?? 0;
  const warning = alerts.by_severity.warning ?? 0;

  const TABS: { key: Tab; label: string; icon: typeof Monitor; count?: number }[] = [
    { key: "overview", label: "Overview", icon: LayoutDashboard },
    { key: "devices", label: "Devices", icon: Monitor, count: stats.total },
    { key: "alerts", label: "Alerts", icon: BellRing, count: alerts.total_open },
    { key: "activity", label: "Activity", icon: Activity },
    { key: "analytics", label: "Analytics", icon: BarChart3 },
    { key: "documents", label: "Documentation", icon: BookOpen },
  ];

  const kpis = [
    {
      label: "Devices",
      value: formatCount(stats.total),
      hint: `${formatCount(stats.online)} online · ${formatCount(stats.offline)} offline`,
      icon: Monitor,
      tone: TONE.info,
    },
    {
      label: "Online now",
      value: onlinePct == null ? "—" : `${onlinePct}%`,
      hint: stats.stale ? `${formatCount(stats.stale)} stale` : "Of all devices",
      icon: Wifi,
      tone: freshnessTone(onlinePct != null && onlinePct >= 50 ? "online" : stats.total ? "offline" : null),
    },
    {
      label: "Open alerts",
      value: formatCount(alerts.total_open),
      hint: `${formatCount(critical)} critical · ${formatCount(warning)} warning`,
      icon: BellRing,
      tone: critical ? TONE.critical : warning ? TONE.warning : TONE.online,
    },
    {
      label: "Average health",
      value: profile.average_health == null ? "—" : String(profile.average_health),
      hint: `${formatCount(profile.health_critical)} critical · ${formatCount(profile.health_warning)} warning`,
      icon: HeartPulse,
      tone: healthTone(profile.average_health),
    },
    {
      label: "Groups",
      value: formatCount(profile.groups.length),
      hint: (() => {
        const ungrouped = stats.total - profile.groups.reduce((sum, g) => sum + g.devices, 0);
        return ungrouped > 0 ? `${formatCount(ungrouped)} devices without a group` : "Every device grouped";
      })(),
      icon: Layers,
      tone: TONE.maintenance,
    },
    {
      label: "Updates pending",
      value: formatCount(profile.needs_updates),
      hint: profile.agents_outdated ? `${formatCount(profile.agents_outdated)} agents outdated` : "Agents current",
      icon: PackageCheck,
      tone: profile.needs_updates ? TONE.warning : TONE.online,
    },
  ];

  return (
    <section className="premium-page th-onb space-y-4">
      {/* ── identity ──────────────────────────────────────────────────── */}
      <div className="th-onb-card th-team-hero th-onb-enter" style={{ "--team": "var(--th-accent)" } as CSSProperties}>
        <div className="flex flex-wrap items-center gap-4 px-5 py-4">
          <button
            type="button"
            // Opened from a link (no earlier page in the app): back to the device list.
            onClick={() => ((window.history.state?.idx ?? 0) > 0 ? navigate(-1) : navigate("/devices"))}
            className="th-onb-action max-sm:hidden"
            aria-label="Back"
            title="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="th-team-mark th-cp-mark" aria-hidden="true">
            {initials(client.name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              Client
            </div>
            <h1 className="truncate text-[22px] font-semibold leading-7" style={{ color: "var(--th-text-primary)" }}>
              {client.name}
            </h1>
            <p className="truncate text-[13px]" style={{ color: "var(--th-text-muted)" }}>
              {client.description || client.slug}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="th-status-chip !h-8"
              data-live={(client.is_active && stats.online > 0) || undefined}
              style={{ "--chip-tone": client.is_active ? TONE.online : TONE.neutral } as CSSProperties}
            >
              <i />
              {client.is_active ? "Active" : "Inactive"}
            </span>
            {profile.last_seen && (
              <span className="th-status-chip !h-8" title={formatDateTime(profile.last_seen)}>
                Last check-in {timeAgo(profile.last_seen)}
              </span>
            )}
            <Button variant="secondary" size="sm" onClick={() => navigate(`/devices?client=${client.id}`)}>
              <ExternalLink className="h-3.5 w-3.5" />
              Open in Devices
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void profileQuery.reload();
                void activityPreview.reload();
              }}
              disabled={profileQuery.refreshing}
            >
              <RefreshCcw className={`h-3.5 w-3.5 ${profileQuery.refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* ── key figures ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-6">
        {kpis.map((item, index) => (
          <div
            key={item.label}
            className="th-onb-card th-onb-stat th-onb-enter th-cp-kpi"
            style={{ "--i": index + 1, "--onb-tone": item.tone } as CSSProperties}
          >
            <span className="th-onb-icon">
              <item.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                {item.label}
              </div>
              <div
                className="text-[24px] font-semibold leading-8 tabular-nums"
                style={{ color: "var(--th-text-primary)" }}
              >
                {/* Keyed by value: a live change fades the new figure in. */}
                <span key={item.value} className="th-share-count">
                  {item.value}
                </span>
              </div>
              <div className="truncate text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                {item.hint}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── sections ──────────────────────────────────────────────────── */}
      <div className="th-onb-card th-onb-enter" style={{ "--i": 6 } as CSSProperties}>
        <div className="th-alerts-toolbar !border-b-0">
          <div
            ref={tabsRef}
            role="tablist"
            aria-label="Client sections"
            className="th-tabs !flex-nowrap overflow-x-auto"
            style={{ scrollbarWidth: "none" }}
          >
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => openTab(t.key)}
                className="th-tab"
              >
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
                {t.count !== undefined && <span className="th-tab-count">{formatCount(t.count)}</span>}
              </button>
            ))}
            {[{ label: "Tickets", icon: Ticket }].map((t) => (
              <button
                key={t.label}
                type="button"
                role="tab"
                aria-selected={false}
                aria-disabled="true"
                disabled
                className="th-tab"
                title="Coming next"
              >
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
                <span className="th-tag" data-neutral="true">
                  Soon
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div role="tabpanel" key={tab} className="th-onb-panel">
        {tab === "overview" && (
          <OverviewTab
            profile={profile}
            activity={activityPreview.data}
            activityLoading={activityPreview.loading}
            onShowActivity={() => openTab("activity")}
            onOpenDevice={openDevice}
          />
        )}
        {opened.has("devices") && tab === "devices" && (
          <DevicesTab
            clientId={client.id}
            stats={stats}
            onOpenDevice={openDevice}
            selectedId={drawerOpen ? (drawerDevice?.id ?? null) : null}
            latestEvent={latestEvent}
            updatedDevice={updatedDevice}
          />
        )}
        {opened.has("alerts") && tab === "alerts" && <AlertsTab clientId={client.id} onOpenDevice={openDevice} />}
        {opened.has("activity") && tab === "activity" && <ActivityTab clientId={client.id} onOpenDevice={openDevice} />}
        {opened.has("analytics") && tab === "analytics" && (
          <AnalyticsTab clientId={client.id} onOpenDevice={openDevice} />
        )}
        {opened.has("documents") && tab === "documents" && (
          <ClientDocuments clientId={client.id} canWrite={can("operator")} />
        )}
      </div>

      {drawerDevice &&
        // Same choice as the Devices page: a device that reports capabilities
        // uses the registry-driven drawer, every Windows agent the classic one.
        (drawerDevice.capabilities && Object.keys(drawerDevice.capabilities).length > 0 ? (
          <GenericDeviceDrawer
            device={drawerDevice}
            isOpen={drawerOpen}
            onClose={closeDrawer}
            latestEvent={latestEvent}
            clients={org.data?.[0] ?? []}
            groups={org.data?.[1] ?? []}
            canOperate={can("operator")}
            onDeviceUpdated={handleDeviceUpdated}
          />
        ) : (
          <DeviceDrawer
            device={drawerDevice}
            isOpen={drawerOpen}
            onClose={closeDrawer}
            latestEvent={latestEvent}
            clients={org.data?.[0] ?? []}
            groups={org.data?.[1] ?? []}
            onDeviceUpdated={handleDeviceUpdated}
            canOperate={can("operator")}
            isFavorite={favorites.has(drawerDevice.id)}
            onToggleFavorite={toggleFavorite}
          />
        ))}
    </section>
  );
}

// ─── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({
  profile,
  activity,
  activityLoading,
  onShowActivity,
  onOpenDevice,
}: {
  profile: ClientProfile;
  activity?: Awaited<ReturnType<typeof getClientActivity>>;
  activityLoading: boolean;
  onShowActivity: () => void;
  onOpenDevice: (id: number) => void;
}) {
  const { client, stats, alerts } = profile;
  const byCategory: BreakdownRow[] = Object.entries(profile.by_category)
    .filter(([, counts]) => counts.total > 0)
    .map(([category, counts]) => ({
      key: category,
      label: CATEGORY_LABELS[category] ?? humanize(category),
      count: counts.total,
      to: `/devices?client=${client.id}`,
      segments: [
        { label: "online", value: counts.online, tone: TONE.online },
        { label: "stale", value: counts.stale, tone: TONE.stale },
        { label: "offline", value: counts.offline, tone: TONE.offline },
      ],
    }))
    .sort((a, b) => b.count - a.count);
  const byKind: BreakdownRow[] = Object.entries(alerts.by_kind ?? {})
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({
      key: kind,
      label: ALERT_KIND_LABELS[kind as AlertKind] ?? humanize(kind),
      count,
      to: "/alerts",
    }))
    .sort((a, b) => b.count - a.count);
  const byGroup: BreakdownRow[] = profile.groups.map((group) => ({
    key: String(group.id),
    label: group.name,
    count: group.devices,
    to: `/devices?client=${client.id}`,
  }));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard title="Devices by category" index={1}>
        {byCategory.length === 0 ? (
          <EmptyState className="flex-1" icon={<ServerOff className="h-5 w-5" />} title="No devices yet" />
        ) : (
          <BreakdownBars rows={byCategory} total={stats.total} unit="device" />
        )}
      </SectionCard>

      <SectionCard title="Open alerts by type" index={2}>
        {byKind.length === 0 ? (
          <EmptyState
            className="flex-1"
            icon={<BellRing className="h-5 w-5" />}
            title="No open alerts"
            description="Every alert for this client has been resolved."
          />
        ) : (
          <BreakdownBars rows={byKind} total={alerts.total_open} unit="alert" />
        )}
        <p className="th-panel-foot">
          {formatCount(alerts.total_open)} open
          {alerts.devices_affected ? ` on ${formatCount(alerts.devices_affected)} devices` : ""}
          {alerts.oldest_open_at ? ` · oldest ${timeAgo(alerts.oldest_open_at)}` : ""}.
        </p>
      </SectionCard>

      <SectionCard title="Groups" index={3}>
        {byGroup.length === 0 ? (
          <EmptyState className="flex-1" icon={<Monitor className="h-5 w-5" />} title="No groups" />
        ) : (
          <BreakdownBars rows={byGroup} total={stats.total} unit="device" />
        )}
      </SectionCard>

      <SectionCard
        title="Recent activity"
        index={4}
        action={
          <button type="button" className="th-link-btn" onClick={onShowActivity}>
            View all
          </button>
        }
      >
        {activityLoading && !activity ? (
          <PanelSkeleton rows={4} />
        ) : !activity || activity.items.length === 0 ? (
          <EmptyState className="flex-1" icon={<Activity className="h-5 w-5" />} title="No activity yet" />
        ) : (
          <ActivityList page={activity} compact onOpenDevice={onOpenDevice} />
        )}
      </SectionCard>
    </div>
  );
}

// ─── Devices ─────────────────────────────────────────────────────────────────

type StatusFilter = "all" | "online" | "stale" | "offline";

function DevicesTab({
  clientId,
  stats,
  onOpenDevice,
  selectedId,
  latestEvent,
  updatedDevice,
}: {
  clientId: number;
  stats: DeviceStats;
  onOpenDevice: (device: Device) => void;
  selectedId: number | null;
  latestEvent: DeviceRealtimeEvent | null;
  updatedDevice: Device | null;
}) {
  const features = usePlatformFeatures();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEVICE_PAGE_SIZES[0]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const query = search.trim();
  const { data, loading, refreshing, setData } = useCachedQuery(
    `page.client.${clientId}.devices:${JSON.stringify({ page, pageSize, query, status })}`,
    () =>
      getDevices(
        {
          client_id: clientId,
          search: query || undefined,
          freshness_state: status === "all" ? undefined : status,
          sort: "hostname",
          order: "asc",
        },
        (page - 1) * pageSize,
        pageSize,
      ),
  );
  const devices = useMemo(() => data?.devices ?? [], [data]);

  // Rows follow realtime events and edits made in the drawer, in place.
  useEffect(() => {
    if (!latestEvent?.data?.id || !DEVICE_PATCH_EVENTS.has(latestEvent.type)) return;
    setData((prev) => {
      if (!prev) return prev;
      const next = prev.devices.map((device) => mergeDeviceEvent(device, latestEvent));
      return next.some((device, i) => device !== prev.devices[i]) ? { ...prev, devices: next } : prev;
    });
  }, [latestEvent, setData]);
  useEffect(() => {
    if (!updatedDevice) return;
    setData((prev) =>
      prev && prev.devices.some((d) => d.id === updatedDevice.id)
        ? { ...prev, devices: prev.devices.map((d) => (d.id === updatedDevice.id ? updatedDevice : d)) }
        : prev,
    );
  }, [updatedDevice, setData]);

  // Health for the rows on screen, in one request.
  const idsKey = devices.map((d) => d.id).join(",");
  const details = useCachedQuery(idsKey ? `page.client.${clientId}.details:${idsKey}` : null, () =>
    getDeviceTableDetails(idsKey.split(",").map(Number)),
  );
  const healthById = useMemo(
    () => new Map((details.data?.health ?? []).map((item) => [item.device_id, item])),
    [details.data],
  );

  // Credential-aware Connect state for non-Windows rows, one batched request
  // (as on the Devices page), refreshed when a credential or default changes.
  const nonWindowsKey = devices
    .filter((d) => d.platform && d.platform.toLowerCase() !== "windows")
    .map((d) => d.id)
    .join(",");
  const connectStatuses = useCachedQuery(
    features.FEATURE_PLATFORM_CORE && nonWindowsKey ? `mem.client.${clientId}.connect:${nonWindowsKey}` : null,
    () => getConnectStatuses(nonWindowsKey.split(",").map(Number), detectOperatorOS()),
  );
  const reloadConnectStatuses = connectStatuses.reload;
  useEffect(() => {
    const refresh = () => void reloadConnectStatuses();
    window.addEventListener(CONNECT_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(CONNECT_REFRESH_EVENT, refresh);
  }, [reloadConnectStatuses]);
  const connectById = useMemo(
    () => new Map((connectStatuses.data ?? []).map((row) => [row.device_id, row])),
    [connectStatuses.data],
  );

  const [toast, setToast] = useState<{ message: string; ok: boolean } | null>(null);
  const toastTimer = useRef<number | undefined>();
  const showToast = useCallback((message: string, ok: boolean) => {
    setToast({ message, ok });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const filters: { key: StatusFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: stats.total },
    { key: "online", label: "Online", count: stats.online },
    { key: "stale", label: "Stale", count: stats.stale },
    { key: "offline", label: "Offline", count: stats.offline },
  ];
  const filterIndex = filters.findIndex((f) => f.key === status);

  return (
    <div className="th-alerts-card">
      <div className="th-alerts-toolbar !items-center !py-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <label className="th-search th-search-sm w-full max-w-[320px]">
            <Search className="h-3.5 w-3.5 flex-none" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search this client's devices"
              aria-label="Search this client's devices"
            />
          </label>
          <div
            className="th-segmented th-cp-status"
            role="radiogroup"
            aria-label="Device status"
            data-thumb
            style={{ "--seg-n": filters.length, "--seg-i": filterIndex } as CSSProperties}
          >
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                role="radio"
                aria-checked={status === f.key}
                onClick={() => {
                  setStatus(f.key);
                  setPage(1);
                }}
              >
                {f.key !== "all" && <span className="th-status-dot" data-state={f.key} aria-hidden="true" />}
                {f.label}
                <span className="th-inv-seg-count">{formatCount(f.count)}</span>
              </button>
            ))}
          </div>
        </div>
        <Link to={`/devices?client=${clientId}`} className="th-link-btn max-sm:hidden">
          Open in Devices
        </Link>
      </div>
      {loading ? (
        <PanelSkeleton />
      ) : devices.length === 0 ? (
        <EmptyState
          className="py-10"
          icon={<ServerOff className="h-5 w-5" />}
          title={query || status !== "all" ? "No devices match" : "No devices"}
        />
      ) : (
        <div className="th-alerts-scroll th-table-scroll" data-loading={refreshing || undefined}>
          <table className="th-alerts-table th-cp-devices" data-mobile="cards">
            <colgroup>
              <col />
              <col className="w-[130px]" />
              <col className="w-[120px]" />
              <col className="w-[14%]" />
              <col className="w-[15%]" />
              <col className="w-[150px]" />
              <col className="w-[80px]" />
              <col className="w-[132px]" />
            </colgroup>
            <thead>
              <tr>
                <th>Device</th>
                <th>Status</th>
                <th>Health</th>
                <th>Group</th>
                <th>User</th>
                <th>IP address</th>
                <th className="text-right">Agent</th>
                <th className="text-right">
                  <span className="sr-only">Connect</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device: Device, index) => {
                const state = device.freshness_state ?? device.status ?? "offline";
                const health = healthById.get(device.id);
                return (
                  <tr
                    key={device.id}
                    className="th-alerts-row th-cp-row"
                    data-selected={selectedId === device.id || undefined}
                    style={{ "--row": index, "--row-tone": freshnessTone(state) } as CSSProperties}
                    tabIndex={0}
                    aria-label={`Open ${deviceDisplayName(device)}`}
                    onClick={() => onOpenDevice(device)}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        onOpenDevice(device);
                      }
                    }}
                  >
                    <td>
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="th-cp-platform" aria-hidden="true">
                          <PlatformIcon platform={device.platform} size={15} />
                        </span>
                        <span className="min-w-0">
                          <span className="th-alerts-primary">{deviceDisplayName(device)}</span>
                          <span className="th-alerts-secondary font-mono">{device.hostname}</span>
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="flex items-center gap-2">
                        <span className="th-status-dot" data-state={state} aria-hidden="true" />
                        <span key={state} className="th-alerts-primary th-share-count !mt-0 capitalize">
                          {state}
                        </span>
                      </span>
                      <span className="th-alerts-secondary">
                        {device.last_seen ? timeAgo(device.last_seen) : "Never"}
                      </span>
                    </td>
                    <td data-m={health ? undefined : "hide"}>
                      {health ? (
                        <HealthBadge state={health.health_state} score={health.health_score} showLabel />
                      ) : (
                        <span className="th-alerts-secondary !mt-0">—</span>
                      )}
                    </td>
                    <td data-m="hide">
                      <span className="th-alerts-primary">{device.group_name || "No group"}</span>
                    </td>
                    <td data-m="hide">
                      <span className="th-alerts-primary">{device.current_user || "—"}</span>
                      <span className="th-alerts-secondary">{device.domain || ""}</span>
                    </td>
                    <td data-m="hide">
                      <span className="th-alerts-primary font-mono text-[12px]">{device.public_ip || "—"}</span>
                      <span className="th-alerts-secondary font-mono">{device.local_ip || ""}</span>
                    </td>
                    <td className="text-right" data-m="hide">
                      <span className="th-alerts-primary font-mono text-[12px]">{device.agent_version || "—"}</span>
                    </td>
                    <td
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <DeviceConnect
                        device={device}
                        status={connectById.get(device.id)}
                        platformCore={features.FEATURE_PLATFORM_CORE}
                        onOpenDevice={onOpenDevice}
                        onToast={showToast}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 0 && (
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={data.total}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          pageSizeOptions={DEVICE_PAGE_SIZES}
          itemLabel="devices"
          loading={refreshing}
        />
      )}
      {toast && (
        <div
          role="status"
          className="th-toast fixed right-4 top-4 z-[99999] rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg"
          style={{
            background: `color-mix(in srgb, ${toast.ok ? TONE.online : TONE.critical} 15%, transparent)`,
            border: `1px solid color-mix(in srgb, ${toast.ok ? TONE.online : TONE.critical} 30%, transparent)`,
            color: toast.ok ? TONE.online : TONE.critical,
          }}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

/**
 * The row's Connect, as on the Devices page: Windows opens Remote Support
 * directly; other platforms get the split Connect menu (SSH, Winbox, WebFig,
 * terminal). Disabled while the device is offline; stale stays connectable.
 */
function DeviceConnect({
  device,
  status,
  platformCore,
  onOpenDevice,
  onToast,
}: {
  device: Device;
  status?: ConnectRowStatus;
  platformCore: boolean;
  onOpenDevice: (device: Device) => void;
  onToast: (message: string, ok: boolean) => void;
}) {
  const [launching, setLaunching] = useState(false);
  const isWindows = !device.platform || device.platform.toLowerCase() === "windows";
  const offline = isDeviceOffline(device);
  const canConnect =
    !offline &&
    (isWindows
      ? isValidRustDeskId(device.rustdesk_id) && !device.rustdesk_conflict_detected
      : hasStructuralConnectMethod(device));

  if (!isWindows && platformCore) {
    return (
      <div className="inline-flex">
        <ConnectMenu
          variant="row"
          lazyLoad
          deviceId={device.id}
          hostname={device.hostname}
          initialState={status?.state ?? (canConnect ? null : "unavailable")}
          initialStateReason={status?.reason ?? (canConnect ? null : "No Connect method available for this device yet")}
          disabledReason={offline ? OFFLINE_CONNECT_REASON : null}
          onOpenTerminal={() => {
            // Popup blocked: the drawer still gets the operator to the device.
            if (!openTerminalWindow(device)) onOpenDevice(device);
          }}
        />
      </div>
    );
  }

  return (
    <ConnectButton
      size="sm"
      loading={launching}
      disabled={!canConnect || launching}
      aria-label={`Connect to ${deviceDisplayName(device)}`}
      title={
        offline
          ? OFFLINE_CONNECT_REASON
          : isWindows
            ? device.rustdesk_conflict_detected
              ? "Remote Support ID conflict"
              : canConnect
                ? "Open TECHI Remote Support"
                : `${TERMS.remoteSupportId} not resolved yet`
            : "Open device to connect (SSH/Winbox/WebFig/Terminal)"
      }
      onClick={
        isWindows
          ? async () => {
              setLaunching(true);
              try {
                const res = await getConnectUrl(device.id);
                launchConnect(res.connect_url, buildRustDeskFallbackUrlFromTechiUrl(res.connect_url), () =>
                  onToast(`Opening the ${TERMS.remoteSupport} app instead`, true),
                );
              } catch (err) {
                onToast(err instanceof Error ? err.message : "Connect failed", false);
              } finally {
                setLaunching(false);
              }
            }
          : () => onOpenDevice(device)
      }
    />
  );
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

function AlertsTab({ clientId, onOpenDevice }: { clientId: number; onOpenDevice: (id: number) => void }) {
  const [state, setState] = useState<"open" | "resolved">("open");
  const { data, loading, refreshing } = useCachedQuery(`page.client.${clientId}.alerts:${state}`, () =>
    getAlerts({ clientId, state, limit: 100 }),
  );
  const alerts = data ?? [];
  const stateRef = useTabIndicator<HTMLDivElement>(state);

  return (
    <div className="th-alerts-card">
      <div className="th-alerts-toolbar">
        <div ref={stateRef} role="tablist" aria-label="Alert state" className="th-tabs">
          {(["open", "resolved"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={state === s}
              onClick={() => setState(s)}
              className="th-tab capitalize"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <PanelSkeleton />
      ) : alerts.length === 0 ? (
        <EmptyState
          className="py-10"
          icon={<BellRing className="h-5 w-5" />}
          title={state === "open" ? "No open alerts" : "No resolved alerts"}
        />
      ) : (
        <div className="th-alerts-scroll th-table-scroll" data-loading={refreshing || undefined}>
          <table className="th-alerts-table">
            <colgroup>
              <col className="w-[120px]" />
              <col />
              <col className="w-[26%]" />
              <col className="w-[150px]" />
            </colgroup>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Alert</th>
                <th>Device</th>
                <th className="text-right">{state === "open" ? "Opened" : "Resolved"}</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert, index) => {
                const tone = ALERT_SEVERITY_TONE[alert.severity];
                const at = state === "open" ? alert.created_at : (alert.resolved_at ?? alert.updated_at);
                return (
                  <tr
                    key={alert.id}
                    className="th-alerts-row cursor-pointer"
                    style={{ "--row": index } as CSSProperties}
                    onClick={() => alert.device_id && onOpenDevice(alert.device_id)}
                  >
                    <td>
                      <span className="th-status-chip capitalize" style={{ "--chip-tone": tone } as CSSProperties}>
                        <i />
                        {alert.severity}
                      </span>
                    </td>
                    <td>
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="th-alerts-kind" aria-hidden="true">
                          <AlertKindIcon kind={alert.kind} className="h-4 w-4" />
                        </span>
                        <span className="min-w-0">
                          <span className="th-alerts-primary">
                            {ALERT_KIND_LABELS[alert.kind] ?? humanize(alert.kind)}
                          </span>
                          <span className="th-alerts-secondary" title={alert.message}>
                            {alert.message}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="th-alerts-primary">{alert.device_name ?? "—"}</span>
                    </td>
                    <td className="text-right" title={formatDateTime(at)}>
                      <span className="th-alerts-primary tabular-nums">{timeAgo(at)}</span>
                      <span className="th-alerts-secondary tabular-nums">{formatLocalDateTime(at)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Activity ────────────────────────────────────────────────────────────────

function ActivityList({
  page,
  compact = false,
  onOpenDevice,
}: {
  page: Awaited<ReturnType<typeof getClientActivity>>;
  compact?: boolean;
  onOpenDevice: (id: number) => void;
}) {
  return (
    <ul className={`flex flex-col ${compact ? "px-5 pb-3" : ""}`}>
      {page.items.map((entry, index) => {
        const details = parseDetails(entry.details_json);
        const deviceName = entry.device_id != null ? page.device_names[entry.device_id] : undefined;
        const extra = [details.reason, details.method, details.action_type]
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .map(humanize)
          .join(" · ");
        return (
          <li
            key={entry.id}
            className={`th-share-row flex items-start gap-3 ${compact ? "py-2" : "px-4 py-2.5"}`}
            style={
              {
                "--i": index,
                borderTop: index ? "1px solid var(--th-border-subtle)" : undefined,
              } as CSSProperties
            }
          >
            <span className="th-onb-avatar mt-0.5" aria-hidden="true">
              {(entry.operator_username ?? "S").charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]" style={{ color: "var(--th-text-primary)" }}>
                <span className="font-semibold">{entry.operator_username ?? "System"}</span>{" "}
                <span style={{ color: "var(--th-text-secondary)" }}>
                  {(ACTION_LABELS[entry.action] ?? humanize(entry.action)).toLowerCase()}
                </span>
                {deviceName && entry.device_id != null && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="th-alerts-link font-medium"
                      onClick={() => entry.device_id != null && onOpenDevice(entry.device_id)}
                    >
                      {deviceName}
                    </button>
                  </>
                )}
              </div>
              {extra && (
                <div className="truncate text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                  {extra}
                </div>
              )}
            </div>
            <span
              className="flex-none text-right text-[12px] tabular-nums"
              style={{ color: "var(--th-text-muted)" }}
              title={formatDateTime(entry.created_at)}
            >
              {compact ? timeAgo(entry.created_at) : formatLocalDateTime(entry.created_at)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ActivityTab({ clientId, onOpenDevice }: { clientId: number; onOpenDevice: (id: number) => void }) {
  const [page, setPage] = useState(1);
  // Audit data: memory only, never written to the browser's storage.
  const { data, loading, refreshing } = useCachedQuery(`mem.client.${clientId}.activity:${page}`, () =>
    getClientActivity(clientId, ACTIVITY_PAGE_SIZE, (page - 1) * ACTIVITY_PAGE_SIZE),
  );

  return (
    <div className="th-alerts-card">
      {loading ? (
        <PanelSkeleton rows={8} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          className="py-10"
          icon={<Activity className="h-5 w-5" />}
          title="No activity yet"
          description="Remote sessions, actions, terminal sessions and credential use on this client's devices appear here."
        />
      ) : (
        <div className="th-alerts-scroll" data-loading={refreshing || undefined}>
          <ActivityList page={data} onOpenDevice={onOpenDevice} />
        </div>
      )}
      {data && data.total > 0 && (
        <TablePagination
          page={page}
          pageSize={ACTIVITY_PAGE_SIZE}
          total={data.total}
          onPageChange={setPage}
          itemLabel="entries"
          loading={refreshing}
        />
      )}
    </div>
  );
}

// ─── Analytics ───────────────────────────────────────────────────────────────

function AnalyticsTab({ clientId, onOpenDevice }: { clientId: number; onOpenDevice: (id: number) => void }) {
  const { data, loading, error } = useCachedQuery(`page.client.${clientId}.insights`, () =>
    getFleetInsights(30, clientId),
  );
  const figures = useMemo(() => {
    if (!data) return [];
    return [
      {
        label: "Availability, 30 days",
        value: data.availability.overall_pct == null ? "—" : `${data.availability.overall_pct.toFixed(1)}%`,
      },
      { label: "Alerts opened", value: formatCount(data.alerts.opened_total) },
      { label: "Alerts resolved", value: formatCount(data.alerts.resolved_total) },
      {
        label: "Mean time to resolve",
        value:
          data.alerts.mean_time_to_resolve_hours == null
            ? "—"
            : `${data.alerts.mean_time_to_resolve_hours.toFixed(1)} h`,
      },
    ];
  }, [data]);

  if (loading) {
    return (
      <div className="th-onb-card">
        <PanelSkeleton rows={6} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="th-onb-card">
        <EmptyState
          icon={<BarChart3 className="h-5 w-5" />}
          title="Couldn't load analytics"
          description={error ?? ""}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {figures.map((item, index) => (
          <div
            key={item.label}
            className="th-onb-card th-onb-stat th-onb-enter"
            style={{ "--i": index } as CSSProperties}
          >
            <div className="min-w-0">
              <div className="truncate text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                {item.label}
              </div>
              <div
                className="text-[22px] font-semibold leading-8 tabular-nums"
                style={{ color: "var(--th-text-primary)" }}
              >
                {item.value}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Availability" index={4}>
          <div className="px-5 pb-4">
            <AvailabilityChart series={data.availability.series} />
          </div>
        </SectionCard>
        <SectionCard title="Alerts opened and resolved" index={5}>
          <div className="px-5 pb-4">
            <AlertFlowChart series={data.alerts.series} />
          </div>
        </SectionCard>
      </div>
      <SectionCard title="Devices needing attention" index={6}>
        {data.problem_devices.length === 0 ? (
          <EmptyState icon={<HeartPulse className="h-5 w-5" />} title="Nothing stands out" />
        ) : (
          <table className="th-alerts-table">
            <thead>
              <tr>
                <th>Device</th>
                <th className="text-right">Offline events</th>
                <th className="text-right">Alerts</th>
                <th className="text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.problem_devices.map((device, index) => (
                <tr
                  key={device.device_id}
                  className="th-alerts-row cursor-pointer"
                  style={{ "--row": index } as CSSProperties}
                  onClick={() => onOpenDevice(device.device_id)}
                >
                  <td>
                    <span className="th-alerts-primary">{device.name}</span>
                  </td>
                  <td className="text-right tabular-nums">{formatCount(device.offline_events)}</td>
                  <td className="text-right tabular-nums">{formatCount(device.alerts)}</td>
                  <td className="text-right">
                    <span
                      className="th-status-chip capitalize"
                      style={{ "--chip-tone": freshnessTone(device.freshness_state) } as CSSProperties}
                    >
                      <i />
                      {device.freshness_state}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </div>
  );
}
