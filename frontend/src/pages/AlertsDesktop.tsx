import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, RefreshCcw, Search, X } from "lucide-react";

import { getAlertCount, getAlerts, resolveAlert } from "../api/alerts";
import AlertKindIcon from "../components/AlertKindIcon";
import ConfirmationModal from "../components/ConfirmationModal";
import { Button, EmptyState, PageHeader, Select } from "../components/ui";
import { useAppData } from "../contexts/AppDataContext";
import { useNow } from "../hooks/useNow";
import { useTabIndicator } from "../hooks/useTabIndicator";
import {
  Alert,
  ALERT_KIND_LABELS,
  ALERT_SEVERITY_TONE,
  AlertCount,
  AlertKind,
  AlertSeverity,
} from "../types/alert";
import { describeAlert } from "../utils/alertText";
import { formatCount } from "../utils/number";
import { formatDateTime, formatLocalDateTime, timeAgo } from "../utils/time";

const PAGE_SIZE = 50;

type SeverityTab = "all" | AlertSeverity;

const SEVERITY_TABS: { id: SeverityTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "critical", label: "Critical" },
  { id: "warning", label: "Warning" },
  { id: "info", label: "Info" },
];

export default function AlertsDesktop() {
  useNow();
  const navigate = useNavigate();
  const { latestEvent, reloadAlerts } = useAppData();
  const [severity, setSeverity] = useState<SeverityTab>("all");
  const [kind, setKind] = useState<"all" | AlertKind>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [counts, setCounts] = useState<AlertCount | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const requestRef = useRef(0);
  const tabsRef = useTabIndicator<HTMLDivElement>(severity);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const query = useMemo(() => ({
    state: "open" as const,
    severity: severity === "all" ? undefined : severity,
    kind: kind === "all" ? undefined : kind,
    search: search || undefined,
  }), [severity, kind, search]);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setFailed(false);
    try {
      const [page, countResult] = await Promise.all([
        getAlerts({ ...query, limit: PAGE_SIZE, offset: 0 }),
        getAlertCount(query.search),
      ]);
      if (requestRef.current !== requestId) return;
      setAlerts(page);
      setCounts(countResult);
      setHasMore(page.filter((a) => a.id > 0).length === PAGE_SIZE);
      setSelected((prev) => new Set([...prev].filter((id) => page.some((a) => a.id === id))));
    } catch {
      if (requestRef.current === requestId) setFailed(true);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // New and resolved alerts arrive over the WebSocket; refetch once a burst
  // settles instead of on every event.
  const reloadTimer = useRef<number | undefined>();
  useEffect(() => {
    if (latestEvent?.type !== "alert_created" && latestEvent?.type !== "alert_resolved") return;
    window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => void load(), 1500);
  }, [latestEvent, load]);
  useEffect(() => () => window.clearTimeout(reloadTimer.current), []);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const offset = alerts.filter((a) => a.id > 0).length;
      const page = await getAlerts({ ...query, limit: PAGE_SIZE, offset });
      setAlerts((prev) => [...prev, ...page.filter((a) => !prev.some((p) => p.id === a.id))]);
      setHasMore(page.length === PAGE_SIZE);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const dismiss = async (ids: number[]) => {
    setBusyIds((prev) => new Set([...prev, ...ids]));
    const results = await Promise.allSettled(ids.map((id) => resolveAlert(id)));
    const done = new Set(ids.filter((_, i) => results[i].status === "fulfilled"));
    setAlerts((prev) => prev.filter((a) => !done.has(a.id)));
    setSelected((prev) => new Set([...prev].filter((id) => !done.has(id))));
    setBusyIds((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
    reloadAlerts();
    void load();
  };

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

  const severityCount = (id: SeverityTab) =>
    id === "all" ? counts?.total_open ?? 0 : counts?.by_severity[id] ?? 0;
  const visibleTabs = SEVERITY_TABS.filter((tab) => tab.id === "all" || tab.id === severity || severityCount(tab.id) > 0);
  const kindOptions = [
    { value: "all", label: "All types" },
    ...Object.entries(counts?.by_kind ?? {})
      .filter(([, n]) => n > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([value, n]) => ({ value, label: `${ALERT_KIND_LABELS[value as AlertKind] ?? value} · ${formatCount(n)}` })),
  ];
  const totalForView = kind === "all" ? severityCount(severity) : counts?.by_kind?.[kind] ?? alerts.length;
  const filtered = severity !== "all" || kind !== "all" || search !== "";
  const resetFilters = () => {
    setSeverity("all");
    setKind("all");
    setSearchInput("");
    setSearch("");
  };

  const kpis: { id: SeverityTab | null; label: string; value: number; tone: string; hint: string }[] = [
    {
      id: "all",
      label: "Open alerts",
      value: counts?.total_open ?? 0,
      tone: "var(--th-accent)",
      hint: counts?.oldest_open_at ? `Oldest opened ${timeAgo(counts.oldest_open_at)}` : "Nothing open",
    },
    { id: "critical", label: "Critical", value: counts?.by_severity.critical ?? 0, tone: ALERT_SEVERITY_TONE.critical, hint: "Needs action now" },
    { id: "warning", label: "Warning", value: counts?.by_severity.warning ?? 0, tone: ALERT_SEVERITY_TONE.warning, hint: "Review soon" },
    { id: null, label: "Devices affected", value: counts?.devices_affected ?? 0, tone: "var(--th-status-info)", hint: "With at least one open alert" },
  ];

  return (
    <section className="premium-page space-y-4">
      <PageHeader
        title="Alerts"
        description="Open alerts on the devices you manage, newest first."
        actions={
          <Button size="sm" variant="secondary" onClick={() => { setLoading(true); void load(); }}>
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((kpi) => {
          const body = (
            <>
              <span className="th-kpi-label"><span className="th-kpi-dot" />{kpi.label}</span>
              <span className="th-kpi-value">{counts ? formatCount(kpi.value) : "—"}</span>
              <span className="th-kpi-hint">{kpi.hint}</span>
            </>
          );
          return kpi.id ? (
            <button
              key={kpi.label}
              type="button"
              className="th-kpi"
              aria-pressed={kpi.id !== "all" && severity === kpi.id}
              onClick={() => setSeverity(kpi.id === severity && kpi.id !== "all" ? "all" : (kpi.id as SeverityTab))}
              style={{ "--kpi-tone": kpi.tone } as React.CSSProperties}
            >
              {body}
            </button>
          ) : (
            <div key={kpi.label} className="th-kpi" style={{ "--kpi-tone": kpi.tone } as React.CSSProperties}>
              {body}
            </div>
          );
        })}
      </div>

      <div className="th-alerts-card th-table-scroll">
        <div className="th-alerts-toolbar">
          <div ref={tabsRef} role="tablist" aria-label="Alert severity" className="th-tabs">
            {visibleTabs.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={severity === id}
                onClick={() => setSeverity(id)}
                className="th-tab"
                style={id === "all" ? undefined : ({ "--tab-tone": ALERT_SEVERITY_TONE[id] } as React.CSSProperties)}
              >
                {id !== "all" && <span className="th-tab-dot" aria-hidden="true" />}
                {label}
                <span className="th-tab-count">{formatCount(severityCount(id))}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 pb-2">
            <label className="th-search th-search-sm w-[260px]">
              <Search className="h-3.5 w-3.5 flex-none" />
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search device, client or message"
                aria-label="Search alerts"
              />
              {searchInput && (
                <button type="button" onClick={() => setSearchInput("")} className="th-explorer-clear" aria-label="Clear search">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </label>
            <Select
              id="alerts-kind"
              aria-label="Filter by alert type"
              className="!h-8 w-[240px]"
              value={kind}
              onChange={(value) => setKind(value as "all" | AlertKind)}
              options={kindOptions}
            />
          </div>
        </div>

        {selected.size > 0 && (
          <div className="th-alerts-bulk">
            <span className="tabular-nums">{formatCount(selected.size)} selected</span>
            <Button size="sm" variant="secondary" onClick={() => setBulkConfirmOpen(true)}>Dismiss selected</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
          </div>
        )}

        {loading && alerts.length === 0 ? (
          <div aria-busy="true" aria-label="Loading alerts">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.12 }} />
            ))}
          </div>
        ) : failed && alerts.length === 0 ? (
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title="Couldn't load alerts"
            description="The server did not respond. Try again."
            action={<Button size="sm" variant="secondary" onClick={() => void load()}><RefreshCcw className="h-3.5 w-3.5" />Retry</Button>}
          />
        ) : alerts.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="h-5 w-5" />}
            title={filtered ? "No open alerts match these filters" : "No open alerts"}
            description={filtered ? undefined : "Every managed device is quiet."}
            action={filtered ? <Button size="sm" variant="secondary" onClick={resetFilters}>Clear filters</Button> : undefined}
          />
        ) : (
          <table className="th-alerts-table">
            <colgroup>
              <col className="w-11" />
              <col className="w-[132px]" />
              <col />
              <col className="w-[26%]" />
              <col className="w-[104px]" />
              <col className="w-[136px]" />
              <col className="w-[112px]" />
            </colgroup>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all alerts"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onChange={toggleAll}
                  />
                </th>
                <th>Severity</th>
                <th>Alert</th>
                <th>Device</th>
                <th className="text-right">Value</th>
                <th className="text-right">Opened</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => {
                const tone = ALERT_SEVERITY_TONE[alert.severity] ?? ALERT_SEVERITY_TONE.info;
                const isDevice = alert.device_id != null && alert.id > 0;
                const deviceName = alert.device_name ?? (alert.device_id != null ? `Device #${alert.device_id}` : "Enrollment tokens");
                const kindLabel = ALERT_KIND_LABELS[alert.kind] ?? alert.kind;
                const { summary, value } = describeAlert(alert);
                const openDevice = () => { if (isDevice) navigate(`/devices?device=${alert.device_id}`); };
                return (
                  <tr
                    key={alert.id}
                    data-selected={selected.has(alert.id)}
                    data-clickable={isDevice}
                    onClick={openDevice}
                    style={{ "--row-tone": tone } as React.CSSProperties}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      {alert.id > 0 && (
                        <input
                          type="checkbox"
                          aria-label={`Select ${kindLabel} on ${deviceName}`}
                          checked={selected.has(alert.id)}
                          onChange={() => toggleOne(alert.id)}
                        />
                      )}
                    </td>
                    <td>
                      <span className="th-status-chip capitalize" style={{ "--chip-tone": tone } as React.CSSProperties}>
                        <i />{alert.severity}
                      </span>
                    </td>
                    <td>
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="th-alerts-kind" aria-hidden="true"><AlertKindIcon kind={alert.kind} className="h-4 w-4" /></span>
                        <span className="min-w-0">
                          <span className="th-alerts-primary">{kindLabel}</span>
                          <span className="th-alerts-secondary" title={summary}>{summary}</span>
                        </span>
                      </div>
                    </td>
                    <td>
                      {isDevice ? (
                        <a
                          href={`/devices?device=${alert.device_id}`}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); openDevice(); }}
                          className="th-alerts-primary th-alerts-link"
                          title={`Open ${deviceName}`}
                        >
                          {deviceName}
                        </a>
                      ) : (
                        <span className="th-alerts-primary">{deviceName}</span>
                      )}
                      <span className="th-alerts-secondary">{alert.client_name ?? (isDevice ? "No client" : "Enrollment")}</span>
                    </td>
                    <td className="text-right">
                      {value ? (
                        <span className="th-alerts-value" style={{ color: tone }}>{value}</span>
                      ) : (
                        <span className="th-alerts-secondary" aria-label="No value">—</span>
                      )}
                    </td>
                    <td className="text-right" title={formatDateTime(alert.created_at)}>
                      <span className="th-alerts-primary tabular-nums">{timeAgo(alert.created_at)}</span>
                      <span className="th-alerts-secondary tabular-nums">{formatLocalDateTime(alert.created_at)}</span>
                    </td>
                    <td className="text-right" onClick={(e) => e.stopPropagation()}>
                      {alert.id > 0 ? (
                        <Button size="sm" variant="secondary" disabled={busyIds.has(alert.id)} onClick={() => void dismiss([alert.id])}>
                          {busyIds.has(alert.id) ? "Dismissing…" : "Dismiss"}
                        </Button>
                      ) : (
                        <span className="th-alerts-secondary" title="Resolves itself once the token's use limit is raised">Automatic</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {alerts.length > 0 && (
          <div className="th-alerts-footer">
            <span className="tabular-nums">
              Showing 1–{formatCount(alerts.length)} of {formatCount(Math.max(totalForView, alerts.length))}
            </span>
            {hasMore || alerts.length < totalForView ? (
              <Button size="sm" variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? "Loading…" : `Load ${Math.min(PAGE_SIZE, Math.max(totalForView - alerts.length, 0)) || PAGE_SIZE} more`}
              </Button>
            ) : (
              <span>All alerts shown</span>
            )}
          </div>
        )}
      </div>

      {bulkConfirmOpen && (
        <ConfirmationModal
          title={`Dismiss ${formatCount(selected.size)} ${selected.size === 1 ? "alert" : "alerts"}?`}
          confirmLabel="Dismiss"
          destructive={false}
          onClose={() => setBulkConfirmOpen(false)}
          onConfirm={() => {
            const ids = [...selected];
            setBulkConfirmOpen(false);
            void dismiss(ids);
          }}
        >
          They are marked resolved for every operator. If the problem happens again, a new alert opens.
        </ConfirmationModal>
      )}
    </section>
  );
}
