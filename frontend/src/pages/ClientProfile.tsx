import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BellRing,
  BookOpen,
  Box,
  FileText,
  KeyRound,
  ExternalLink,
  HeartPulse,
  LayoutDashboard,
  Layers,
  MapPin,
  Monitor,
  MonitorSmartphone,
  PackageCheck,
  RefreshCcw,
  Search,
  ServerOff,
  SquareTerminal,
  Ticket,
  Timer,
  Users,
  Wifi,
  X,
  Zap,
} from "lucide-react";

import { ACTION_LABELS, AuditLogEntry } from "../api/audit";
import { useAuth } from "../auth/AuthContext";
import ClientDocuments from "../components/ClientDocuments";
import ClientLocations from "../components/ClientLocations";
import SiteLine from "../components/SiteLine";
import { getAlerts } from "../api/alerts";
import {
  ClientActivityKind,
  ClientProfile,
  getClientActivity,
  getClientActivitySummary,
  getClientProfile,
  getClients,
  getGroups,
} from "../api/clients";
import { CONNECT_REFRESH_EVENT, ConnectRowStatus, getConnectStatuses } from "../api/connect";
import { Device, DeviceStats, getDevice, getDevices, getDeviceTableDetails } from "../api/devices";
import { getConnectUrl } from "../api/remoteSupport";
import AlertKindIcon from "../components/AlertKindIcon";
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  MeterRow,
  QuietLine,
  RingLegend,
  RingSegment,
  SegmentRing,
  SubHead,
  percent,
} from "../components/MeterPanels";
import ConnectMenu from "../components/ConnectMenu";
import DeviceDrawer from "../components/DeviceDrawer";
import GenericDeviceDrawer from "../components/GenericDeviceDrawer";
import { usesRegistryDrawer } from "../utils/drawerChoice";
import HealthBadge from "../components/HealthBadge";
import ClientAnalytics, { AnalyticsRange, preloadClientAnalytics } from "../components/ClientAnalytics";
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
import { deviceTypeLabel } from "../utils/deviceBadges";
import { deviceDisplayName, deviceHostnameSubtitle } from "../utils/deviceLabel";
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

type StatusFilter = "all" | "online" | "stale" | "offline";
type Tab = "overview" | "devices" | "locations" | "alerts" | "activity" | "analytics" | "documents";

const DEVICE_PAGE_SIZES = [20, 50];
const ACTIVITY_PAGE_SIZE = 20;

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
  footer,
  children,
  index,
}: {
  title: string;
  action?: React.ReactNode;
  /** Pinned to the bottom, so cards side by side end on one line. */
  footer?: React.ReactNode;
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
      {footer && <div className="th-panel-foot th-cp-foot">{footer}</div>}
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
  const { can, hasPermission } = useAuth();
  const clientId = id ? Number(id) : NaN;
  const valid = Number.isInteger(clientId) && clientId > 0;

  const [tab, setTab] = useState<Tab>("overview");
  const [deviceStatus, setDeviceStatus] = useState<StatusFilter>("all");
  // Kept here, like the tab, so the Analytics range survives a tab switch.
  const [analyticsRange, setAnalyticsRange] = useState<AnalyticsRange>("7d");
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

  // Analytics costs the server 1–3 s the first time a client is measured;
  // start it once the profile is on screen so the tab opens with its data.
  const profileShown = profile != null;
  useEffect(() => {
    if (!valid || !profileShown) return;
    const timer = window.setTimeout(() => preloadClientAnalytics(clientId, analyticsRange), 600);
    return () => window.clearTimeout(timer);
  }, [valid, profileShown, clientId, analyticsRange]);

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
    { key: "locations", label: "Locations", icon: MapPin },
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

  // The device and alert lists fill the screen like the other list pages:
  // the table takes what the header leaves and scrolls inside. The other tabs
  // (overview, locations, charts, documents) keep the normal page scroll.
  const fillsScreen = tab === "devices" || tab === "alerts";

  return (
    <section
      className={fillsScreen ? "premium-page th-onb th-page-fill flex flex-col gap-4" : "premium-page th-onb space-y-4"}
    >
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

      <div role="tabpanel" key={tab} className={fillsScreen ? "th-onb-panel th-cp-fill" : "th-onb-panel"}>
        {tab === "overview" && (
          <OverviewTab
            profile={profile}
            activity={activityPreview.data}
            activityLoading={activityPreview.loading}
            onOpenTab={openTab}
            onShowDevices={(status) => {
              setDeviceStatus(status);
              openTab("devices");
            }}
            onOpenDevice={openDevice}
          />
        )}
        {opened.has("devices") && tab === "devices" && (
          <DevicesTab
            clientId={client.id}
            stats={stats}
            status={deviceStatus}
            onStatusChange={setDeviceStatus}
            onOpenDevice={openDevice}
            selectedId={drawerOpen ? (drawerDevice?.id ?? null) : null}
            latestEvent={latestEvent}
            updatedDevice={updatedDevice}
          />
        )}
        {opened.has("locations") && tab === "locations" && (
          <ClientLocations clientId={client.id} canManage={hasPermission("manage_clients")} />
        )}
        {opened.has("alerts") && tab === "alerts" && <AlertsTab clientId={client.id} onOpenDevice={openDevice} />}
        {opened.has("activity") && tab === "activity" && <ActivityTab clientId={client.id} onOpenDevice={openDevice} />}
        {opened.has("analytics") && tab === "analytics" && (
          <ClientAnalytics
            clientId={client.id}
            range={analyticsRange}
            onRangeChange={setAnalyticsRange}
            onOpenDevice={openDevice}
          />
        )}
        {opened.has("documents") && tab === "documents" && (
          <ClientDocuments clientId={client.id} canWrite={can("operator")} />
        )}
      </div>

      {drawerDevice &&
        // Windows: the classic DeviceDrawer; other platforms reporting
        // capabilities: the registry-driven drawer (utils/drawerChoice).
        (usesRegistryDrawer(drawerDevice) ? (
          <GenericDeviceDrawer
            device={drawerDevice}
            isOpen={drawerOpen}
            onClose={closeDrawer}
            latestEvent={latestEvent}
            clients={org.data?.[0] ?? []}
            groups={org.data?.[1] ?? []}
            canOperate={can("operator")}
            canManageLocations={hasPermission("manage_clients")}
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
  onOpenTab,
  onShowDevices,
  onOpenDevice,
}: {
  profile: ClientProfile;
  activity?: Awaited<ReturnType<typeof getClientActivity>>;
  activityLoading: boolean;
  onOpenTab: (tab: Tab) => void;
  onShowDevices: (status: StatusFilter) => void;
  onOpenDevice: (id: number) => void;
}) {
  const { stats, alerts } = profile;
  const statusSegments: RingSegment[] = [
    { key: "online", label: "Online", value: stats.online, tone: TONE.online },
    { key: "stale", label: "Stale", value: stats.stale, tone: TONE.stale },
    { key: "offline", label: "Offline", value: stats.offline, tone: TONE.offline },
  ];
  const severitySegments: RingSegment[] = (["critical", "warning", "info"] as const).map((severity) => ({
    key: severity,
    label: humanize(severity),
    value: alerts.by_severity[severity] ?? 0,
    tone: ALERT_SEVERITY_TONE[severity],
  }));
  const categories = Object.entries(profile.by_category)
    .filter(([, counts]) => counts.total > 0)
    .sort(([, a], [, b]) => b.total - a.total);
  const kinds = Object.entries(alerts.by_kind ?? {})
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a);
  const groups = [...profile.groups].sort((a, b) => b.devices - a.devices);
  const ungrouped = Math.max(stats.total - groups.reduce((sum, g) => sum + g.devices, 0), 0);
  const groupSegments: RingSegment[] = [
    { key: "grouped", label: "In a group", value: stats.total - ungrouped, tone: TONE.info },
    { key: "ungrouped", label: "No group", value: ungrouped, tone: TONE.neutral },
  ];
  const onlinePct = stats.total > 0 ? `${Math.round((stats.online / stats.total) * 100)}%` : "—";

  return (
    <div className="th-cp-overview grid gap-4 lg:grid-cols-2">
      <SectionCard
        title="Fleet status"
        index={1}
        action={
          <button type="button" className="th-link-btn" onClick={() => onShowDevices("all")}>
            All devices
          </button>
        }
        footer={
          <>
            <span>
              {formatCount(stats.total)} {stats.total === 1 ? "device" : "devices"}
              {profile.last_seen ? ` · last check-in ${timeAgo(profile.last_seen)}` : ""}
            </span>
            {stats.offline > 0 && (
              <button type="button" className="th-link-btn" onClick={() => onShowDevices("offline")}>
                Show offline
              </button>
            )}
          </>
        }
      >
        <div className="th-cp-hero">
          <SegmentRing segments={statusSegments} total={stats.total} center={onlinePct} caption="online" />
          <RingLegend
            segments={statusSegments}
            total={stats.total}
            onSelect={(key) => onShowDevices(key as StatusFilter)}
          />
        </div>
        <SubHead>By category</SubHead>
        {categories.length === 0 ? (
          <QuietLine>No devices yet.</QuietLine>
        ) : (
          <ul className="th-cp-meters">
            {categories.map(([category, counts], index) => (
              <MeterRow
                key={category}
                index={index}
                mark={(() => {
                  const Icon = CATEGORY_ICONS[category] ?? Box;
                  return (
                    <span className="th-cp-mark-sm" aria-hidden="true">
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                  );
                })()}
                label={CATEGORY_LABELS[category] ?? humanize(category)}
                count={counts.total}
                total={stats.total}
                segments={[
                  { key: "online", label: "online", value: counts.online, tone: TONE.online },
                  { key: "stale", label: "stale", value: counts.stale, tone: TONE.stale },
                  { key: "offline", label: "offline", value: counts.offline, tone: TONE.offline },
                ]}
                title={`${formatCount(counts.online)} online · ${formatCount(counts.stale)} stale · ${formatCount(counts.offline)} offline`}
                onClick={() => onShowDevices("all")}
              />
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Open alerts"
        index={2}
        action={
          <button type="button" className="th-link-btn" onClick={() => onOpenTab("alerts")}>
            All alerts
          </button>
        }
        footer={
          <span>
            {alerts.total_open === 0
              ? "Every alert for this client has been resolved."
              : `${formatCount(alerts.total_open)} open${
                  alerts.devices_affected ? ` on ${formatCount(alerts.devices_affected)} devices` : ""
                }${alerts.oldest_open_at ? ` · oldest ${timeAgo(alerts.oldest_open_at)}` : ""}`}
          </span>
        }
      >
        <div className="th-cp-hero">
          <SegmentRing
            segments={severitySegments}
            total={alerts.total_open}
            center={formatCount(alerts.total_open)}
            caption={alerts.total_open === 1 ? "open alert" : "open alerts"}
          />
          <RingLegend segments={severitySegments} total={alerts.total_open} onSelect={() => onOpenTab("alerts")} />
        </div>
        <SubHead>By type</SubHead>
        {kinds.length === 0 ? (
          <QuietLine>No open alerts.</QuietLine>
        ) : (
          <ul className="th-cp-meters">
            {kinds.map(([kind, count], index) => (
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
                total={alerts.total_open}
                tone={TONE.warning}
                onClick={() => onOpenTab("alerts")}
              />
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Groups"
        index={3}
        action={
          <button type="button" className="th-link-btn" onClick={() => onShowDevices("all")}>
            Devices
          </button>
        }
        footer={
          <span>
            {formatCount(groups.length)} {groups.length === 1 ? "group" : "groups"} ·{" "}
            {ungrouped > 0 ? `${formatCount(ungrouped)} devices without a group` : "every device grouped"}
          </span>
        }
      >
        <div className="th-cp-hero">
          <SegmentRing
            segments={groupSegments}
            total={stats.total}
            center={stats.total > 0 ? percent(stats.total - ungrouped, stats.total) : "—"}
            caption="grouped"
          />
          <RingLegend
            segments={[
              ...groupSegments,
              {
                key: "groups",
                label: groups.length === 1 ? "Group" : "Groups",
                value: groups.length,
                tone: TONE.maintenance,
                share: "",
              },
            ]}
            total={stats.total}
            onSelect={() => onShowDevices("all")}
          />
        </div>
        <SubHead>By group</SubHead>
        {groups.length === 0 && ungrouped === 0 ? (
          <QuietLine>No groups yet.</QuietLine>
        ) : (
          <ul className="th-cp-meters">
            {groups.map((group, index) => (
              <MeterRow
                key={group.id}
                index={index}
                mark={
                  <span className="th-cp-mark-sm" aria-hidden="true">
                    {initials(group.name)}
                  </span>
                }
                label={group.name}
                count={group.devices}
                total={stats.total}
                tone={TONE.info}
                onClick={() => onShowDevices("all")}
              />
            ))}
            {ungrouped > 0 && (
              <MeterRow
                index={groups.length}
                mark={
                  <span className="th-cp-mark-sm" data-muted="true" aria-hidden="true">
                    —
                  </span>
                }
                label="No group"
                count={ungrouped}
                total={stats.total}
                tone={TONE.neutral}
                onClick={() => onShowDevices("all")}
              />
            )}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Recent activity"
        index={4}
        action={
          <button type="button" className="th-link-btn" onClick={() => onOpenTab("activity")}>
            View all
          </button>
        }
        footer={
          <span>
            {activity && activity.total > 0
              ? `Latest ${formatCount(activity.items.length)} of ${formatCount(activity.total)} entries`
              : "Remote sessions, actions and credential use appear here."}
          </span>
        }
      >
        {activityLoading && !activity ? (
          <PanelSkeleton rows={4} />
        ) : !activity || activity.items.length === 0 ? (
          <QuietLine>No activity yet.</QuietLine>
        ) : (
          <ActivityList page={activity} onOpenDevice={onOpenDevice} />
        )}
      </SectionCard>
    </div>
  );
}

// ─── Devices ─────────────────────────────────────────────────────────────────

function DevicesTab({
  clientId,
  stats,
  status,
  onStatusChange,
  onOpenDevice,
  selectedId,
  latestEvent,
  updatedDevice,
}: {
  clientId: number;
  stats: DeviceStats;
  status: StatusFilter;
  onStatusChange: (status: StatusFilter) => void;
  onOpenDevice: (device: Device) => void;
  selectedId: number | null;
  latestEvent: DeviceRealtimeEvent | null;
  updatedDevice: Device | null;
}) {
  const features = usePlatformFeatures();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEVICE_PAGE_SIZES[0]);
  const [search, setSearch] = useState("");
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
                  onStatusChange(f.key);
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
        <div className="th-alerts-scroll th-table-scroll th-cp-scroll" data-loading={refreshing || undefined}>
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
                <th>Location</th>
                <th>User</th>
                <th>IP address</th>
                <th>Agent</th>
                <th>Actions</th>
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
                          {/* Its type, as on the Devices page; the hostname only when it differs from the name. */}
                          <span className="th-alerts-secondary">
                            {deviceTypeLabel(device)}
                            {deviceHostnameSubtitle(device) && (
                              <span className="font-mono"> · {deviceHostnameSubtitle(device)}</span>
                            )}
                          </span>
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
                      {device.location_name ? (
                        <SiteLine device={device} className="th-alerts-primary" />
                      ) : (
                        <span className="th-alerts-primary" style={{ color: "var(--th-text-muted)" }}>
                          {device.group_name || "No group"}
                        </span>
                      )}
                    </td>
                    <td data-m="hide">
                      <span className="th-alerts-primary">{device.current_user || "—"}</span>
                      <span className="th-alerts-secondary">{device.domain || ""}</span>
                    </td>
                    <td data-m="hide">
                      <span className="th-alerts-primary font-mono text-[12px]">{device.public_ip || "—"}</span>
                      <span className="th-alerts-secondary font-mono">{device.local_ip || ""}</span>
                    </td>
                    <td data-m="hide">
                      <span className="th-alerts-primary font-mono text-[12px]">{device.agent_version || "—"}</span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
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
        <div className="th-alerts-scroll th-table-scroll th-cp-scroll" data-loading={refreshing || undefined}>
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

type ActivityKind = Exclude<ClientActivityKind, "all"> | "other";

const ACTIVITY_KIND_OF: Record<string, ActivityKind> = {
  remote_connect: "remote",
  remote_session_started: "remote",
  remote_session_ended: "remote",
  remote_support_alarm: "remote",
  terminal_session_opened: "terminal",
  terminal_session_closed: "terminal",
  terminal_session_denied: "terminal",
  terminal_session_expired: "terminal",
  ssh_session_started: "terminal",
  ssh_session_ended: "terminal",
  ssh_connection_failed: "terminal",
  ssh_authentication_failed: "terminal",
  action_queued: "actions",
  action_cancelled: "actions",
  maintenance_entered: "actions",
  maintenance_cleared: "actions",
  note_created: "actions",
  vault_credential_revealed: "credentials",
  vault_credential_assigned: "credentials",
  ssh_credential_resolved: "credentials",
};

const ACTIVITY_KIND_META: Record<ActivityKind, { icon: typeof Monitor; tone: string }> = {
  remote: { icon: MonitorSmartphone, tone: TONE.info },
  terminal: { icon: SquareTerminal, tone: TONE.online },
  actions: { icon: Zap, tone: TONE.warning },
  credentials: { icon: KeyRound, tone: TONE.maintenance },
  other: { icon: FileText, tone: TONE.neutral },
};

const METHOD_LABELS: Record<string, string> = {
  webfig: "WebFig",
  winbox: "Winbox",
  ssh: "SSH",
  terminal: "Terminal",
  remote_support: "Remote Support",
  rdp: "RDP",
};

const FAILED_ACTIONS = new Set([
  "terminal_session_denied",
  "ssh_connection_failed",
  "ssh_authentication_failed",
  "action_cancelled",
]);

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${String(rest).padStart(2, "0")} min` : `${hours} h`;
}

interface ActivityView {
  kind: ActivityKind;
  label: string;
  method: string | null;
  facts: string[];
  ip: string | null;
  status: { label: string; tone: string } | null;
  duration: string | null;
  failed: boolean;
}

/** What one audit entry says, in the words and parts the activity log shows. */
function describeActivity(entry: AuditLogEntry): ActivityView {
  const d = parseDetails(entry.details_json);
  const text = (key: string) => (typeof d[key] === "string" && d[key] ? (d[key] as string) : null);
  const num = (key: string) => (typeof d[key] === "number" ? (d[key] as number) : null);
  const kind = ACTIVITY_KIND_OF[entry.action] ?? "other";

  let method = text("method");
  if (!method && (entry.action === "remote_connect" || kind === "remote")) method = "remote_support";
  if (!method && entry.action.startsWith("ssh_")) method = "ssh";
  if (!method && entry.action.startsWith("terminal_")) method = text("engine") ? "terminal" : null;

  const facts: string[] = [];
  const rs = text("remote_support_status");
  const status =
    entry.action === "remote_connect" && rs
      ? {
          label: `Remote Support ${rs}`,
          tone: rs === "online" ? TONE.online : rs === "offline" ? TONE.offline : TONE.warning,
        }
      : null;
  const reason = text("reason");
  if (reason && !reason.startsWith("Connect:")) facts.push(humanize(reason));
  if (text("action_type")) facts.push(humanize(text("action_type")!));
  if (text("engine")) facts.push(text("engine")!);
  if (text("ssh_username")) facts.push(`as ${text("ssh_username")}`);
  if (text("credential_source")) facts.push(`${humanize(text("credential_source")!)} credential`);
  if (text("name") && kind === "credentials") facts.push(text("name")!);
  if (text("note")) facts.push(`“${text("note")}”`);
  if (text("message")) facts.push(text("message")!);
  if (text("attribution") === "unattributed") facts.push("No Connect click before it");

  const seconds = num("duration_seconds");
  const minutes = num("duration_minutes");
  const duration = seconds != null ? formatDuration(seconds) : minutes != null ? formatDuration(minutes * 60) : null;

  return {
    kind,
    label: ACTION_LABELS[entry.action] ?? humanize(entry.action),
    method: method ? (METHOD_LABELS[method] ?? humanize(method)) : null,
    facts,
    ip: text("ip"),
    status,
    duration,
    failed: FAILED_ACTIONS.has(entry.action),
  };
}

function KindMark({ kind, failed = false }: { kind: ActivityKind; failed?: boolean }) {
  const meta = ACTIVITY_KIND_META[kind];
  return (
    <span
      className="th-cp-kind"
      style={{ "--kind-tone": failed ? TONE.critical : meta.tone } as CSSProperties}
      aria-hidden="true"
    >
      <meta.icon className="h-3.5 w-3.5" />
    </span>
  );
}

/** The Overview's recent activity: one line per entry with its method and duration. */
function ActivityList({
  page,
  onOpenDevice,
}: {
  page: Awaited<ReturnType<typeof getClientActivity>>;
  onOpenDevice: (id: number) => void;
}) {
  return (
    <ul className="flex flex-col px-5 pb-2">
      {page.items.map((entry, index) => {
        const view = describeActivity(entry);
        const deviceName = entry.device_id != null ? page.device_names[entry.device_id] : undefined;
        return (
          <li
            key={entry.id}
            className="th-share-row th-cp-recent"
            style={
              { "--i": index, borderTop: index ? "1px solid var(--th-border-subtle)" : undefined } as CSSProperties
            }
          >
            <KindMark kind={view.kind} failed={view.failed} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]" style={{ color: "var(--th-text-primary)" }}>
                <span className="font-semibold">{entry.operator_username ?? "System"}</span>{" "}
                <span style={{ color: "var(--th-text-secondary)" }}>{view.label.toLowerCase()}</span>
                {deviceName && entry.device_id != null && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="th-alerts-link font-medium"
                      onClick={() => onOpenDevice(entry.device_id!)}
                    >
                      {deviceName}
                    </button>
                  </>
                )}
              </div>
              <div className="truncate text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                {[view.method, ...view.facts.slice(0, 1), view.ip].filter(Boolean).join(" · ") || " "}
              </div>
            </div>
            <span className="flex flex-none flex-col items-end gap-0.5 text-[12px] tabular-nums">
              <span style={{ color: "var(--th-text-muted)" }} title={formatDateTime(entry.created_at)}>
                {timeAgo(entry.created_at)}
              </span>
              {view.duration && <span className="th-cp-duration">{view.duration}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const ACTIVITY_KINDS: { key: ClientActivityKind; label: string }[] = [
  { key: "all", label: "All" },
  { key: "remote", label: "Remote" },
  { key: "terminal", label: "Terminal & SSH" },
  { key: "actions", label: "Actions" },
  { key: "credentials", label: "Credentials" },
];

function dayLabel(iso: string): string {
  const day = formatLocalDateTime(iso, { year: "numeric", month: "short", day: "numeric", weekday: "short" });
  const key = (when: Date) =>
    formatLocalDateTime(when.toISOString(), { year: "numeric", month: "2-digit", day: "2-digit" });
  const own = formatLocalDateTime(iso, { year: "numeric", month: "2-digit", day: "2-digit" });
  const now = new Date();
  if (own === key(now)) return `Today · ${day}`;
  if (own === key(new Date(now.getTime() - 86_400_000))) return `Yesterday · ${day}`;
  return day;
}

function ActivityTab({ clientId, onOpenDevice }: { clientId: number; onOpenDevice: (id: number) => void }) {
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState<ClientActivityKind>("all");
  const [operator, setOperator] = useState<string | null>(null);
  // Audit data: memory only, never written to the browser's storage.
  const summary = useCachedQuery(`mem.client.${clientId}.activity-summary`, () =>
    getClientActivitySummary(clientId, 30),
  );
  const { data, loading, refreshing } = useCachedQuery(
    `mem.client.${clientId}.activity:${JSON.stringify({ page, kind, operator })}`,
    () => getClientActivity(clientId, ACTIVITY_PAGE_SIZE, (page - 1) * ACTIVITY_PAGE_SIZE, { kind, operator }),
  );
  const s = summary.data;
  const kindIndex = ACTIVITY_KINDS.findIndex((k) => k.key === kind);
  const topOperator = s?.operators[0];

  const tiles = s
    ? [
        {
          label: "Remote connections",
          value: formatCount(s.remote_connects),
          hint: s.remote_connects
            ? `${formatCount(s.remote_devices)} devices · last ${timeAgo(s.last_remote_at)}`
            : "None in 30 days",
          icon: MonitorSmartphone,
          tone: TONE.info,
        },
        {
          label: "Active operators",
          value: formatCount(s.operators.length),
          hint: topOperator ? `${topOperator.username} most active` : "No one yet",
          icon: Users,
          tone: TONE.maintenance,
        },
        {
          label: "Terminal & SSH time",
          value: s.terminal_sessions ? formatDuration(s.terminal_seconds) : "—",
          hint: `${formatCount(s.terminal_sessions)} ${s.terminal_sessions === 1 ? "session" : "sessions"}`,
          icon: SquareTerminal,
          tone: TONE.online,
        },
        {
          label: "Remote Support time",
          value: s.remote_sessions ? formatDuration(s.remote_minutes * 60) : "—",
          hint: s.remote_sessions
            ? `${formatCount(s.remote_sessions)} sessions measured`
            : "Measured from agent 2.1.24",
          icon: Timer,
          tone: TONE.warning,
        },
      ]
    : [];
  const maxDevice = Math.max(1, ...(s?.devices ?? []).map((d) => d.remote_connects));
  const maxOperator = Math.max(1, ...(s?.operators ?? []).map((o) => o.events));

  const days = (data?.items ?? []).map((entry) => dayLabel(entry.created_at));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {(s ? tiles : Array.from({ length: 4 })).map((tile, index) =>
          tile ? (
            <div
              key={(tile as (typeof tiles)[number]).label}
              className="th-onb-card th-onb-stat th-onb-enter th-cp-kpi"
              style={{ "--i": index, "--onb-tone": (tile as (typeof tiles)[number]).tone } as CSSProperties}
            >
              {(() => {
                const t = tile as (typeof tiles)[number];
                return (
                  <>
                    <span className="th-onb-icon">
                      <t.icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                        {t.label} <span style={{ color: "var(--th-text-faint)" }}>· 30 days</span>
                      </div>
                      <div
                        className="text-[22px] font-semibold leading-8 tabular-nums"
                        style={{ color: "var(--th-text-primary)" }}
                      >
                        <span key={t.value} className="th-share-count">
                          {t.value}
                        </span>
                      </div>
                      <div className="truncate text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                        {t.hint}
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          ) : (
            <div key={index} className="th-onb-card th-onb-stat">
              <div className="th-alerts-skeleton w-full" />
            </div>
          ),
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Most reached devices"
          index={4}
          footer={<span>Remote connections per device, last 30 days.</span>}
        >
          {!s ? (
            <PanelSkeleton rows={4} />
          ) : s.devices.length === 0 ? (
            <QuietLine>No remote connections in 30 days.</QuietLine>
          ) : (
            <ul className="th-cp-meters pt-1">
              {s.devices.map((device, index) => (
                <MeterRow
                  key={device.device_id}
                  index={index}
                  mark={
                    <span className="th-cp-mark-sm" aria-hidden="true">
                      <Monitor className="h-3.5 w-3.5" />
                    </span>
                  }
                  label={device.name}
                  count={device.remote_connects}
                  total={maxDevice}
                  share={device.last_at ? timeAgo(device.last_at) : ""}
                  tone={TONE.info}
                  title={`Last connection ${formatDateTime(device.last_at)}`}
                  onClick={() => onOpenDevice(device.device_id)}
                />
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard
          title="Operators"
          index={5}
          footer={<span>Entries per operator, last 30 days. Select one to filter the log.</span>}
        >
          {!s ? (
            <PanelSkeleton rows={4} />
          ) : s.operators.length === 0 ? (
            <QuietLine>No operator activity in 30 days.</QuietLine>
          ) : (
            <ul className="th-cp-meters pt-1">
              {s.operators.map((op, index) => (
                <MeterRow
                  key={op.username}
                  index={index}
                  selected={operator === op.username}
                  mark={
                    <span className="th-cp-mark-sm" aria-hidden="true">
                      {op.username.charAt(0).toUpperCase()}
                    </span>
                  }
                  label={op.username}
                  count={op.events}
                  total={maxOperator}
                  share={op.last_at ? timeAgo(op.last_at) : ""}
                  tone={TONE.maintenance}
                  title={`${formatCount(op.remote_connects)} remote connections · last ${formatDateTime(op.last_at)}`}
                  onClick={() => {
                    setOperator((prev) => (prev === op.username ? null : op.username));
                    setPage(1);
                  }}
                />
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <div className="th-alerts-card th-onb-enter" style={{ "--i": 6 } as CSSProperties}>
        <div className="th-alerts-toolbar !items-center !py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <div
              className="th-segmented th-cp-status"
              role="radiogroup"
              aria-label="Activity type"
              data-thumb
              style={{ "--seg-n": ACTIVITY_KINDS.length, "--seg-i": kindIndex } as CSSProperties}
            >
              {ACTIVITY_KINDS.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  role="radio"
                  aria-checked={kind === k.key}
                  onClick={() => {
                    setKind(k.key);
                    setPage(1);
                  }}
                >
                  {k.label}
                </button>
              ))}
            </div>
            {operator && (
              <button
                type="button"
                className="th-tag th-cp-filter-chip"
                onClick={() => {
                  setOperator(null);
                  setPage(1);
                }}
                aria-label={`Remove operator filter ${operator}`}
              >
                {operator}
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          {data && (
            <span className="text-[12px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
              {formatCount(data.total)} entries
            </span>
          )}
        </div>
        {loading ? (
          <PanelSkeleton rows={8} />
        ) : !data || data.items.length === 0 ? (
          <EmptyState
            className="py-10"
            icon={<Activity className="h-5 w-5" />}
            title={kind !== "all" || operator ? "Nothing matches" : "No activity yet"}
            description="Remote connections, terminal and SSH sessions, actions and credential use on this client's devices appear here."
          />
        ) : (
          <div className="th-alerts-scroll th-table-scroll th-cp-scroll" data-loading={refreshing || undefined}>
            <table className="th-alerts-table th-cp-log" data-mobile="cards">
              <colgroup>
                <col className="w-[84px]" />
                <col className="w-[15%]" />
                <col className="w-[24%]" />
                <col className="w-[17%]" />
                <col />
                <col className="w-[110px]" />
              </colgroup>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Operator</th>
                  <th>Event</th>
                  <th>Device</th>
                  <th>Details</th>
                  <th className="text-right">Duration</th>
                </tr>
              </thead>
              <tbody>
                {data.items.flatMap((entry, index) => {
                  const view = describeActivity(entry);
                  const deviceName = entry.device_id != null ? data.device_names[entry.device_id] : undefined;
                  const day = days[index];
                  const rows = [];
                  if (index === 0 || day !== days[index - 1]) {
                    rows.push(
                      <tr key={`day-${day}`} className="th-cp-day">
                        <td colSpan={6}>{day}</td>
                      </tr>,
                    );
                  }
                  rows.push(
                    <tr
                      key={entry.id}
                      className="th-alerts-row"
                      style={
                        { "--row": index, "--row-tone": view.failed ? TONE.critical : "transparent" } as CSSProperties
                      }
                    >
                      <td title={formatDateTime(entry.created_at)}>
                        <span className="th-alerts-primary tabular-nums">
                          {formatLocalDateTime(entry.created_at, { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <span className="th-alerts-secondary">{timeAgo(entry.created_at)}</span>
                      </td>
                      <td>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="th-onb-avatar" aria-hidden="true">
                            {(entry.operator_username ?? "S").charAt(0).toUpperCase()}
                          </span>
                          <span className="th-alerts-primary !mt-0 truncate">
                            {entry.operator_username ?? "System"}
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className="flex min-w-0 items-center gap-2.5">
                          <KindMark kind={view.kind} failed={view.failed} />
                          <span className="min-w-0">
                            <span className="th-alerts-primary">{view.label}</span>
                            {view.method && <span className="th-alerts-secondary">{view.method}</span>}
                          </span>
                        </span>
                      </td>
                      <td>
                        {deviceName && entry.device_id != null ? (
                          <button
                            type="button"
                            className="th-alerts-link th-alerts-primary text-left font-medium"
                            onClick={() => onOpenDevice(entry.device_id!)}
                          >
                            {deviceName}
                          </button>
                        ) : (
                          <span className="th-alerts-secondary !mt-0">—</span>
                        )}
                      </td>
                      <td data-m={view.facts.length || view.ip || view.status ? undefined : "hide"}>
                        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                          {view.status && (
                            <span
                              className="th-status-chip !h-5 !px-2 !text-[11px]"
                              style={{ "--chip-tone": view.status.tone } as CSSProperties}
                            >
                              <i />
                              {view.status.label}
                            </span>
                          )}
                          {view.facts.length > 0 && (
                            <span className="th-alerts-primary !mt-0 truncate" title={view.facts.join(" · ")}>
                              {view.facts.join(" · ")}
                            </span>
                          )}
                        </span>
                        {view.ip && <span className="th-alerts-secondary font-mono">from {view.ip}</span>}
                      </td>
                      <td className="text-right">
                        {view.duration ? (
                          <span className="th-cp-duration">{view.duration}</span>
                        ) : (
                          <span
                            className="th-alerts-secondary !mt-0"
                            title={
                              entry.action === "remote_connect"
                                ? "Remote Support session length is reported from agent 2.1.24"
                                : undefined
                            }
                          >
                            —
                          </span>
                        )}
                      </td>
                    </tr>,
                  );
                  return rows;
                })}
              </tbody>
            </table>
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
    </div>
  );
}
