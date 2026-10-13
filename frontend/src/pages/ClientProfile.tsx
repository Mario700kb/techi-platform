import { CSSProperties, useMemo, useState } from "react";
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
import { getAlerts } from "../api/alerts";
import { ClientProfile, getClientActivity, getClientProfile } from "../api/clients";
import { Device, getDevices, getFleetInsights } from "../api/devices";
import AlertKindIcon from "../components/AlertKindIcon";
import BreakdownBars, { BreakdownRow, CATEGORY_LABELS } from "../components/BreakdownBars";
import { AlertFlowChart, AvailabilityChart } from "../components/InsightCharts";
import { Button, EmptyState, TablePagination } from "../components/ui";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { useNow } from "../hooks/useNow";
import { useTabIndicator } from "../hooks/useTabIndicator";
import { ALERT_KIND_LABELS, ALERT_SEVERITY_TONE, AlertKind } from "../types/alert";
import { deviceDisplayName } from "../utils/deviceLabel";
import { freshnessTone, humanize, TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { formatDateTime, formatLocalDateTime, timeAgo } from "../utils/time";

type Tab = "overview" | "devices" | "alerts" | "activity" | "analytics";

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
          <span className="th-team-mark" aria-hidden="true">
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
            className="th-onb-card th-onb-stat th-onb-enter"
            style={{ "--i": index + 1 } as CSSProperties}
          >
            <span className="th-onb-icon" style={{ "--onb-tone": item.tone } as CSSProperties}>
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
                {item.value}
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
            {[
              { label: "Documentation", icon: BookOpen },
              { label: "Tickets", icon: Ticket },
            ].map((t) => (
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
          />
        )}
        {opened.has("devices") && tab === "devices" && <DevicesTab clientId={client.id} />}
        {opened.has("alerts") && tab === "alerts" && <AlertsTab clientId={client.id} />}
        {opened.has("activity") && tab === "activity" && <ActivityTab clientId={client.id} />}
        {opened.has("analytics") && tab === "analytics" && <AnalyticsTab clientId={client.id} />}
      </div>
    </section>
  );
}

// ─── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({
  profile,
  activity,
  activityLoading,
  onShowActivity,
}: {
  profile: ClientProfile;
  activity?: Awaited<ReturnType<typeof getClientActivity>>;
  activityLoading: boolean;
  onShowActivity: () => void;
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
          <ActivityList page={activity} compact />
        )}
      </SectionCard>
    </div>
  );
}

// ─── Devices ─────────────────────────────────────────────────────────────────

function DevicesTab({ clientId }: { clientId: number }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEVICE_PAGE_SIZES[0]);
  const [search, setSearch] = useState("");
  const query = search.trim();
  const { data, loading, refreshing } = useCachedQuery(
    `page.client.${clientId}.devices:${JSON.stringify({ page, pageSize, query })}`,
    () =>
      getDevices(
        { client_id: clientId, search: query || undefined, sort: "hostname", order: "asc" },
        (page - 1) * pageSize,
        pageSize,
      ),
  );
  const devices = data?.devices ?? [];

  return (
    <div className="th-alerts-card">
      <div className="th-alerts-toolbar !items-center !py-3">
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
        <Link to={`/devices?client=${clientId}`} className="th-link-btn">
          Open in Devices
        </Link>
      </div>
      {loading ? (
        <PanelSkeleton />
      ) : devices.length === 0 ? (
        <EmptyState
          className="py-10"
          icon={<ServerOff className="h-5 w-5" />}
          title={query ? "No devices match" : "No devices"}
        />
      ) : (
        <div className="th-alerts-scroll th-table-scroll" data-loading={refreshing || undefined}>
          <table className="th-alerts-table">
            <colgroup>
              <col />
              <col className="w-[150px]" />
              <col className="w-[18%]" />
              <col className="w-[18%]" />
              <col className="w-[150px]" />
              <col className="w-[110px]" />
            </colgroup>
            <thead>
              <tr>
                <th>Device</th>
                <th>Status</th>
                <th>Group</th>
                <th>User</th>
                <th>IP address</th>
                <th className="text-right">Agent</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device: Device, index) => {
                const state = device.freshness_state ?? device.status ?? "offline";
                return (
                  <tr
                    key={device.id}
                    className="th-alerts-row cursor-pointer"
                    style={{ "--row": index } as CSSProperties}
                    onClick={() => navigate(`/devices?device=${device.id}`)}
                  >
                    <td>
                      <span className="th-alerts-primary">{deviceDisplayName(device)}</span>
                      <span className="th-alerts-secondary font-mono">{device.hostname}</span>
                    </td>
                    <td>
                      <span className="flex items-center gap-2">
                        <span className="th-status-dot" data-state={state} aria-hidden="true" />
                        <span className="th-alerts-primary !mt-0 capitalize">{state}</span>
                      </span>
                      <span className="th-alerts-secondary">
                        {device.last_seen ? timeAgo(device.last_seen) : "Never"}
                      </span>
                    </td>
                    <td>
                      <span className="th-alerts-primary">{device.group_name || "No group"}</span>
                    </td>
                    <td>
                      <span className="th-alerts-primary">{device.current_user || "—"}</span>
                      <span className="th-alerts-secondary">{device.domain || ""}</span>
                    </td>
                    <td>
                      <span className="th-alerts-primary font-mono text-[12px]">{device.public_ip || "—"}</span>
                      <span className="th-alerts-secondary font-mono">{device.local_ip || ""}</span>
                    </td>
                    <td className="text-right">
                      <span className="th-alerts-primary font-mono text-[12px]">{device.agent_version || "—"}</span>
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
    </div>
  );
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

function AlertsTab({ clientId }: { clientId: number }) {
  const navigate = useNavigate();
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
                    onClick={() => alert.device_id && navigate(`/devices?device=${alert.device_id}`)}
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
}: {
  page: Awaited<ReturnType<typeof getClientActivity>>;
  compact?: boolean;
}) {
  const navigate = useNavigate();
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
                      onClick={() => navigate(`/devices?device=${entry.device_id}`)}
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

function ActivityTab({ clientId }: { clientId: number }) {
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
          <ActivityList page={data} />
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

function AnalyticsTab({ clientId }: { clientId: number }) {
  const navigate = useNavigate();
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
                  onClick={() => navigate(`/devices?device=${device.device_id}`)}
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
