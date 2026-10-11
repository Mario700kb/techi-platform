import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, RefreshCcw } from "lucide-react";

import { getAlertCount, getAlerts, resolveAlert } from "../api/alerts";
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
import { formatCount } from "../utils/number";
import { formatDateTime, timeAgo } from "../utils/time";

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

  const query = useMemo(() => ({
    state: "open" as const,
    severity: severity === "all" ? undefined : severity,
    kind: kind === "all" ? undefined : kind,
  }), [severity, kind]);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setFailed(false);
    try {
      const [page, countResult] = await Promise.all([
        getAlerts({ ...query, limit: PAGE_SIZE, offset: 0 }),
        getAlertCount(),
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

      <div className="rounded-xl" style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-4 pt-2" style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
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
          <div className="pb-2">
            <Select
              id="alerts-kind"
              aria-label="Filter by alert type"
              className="w-[260px]"
              value={kind}
              onChange={(value) => setKind(value as "all" | AlertKind)}
              options={kindOptions}
            />
          </div>
        </div>

        {selected.size > 0 && (
          <div className="flex items-center gap-3 px-4 py-2" style={{ borderBottom: "1px solid var(--th-border-subtle)", background: "var(--th-bg-card-soft)" }}>
            <span className="text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
              {selected.size} selected
            </span>
            <Button size="sm" variant="secondary" onClick={() => setBulkConfirmOpen(true)}>Dismiss selected</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}

        {loading && alerts.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>Loading alerts…</p>
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
            title={severity === "all" && kind === "all" ? "No open alerts" : "No open alerts match this filter"}
            description={severity === "all" && kind === "all" ? "Every managed device is quiet." : undefined}
            action={severity !== "all" || kind !== "all"
              ? <Button size="sm" variant="secondary" onClick={() => { setSeverity("all"); setKind("all"); }}>Show all alerts</Button>
              : undefined}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="w-10">
                    <input type="checkbox" aria-label="Select all alerts" checked={allSelected} onChange={toggleAll} className="h-4 w-4 rounded accent-orange-500" />
                  </th>
                  <th className="text-left">Severity</th>
                  <th className="text-left">Alert</th>
                  <th className="text-left">Device</th>
                  <th className="text-left">Opened</th>
                  <th className="text-right"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert) => {
                  const tone = ALERT_SEVERITY_TONE[alert.severity] ?? ALERT_SEVERITY_TONE.info;
                  const isDevice = alert.device_id != null && alert.id > 0;
                  const deviceName = alert.device_name ?? (alert.device_id != null ? `Device #${alert.device_id}` : "Enrollment tokens");
                  return (
                    <tr key={alert.id} style={{ borderBottom: "1px solid var(--th-border-subtle)" }}>
                      <td>
                        {alert.id > 0 && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${ALERT_KIND_LABELS[alert.kind] ?? alert.kind} on ${deviceName}`}
                            checked={selected.has(alert.id)}
                            onChange={() => toggleOne(alert.id)}
                            className="h-4 w-4 rounded accent-orange-500"
                          />
                        )}
                      </td>
                      <td>
                        <span className="th-status-chip capitalize" style={{ "--chip-tone": tone } as React.CSSProperties}>
                          <i />{alert.severity}
                        </span>
                      </td>
                      <td className="max-w-[420px]">
                        <span className="block font-medium" style={{ color: "var(--th-text-primary)" }}>
                          {ALERT_KIND_LABELS[alert.kind] ?? alert.kind}
                        </span>
                        <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }} title={alert.detail ?? alert.message}>
                          {alert.detail ?? alert.message}
                        </span>
                      </td>
                      <td className="max-w-[260px]">
                        {isDevice ? (
                          <button
                            type="button"
                            onClick={() => navigate(`/devices?device=${alert.device_id}`)}
                            className="block max-w-full truncate text-left font-medium hover:underline"
                            style={{ color: "var(--th-text-primary)" }}
                            title={`Open ${deviceName}`}
                          >
                            {deviceName}
                          </button>
                        ) : (
                          <span className="block truncate font-medium" style={{ color: "var(--th-text-primary)" }}>{deviceName}</span>
                        )}
                        <span className="block truncate text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                          {alert.client_name ?? (isDevice ? "No client" : "Enrollment")}
                        </span>
                      </td>
                      <td className="whitespace-nowrap tabular-nums" title={formatDateTime(alert.created_at)}>
                        {timeAgo(alert.created_at)}
                      </td>
                      <td className="text-right">
                        {alert.id > 0 ? (
                          <Button size="sm" variant="ghost" disabled={busyIds.has(alert.id)} onClick={() => void dismiss([alert.id])}>
                            {busyIds.has(alert.id) ? "Dismissing…" : "Dismiss"}
                          </Button>
                        ) : (
                          <span className="text-[12px]" style={{ color: "var(--th-text-faint)" }} title="Resolves itself once the token's use limit is raised">
                            Auto
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {alerts.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
            <span className="tabular-nums">
              Showing {formatCount(alerts.length)} of {formatCount(Math.max(totalForView, alerts.length))} open alerts
            </span>
            {hasMore && (
              <Button size="sm" variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            )}
          </div>
        )}
      </div>

      {bulkConfirmOpen && (
        <ConfirmationModal
          title={`Dismiss ${selected.size} ${selected.size === 1 ? "alert" : "alerts"}?`}
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
