import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, CheckCircle2, Layers, RefreshCcw, Search, Sparkles, UserCheck, X } from "lucide-react";

import {
  analyzeAlertGroup,
  bulkAlerts,
  getAlertCount,
  getAlertGroups,
  getAlertQueue,
  snoozeAlert,
  takeAlert,
} from "../api/alerts";
import { useAuth } from "../auth/AuthContext";
import AlertKindIcon from "../components/AlertKindIcon";
import AlertDrawer from "../components/alerts/AlertDrawer";
import { CommandBlock, PriorityChip, ResolveModal, SnoozeMenu } from "../components/alerts/AlertControls";
import { FindingsView, MutesView, QualityView } from "../components/alerts/AlertSideViews";
import RemoteSupportIdsView from "../components/alerts/RemoteSupportIdsView";
import { Button, EmptyState, Modal, PageHeader, Select, TablePagination } from "../components/ui";
import { useAppData } from "../contexts/AppDataContext";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { useNow } from "../hooks/useNow";
import { useTabIndicator } from "../hooks/useTabIndicator";
import type { Alert, AlertAnalysis, AlertCount, AlertGroup, AlertKind, AlertPage, AlertView } from "../types/alert";
import { ALERT_KIND_LABELS, ALERT_SEVERITY_TONE, RESOLUTION_LABELS } from "../types/alert";
import { describeAlert } from "../utils/alertText";
import { formatCount } from "../utils/number";
import { formatDateTime, formatLocalDateTime, timeAgo } from "../utils/time";

const PAGE_SIZE_OPTIONS = [10, 20, 50];

type Tab = AlertView | "findings" | "rsids" | "quality" | "mutes";
type GroupBy = "none" | "issue" | "client" | "device";

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "needs_action", label: "Needs action", hint: "P1–P2 that nobody else has taken" },
  { id: "mine", label: "Mine", hint: "Alerts you took" },
  { id: "open", label: "All open", hint: "Every open alert, most urgent first" },
  { id: "snoozed", label: "Snoozed", hint: "Back when the snooze ends" },
  { id: "resolved", label: "Resolved", hint: "Closed, newest first" },
  { id: "findings", label: "Findings", hint: "Security, restarts and disks to fix on a plan" },
  { id: "rsids", label: "Remote Support IDs", hint: "IDs as the clients themselves report them" },
  { id: "quality", label: "Quality", hint: "Which rules make noise" },
  { id: "mutes", label: "Mute rules", hint: "Rules that keep alerts from opening" },
];

interface Filter {
  issue?: string;
  clientId?: number;
  deviceId?: number;
  kind?: string;
  label: string;
}

interface QueueView {
  page: AlertPage;
  counts: AlertCount;
}

const QUEUE_TABS: Tab[] = ["needs_action", "mine", "open", "snoozed", "resolved"];

export default function AlertsDesktop() {
  useNow();
  const { latestEvent, reloadAlerts } = useAppData();
  const { can } = useAuth();
  const canOperate = can("operator");
  const [tab, setTab] = useState<Tab>("needs_action");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [kind, setKind] = useState<string>("all");
  const [filter, setFilter] = useState<Filter | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [openId, setOpenId] = useState<number | null>(null);
  const [bulkResolve, setBulkResolve] = useState(false);
  const [groupAnalysis, setGroupAnalysis] = useState<{
    title: string;
    analysis: AlertAnalysis | null;
    error?: string;
  } | null>(null);
  const [manualRefresh, setManualRefresh] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useTabIndicator<HTMLDivElement>(tab);
  const isQueue = QUEUE_TABS.includes(tab);
  const view = (isQueue ? tab : "open") as AlertView;

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const request = useMemo(
    () => ({
      view,
      kind: filter?.kind ?? (kind === "all" ? undefined : kind),
      issue: filter?.issue,
      clientId: filter?.clientId,
      deviceId: filter?.deviceId,
      search: search || undefined,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    [view, kind, filter, search, page, pageSize],
  );

  useEffect(() => {
    setPage(1);
  }, [view, kind, filter, search, pageSize]);
  useEffect(() => {
    setSelected(new Set());
  }, [tab, filter, kind]);

  const listing = isQueue && groupBy === "none";
  const { data, loading, refreshing, error, reload, setData } = useCachedQuery<QueueView>(
    listing ? `page.alerts.queue:${JSON.stringify(request)}` : null,
    async () => {
      const [pageData, counts] = await Promise.all([getAlertQueue(request), getAlertCount(request.search)]);
      return { page: pageData, counts };
    },
  );
  const groupsQuery = useCachedQuery<AlertGroup[]>(
    isQueue && groupBy !== "none" ? `page.alerts.groups:${groupBy}:${view}:${search}` : null,
    () => getAlertGroups(groupBy as "issue" | "client" | "device", view, search),
  );
  const countsQuery = useCachedQuery<AlertCount>(`page.alerts.counts:${search}`, () => getAlertCount(search));
  const [shown, setShown] = useState(data);
  if (data !== undefined && data !== shown) setShown(data);
  const queue = data ?? shown;
  const alerts = queue?.page.items ?? [];
  const counts = countsQuery.data ?? queue?.counts ?? null;
  const stale = alerts.length > 0 && (manualRefresh || (refreshing && data === undefined));

  const reloadAll = () => {
    void reload();
    void countsQuery.reload();
    void groupsQuery.reload();
    reloadAlerts();
  };
  const reloadRef = useRef(reloadAll);
  reloadRef.current = reloadAll;

  const refresh = () => {
    setManualRefresh(true);
    Promise.all([reload(), countsQuery.reload(), groupsQuery.reload()]).finally(() => setManualRefresh(false));
  };

  // New and resolved alerts arrive over the WebSocket; refetch once a burst settles.
  const reloadTimer = useRef<number | undefined>();
  useEffect(() => {
    if (latestEvent?.type !== "alert_created" && latestEvent?.type !== "alert_resolved") return;
    window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => reloadRef.current(), 1500);
  }, [latestEvent]);
  useEffect(() => () => window.clearTimeout(reloadTimer.current), []);

  const withBusy = async (ids: number[], fn: () => Promise<unknown>) => {
    setBusyIds((prev) => new Set([...prev, ...ids]));
    try {
      await fn();
    } finally {
      setBusyIds((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      reloadAll();
    }
  };

  const take = (id: number) =>
    void withBusy([id], async () => {
      const taken = await takeAlert(id);
      setData(
        (prev) =>
          prev && { ...prev, page: { ...prev.page, items: prev.page.items.map((a) => (a.id === id ? taken : a)) } },
      );
    });

  const selectable = alerts.filter((a) => a.id > 0);
  const allSelected = selectable.length > 0 && selectable.every((a) => selected.has(a.id));
  const someSelected = !allSelected && selectable.some((a) => selected.has(a.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.map((a) => a.id)));
  const toggleOne = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const viewCount = (id: Tab): number | null => {
    if (!counts?.views) return null;
    if (id === "needs_action" || id === "mine" || id === "open" || id === "snoozed") return counts.views[id] ?? 0;
    return null;
  };
  const kindOptions = [
    { value: "all", label: "All types" },
    ...Object.entries(counts?.by_kind ?? {})
      .filter(([, n]) => n > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([value, n]) => ({ value, label: `${ALERT_KIND_LABELS[value as AlertKind] ?? value} · ${formatCount(n)}` })),
  ];

  const kpis: { label: string; value: number | undefined; tone: string; hint: string; tab?: Tab }[] = [
    {
      label: "Needs action",
      value: counts?.views?.needs_action,
      tone: "var(--th-accent)",
      hint: "P1–P2 without another owner",
      tab: "needs_action",
    },
    {
      label: "P1 · act now",
      value: Number(counts?.by_priority?.["1"] ?? 0),
      tone: ALERT_SEVERITY_TONE.critical,
      hint: "Critical on servers, sites down",
      tab: "open",
    },
    { label: "Mine", value: counts?.views?.mine, tone: "var(--th-status-info)", hint: "Alerts you took", tab: "mine" },
    {
      label: "All open",
      value: counts?.views?.open,
      tone: "var(--th-text-muted)",
      hint: counts?.oldest_open_at ? `Oldest opened ${timeAgo(counts.oldest_open_at)}` : "Nothing open",
      tab: "open",
    },
  ];

  const openSiteOutage = (alert: Alert) =>
    setFilter({ kind: "device_offline", clientId: alert.client_id ?? undefined, label: alert.title ?? "Site offline" });

  const runGroupAnalysis = async (group: AlertGroup) => {
    const title = group.title ?? group.key;
    setGroupAnalysis({ title, analysis: null });
    try {
      setGroupAnalysis({ title, analysis: await analyzeAlertGroup(group.key) });
    } catch (e) {
      setGroupAnalysis({ title, analysis: null, error: e instanceof Error ? e.message : "The analysis failed." });
    }
  };

  return (
    <section className="premium-page flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        className="shrink-0"
        title="Alerts"
        description="The work queue: most urgent first. Take an alert, snooze it, or resolve it with a reason."
        actions={
          <Button size="sm" variant="secondary" onClick={refresh}>
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        }
      />

      <div className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((kpi) => (
          <button
            key={kpi.label}
            type="button"
            className="th-kpi"
            aria-pressed={kpi.tab === tab}
            onClick={() => kpi.tab && setTab(kpi.tab)}
            style={{ "--kpi-tone": kpi.tone } as CSSProperties}
          >
            <span className="th-kpi-label">
              <span className="th-kpi-dot" />
              {kpi.label}
            </span>
            <span className="th-kpi-value">{counts && kpi.value != null ? formatCount(kpi.value) : "—"}</span>
            <span className="th-kpi-hint">{kpi.hint}</span>
          </button>
        ))}
      </div>

      <div className="th-alerts-card">
        <div className="th-alerts-toolbar">
          <div ref={tabsRef} role="tablist" aria-label="Alert view" className="th-tabs">
            {TABS.map(({ id, label, hint }) => {
              const n = viewCount(id);
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  title={hint}
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className="th-tab"
                >
                  {label}
                  {n != null && <span className="th-tab-count">{formatCount(n)}</span>}
                </button>
              );
            })}
          </div>
          {isQueue && (
            <div className="flex flex-wrap items-center gap-2 pb-2">
              <label className="th-search th-search-sm w-[220px]">
                <Search className="h-3.5 w-3.5 flex-none" />
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search device, client or message"
                  aria-label="Search alerts"
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => setSearchInput("")}
                    className="th-explorer-clear"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </label>
              <div className="th-ac-seg" role="group" aria-label="Group by">
                {(["none", "issue", "client", "device"] as GroupBy[]).map((g) => (
                  <button key={g} type="button" aria-pressed={groupBy === g} onClick={() => setGroupBy(g)}>
                    {g === "none" ? "List" : g === "issue" ? "By issue" : g === "client" ? "By client" : "By device"}
                  </button>
                ))}
              </div>
              {groupBy === "none" && (
                <Select
                  id="alerts-kind"
                  aria-label="Filter by alert type"
                  className="!h-8 w-[220px]"
                  value={kind}
                  onChange={(value) => setKind(value)}
                  options={kindOptions}
                />
              )}
            </div>
          )}
        </div>

        {filter && isQueue && groupBy === "none" && (
          <div className="th-alerts-bulk">
            <span>
              Showing <b>{filter.label}</b>
            </span>
            <Button size="sm" variant="ghost" onClick={() => setFilter(null)}>
              <X className="h-3.5 w-3.5" />
              Show all
            </Button>
          </div>
        )}

        {selected.size > 0 && canOperate && (
          <div className="th-alerts-bulk th-bulk-bar">
            <span className="tabular-nums">{formatCount(selected.size)} selected</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void withBusy([...selected], () => bulkAlerts({ ids: [...selected], action: "take" }))}
            >
              <UserCheck className="h-3.5 w-3.5" />
              Take
            </Button>
            <SnoozeMenu
              onSnooze={(choice) =>
                void withBusy([...selected], () =>
                  bulkAlerts({
                    ids: [...selected],
                    action: "snooze",
                    minutes:
                      choice.minutes ??
                      (choice.until
                        ? Math.max(5, Math.round((new Date(choice.until).getTime() - Date.now()) / 60_000))
                        : undefined),
                    until_worse: choice.until_worse,
                  }),
                ).then(() => setSelected(new Set()))
              }
            />
            <Button size="sm" variant="secondary" onClick={() => setBulkResolve(true)}>
              Resolve…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}

        {tab === "findings" ? (
          <FindingsView />
        ) : tab === "rsids" ? (
          <RemoteSupportIdsView />
        ) : tab === "quality" ? (
          <QualityView />
        ) : tab === "mutes" ? (
          <MutesView />
        ) : groupBy !== "none" ? (
          <GroupList
            groups={groupsQuery.data}
            loading={groupsQuery.loading}
            by={groupBy}
            canAnalyze={canOperate && groupBy === "issue"}
            onOpen={(group) => {
              setFilter(
                groupBy === "issue"
                  ? { issue: group.key, label: group.title ?? group.key }
                  : groupBy === "client"
                    ? { clientId: group.client_id ?? undefined, label: group.label ?? "Client" }
                    : { deviceId: group.device_id ?? undefined, label: group.label ?? "Device" },
              );
              setGroupBy("none");
            }}
            onAnalyze={(group) => void runGroupAnalysis(group)}
          />
        ) : loading && alerts.length === 0 ? (
          <div className="th-alerts-scroll" aria-busy="true" aria-label="Loading alerts">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.12 }} />
            ))}
          </div>
        ) : error && alerts.length === 0 ? (
          <EmptyState
            className="th-fade-in flex-1 justify-center"
            icon={<AlertTriangle className="h-5 w-5" />}
            title="Couldn't load alerts"
            description="The server did not respond. Try again."
            action={
              <Button size="sm" variant="secondary" onClick={() => void reload()}>
                <RefreshCcw className="h-3.5 w-3.5" />
                Retry
              </Button>
            }
          />
        ) : alerts.length === 0 ? (
          <EmptyState
            className="th-fade-in flex-1 justify-center"
            icon={<CheckCircle2 className="h-5 w-5" />}
            title={
              tab === "needs_action"
                ? "Nothing needs action"
                : tab === "mine"
                  ? "You have no alerts"
                  : tab === "snoozed"
                    ? "Nothing snoozed"
                    : "No alerts match"
            }
            description={
              tab === "needs_action" ? "No P1 or P2 without an owner. Lower priorities are under All open." : undefined
            }
          />
        ) : (
          <div ref={scrollRef} className="th-alerts-scroll th-table-scroll" data-loading={stale || undefined}>
            <table className="th-alerts-table">
              <colgroup>
                <col className="w-11" />
                <col className="w-[64px]" />
                <col />
                <col className="w-[22%]" />
                <col className="w-[88px]" />
                <col className="w-[112px]" />
                <col className="w-[128px]" />
                <col className="w-[200px]" />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all alerts"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onChange={toggleAll}
                    />
                  </th>
                  <th>Priority</th>
                  <th>Alert</th>
                  <th>Device</th>
                  <th className="text-right">Value</th>
                  <th>Owner</th>
                  <th className="text-right">{tab === "resolved" ? "Resolved" : "Last seen"}</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert, index) => {
                  const tone = ALERT_SEVERITY_TONE[alert.severity] ?? ALERT_SEVERITY_TONE.info;
                  const site = alert.kind === "site_outage";
                  const real = alert.id > 0;
                  const { title, summary, value } = describeAlert(alert);
                  const deviceName =
                    alert.device_name ?? (alert.device_id != null ? `Device #${alert.device_id}` : "Enrollment tokens");
                  const seen = tab === "resolved" ? alert.resolved_at : (alert.last_seen_at ?? alert.created_at);
                  const snoozed = alert.snoozed_until && new Date(alert.snoozed_until).getTime() > Date.now();
                  return (
                    <tr
                      key={alert.id}
                      className="th-alerts-row"
                      data-selected={selected.has(alert.id)}
                      data-clickable={real || site}
                      onClick={() => (site ? openSiteOutage(alert) : real && setOpenId(alert.id))}
                      style={{ "--row-tone": tone, "--row": index } as CSSProperties}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        {real && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${title} on ${deviceName}`}
                            checked={selected.has(alert.id)}
                            onChange={() => toggleOne(alert.id)}
                          />
                        )}
                      </td>
                      <td>
                        <PriorityChip priority={alert.priority} />
                      </td>
                      <td>
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="th-alerts-kind" aria-hidden="true" style={{ color: tone }}>
                            <AlertKindIcon kind={alert.kind} fingerprint={alert.fingerprint} className="h-4 w-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="th-alerts-primary">
                              {title}
                              {(alert.occurrences ?? 1) > 1 && (
                                <span className="th-ac-times" title="Came back this many times">
                                  ×{alert.occurrences}
                                </span>
                              )}
                            </span>
                            <span className="th-alerts-secondary" title={summary.length > 48 ? summary : undefined}>
                              {summary}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="th-alerts-primary">{deviceName}</span>
                        <span className="th-alerts-secondary">
                          {alert.client_name ?? (alert.device_id != null ? "No client" : "Enrollment")}
                          {alert.device_role === "server" && " · server"}
                        </span>
                      </td>
                      <td className="text-right">
                        {value ? (
                          <span className="th-alerts-value" style={{ color: tone }}>
                            {value}
                          </span>
                        ) : (
                          <span className="th-alerts-secondary" aria-label="No value">
                            —
                          </span>
                        )}
                      </td>
                      <td>
                        {tab === "resolved" ? (
                          <span className="th-alerts-secondary">
                            {RESOLUTION_LABELS[alert.resolution ?? "auto"]}
                            {alert.resolved_by ? ` · ${alert.resolved_by}` : ""}
                          </span>
                        ) : snoozed ? (
                          <span className="th-alerts-secondary" title={formatDateTime(alert.snoozed_until)}>
                            {alert.snooze_until_worse
                              ? "Until worse"
                              : `Until ${formatLocalDateTime(alert.snoozed_until)}`}
                          </span>
                        ) : alert.assigned_to_name ? (
                          <span className="th-alerts-primary">{alert.assigned_to_name}</span>
                        ) : (
                          <span
                            className="th-alerts-secondary"
                            style={{ color: real ? "var(--th-status-warning)" : undefined }}
                          >
                            {real ? "No owner" : "—"}
                          </span>
                        )}
                      </td>
                      <td className="text-right" title={formatDateTime(seen)}>
                        <span className="th-alerts-primary tabular-nums">{timeAgo(seen)}</span>
                        <span className="th-alerts-secondary tabular-nums">{formatLocalDateTime(seen)}</span>
                      </td>
                      <td className="text-right" onClick={(e) => e.stopPropagation()}>
                        {real && canOperate && tab !== "resolved" ? (
                          <div className="flex justify-end gap-2">
                            {!alert.assigned_to_id && (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={busyIds.has(alert.id)}
                                onClick={() => take(alert.id)}
                              >
                                Take
                              </Button>
                            )}
                            {!snoozed && (
                              <SnoozeMenu
                                disabled={busyIds.has(alert.id)}
                                onSnooze={(choice) => void withBusy([alert.id], () => snoozeAlert(alert.id, choice))}
                              />
                            )}
                          </div>
                        ) : site ? (
                          <span className="th-alerts-secondary">Show devices</span>
                        ) : !real ? (
                          <span
                            className="th-alerts-secondary"
                            title="Resolves itself once the token's use limit is raised"
                          >
                            Automatic
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {listing && (alerts.length > 0 || page > 1) && (
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={Math.max(queue?.page.total ?? 0, alerts.length)}
            itemLabel="alerts"
            loading={stale}
            extra={selected.size > 0 ? `${formatCount(selected.size)} selected` : undefined}
            onPageChange={(next) => {
              setPage(next);
              scrollRef.current?.scrollTo?.({ top: 0, behavior: "smooth" });
            }}
            onPageSizeChange={setPageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        )}
      </div>

      <AlertDrawer alertId={openId} onClose={() => setOpenId(null)} onChanged={reloadAll} />

      {bulkResolve && (
        <ResolveModal
          count={selected.size}
          onClose={() => setBulkResolve(false)}
          onResolve={async (resolution, note) => {
            const ids = [...selected];
            await withBusy(ids, () => bulkAlerts({ ids, action: "resolve", resolution, note }));
            setSelected(new Set());
            setBulkResolve(false);
          }}
        />
      )}

      {groupAnalysis && <GroupAnalysisModal state={groupAnalysis} onClose={() => setGroupAnalysis(null)} />}
    </section>
  );
}

function GroupList({
  groups,
  loading,
  by,
  canAnalyze,
  onOpen,
  onAnalyze,
}: {
  groups: AlertGroup[] | undefined;
  loading: boolean;
  by: GroupBy;
  canAnalyze: boolean;
  onOpen: (group: AlertGroup) => void;
  onAnalyze: (group: AlertGroup) => void;
}) {
  if (loading && !groups) return <div className="th-alerts-skeleton" aria-busy="true" />;
  if (!groups || groups.length === 0)
    return (
      <EmptyState className="flex-1 justify-center" icon={<CheckCircle2 className="h-5 w-5" />} title="No alerts" />
    );
  return (
    <div className="th-alerts-scroll th-table-scroll">
      <table className="th-alerts-table">
        <thead>
          <tr>
            <th className="w-[64px]">Priority</th>
            <th>{by === "issue" ? "Issue" : by === "client" ? "Client" : "Device"}</th>
            <th className="text-right">Alerts</th>
            <th className="text-right">Devices</th>
            <th className="text-right">Latest</th>
            <th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group, index) => (
            <tr
              key={group.key}
              className="th-alerts-row"
              data-clickable="true"
              onClick={() => onOpen(group)}
              style={{ "--row": index } as CSSProperties}
            >
              <td>
                <PriorityChip priority={group.priority} />
              </td>
              <td>
                <div className="flex items-center gap-3">
                  <span className="th-alerts-kind" aria-hidden="true">
                    {by === "issue" && group.kind ? (
                      <AlertKindIcon kind={group.kind as AlertKind} fingerprint={group.fingerprint} />
                    ) : (
                      <Layers className="h-4 w-4" />
                    )}
                  </span>
                  <span>
                    <span className="th-alerts-primary">{group.title ?? group.label}</span>
                    {group.critical > 0 && <span className="th-alerts-secondary">{group.critical} critical</span>}
                  </span>
                </div>
              </td>
              <td className="text-right tabular-nums">{formatCount(group.count)}</td>
              <td className="text-right tabular-nums">{formatCount(group.devices)}</td>
              <td className="text-right">
                <span className="th-alerts-secondary">{group.latest ? timeAgo(group.latest) : "—"}</span>
              </td>
              <td className="text-right" onClick={(e) => e.stopPropagation()}>
                <div className="flex justify-end gap-2">
                  {canAnalyze && group.devices > 1 && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onAnalyze(group)}
                      title="One analysis for every device with this issue"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Analyze group
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => onOpen(group)}>
                    Open
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupAnalysisModal({
  state,
  onClose,
}: {
  state: { title: string; analysis: AlertAnalysis | null; error?: string };
  onClose: () => void;
}) {
  const result = state.analysis?.result;
  return (
    <Modal
      title={state.title}
      subtitle="AI analysis of every device with this issue"
      icon={Sparkles}
      tone="info"
      size="lg"
      onClose={onClose}
    >
      <div className="th-ac-ai">
        {state.error ? (
          <p className="th-ac-error">{state.error}</p>
        ) : !result ? (
          <div className="th-ac-ai-busy" role="status">
            <span className="th-ac-spinner" aria-hidden="true" />
            Claude is reading the alerts of every device… (10–60 s)
          </div>
        ) : (
          <div className="grid gap-3">
            <p>{result.summary}</p>
            {result.likely_causes.map((c, i) => (
              <p key={i}>
                <b>{c.cause}</b> · {c.confidence}
                <br />
                <small className="th-ac-muted">{c.evidence}</small>
              </p>
            ))}
            {[...result.diagnostic_steps, ...result.fix_steps].map((s, i) => (
              <div key={i} className="grid gap-2">
                <p>{s.step}</p>
                {s.command && <CommandBlock script={s.command} risk={s.risk} canRun={false} />}
              </div>
            ))}
            {result.escalate_when && <p className="th-ac-muted">{result.escalate_when}</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}
