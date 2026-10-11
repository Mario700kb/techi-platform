import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, ChevronRight, ClipboardList, Clock, Filter, RefreshCcw, ShieldAlert, SlidersHorizontal, X } from "lucide-react";
import {
  ACTION_LABELS,
  AuditFacets,
  AuditFilters,
  AuditLogEntry,
  ENTITY_TYPE_LABELS,
  getAuditFacets,
  getAuditLogs,
} from "../api/audit";
import { Button, EmptyState, PageHeader, Select } from "../components/ui";
import TablePagination from "../components/ui/TablePagination";
import { CardHead } from "../components/ui/PanelCard";
import { TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";
import { formatLocalDateTime, timeAgo, tiranaInputToUtcIso, utcToTiranaInput } from "../utils/time";

/** "notification_channel_created" → "Notification channel created" */
function humanize(value: string): string {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const actionLabel = (action: string) => ACTION_LABELS[action] ?? humanize(action);
const entityLabel = (type: string) => ENTITY_TYPE_LABELS[type] ?? humanize(type);

// One tone per family of actions, so the column reads at a glance; red is
// kept for failures alone.
function actionTone(action: string): string {
  if (/(failed|denied|blocked|deleted|forced)/.test(action)) return TONE.critical;
  if (action === "login") return TONE.info;
  if (action.startsWith("remote_") || action.startsWith("terminal_") || action.startsWith("ssh_")) return "var(--th-status-agent)";
  if (action.startsWith("action_")) return TONE.warning;
  if (action.startsWith("operator_") || action.startsWith("team_") || action.startsWith("scope_")) return TONE.maintenance;
  if (action.startsWith("agent_package_") || action.startsWith("enrollment_token_") || action.startsWith("bootstrap_")) return TONE.online;
  if (action.startsWith("report_")) return "var(--th-series-2)";
  return TONE.neutral;
}

function isDenied(error: string | null): boolean {
  return /Permission denied|Insufficient role/.test(error ?? "");
}

function DetailsBlock({ json }: { json: string | null }) {
  if (!json) return <p className="th-onb-hint">No details recorded for this event.</p>;
  let pretty = json;
  try {
    pretty = JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    // Not JSON: show it as stored.
  }
  return <pre className="th-onb-code max-h-56 overflow-auto whitespace-pre-wrap break-all p-3">{pretty}</pre>;
}

export default function Audit() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [facets, setFacets] = useState<AuditFacets | null>(null);
  const firstLoadDoneRef = useRef(false);

  const [filters, setFilters] = useState<AuditFilters>({});
  const [draft, setDraft] = useState<AuditFilters>({});

  const load = useCallback(async (f: AuditFilters, p: number, size: number) => {
    const showLoading = !firstLoadDoneRef.current;
    try {
      if (showLoading) setLoading(true);
      setError(null);
      const result = await getAuditLogs({ ...f, limit: size, offset: (p - 1) * size });
      setEntries(result.items);
      setTotal(result.total);
      firstLoadDoneRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filters, page, pageSize);
  }, [filters, page, pageSize, load]);

  useEffect(() => {
    const id = window.setInterval(() => void load(filters, page, pageSize), 120000);
    return () => window.clearInterval(id);
  }, [filters, page, pageSize, load]);

  useEffect(() => {
    getAuditFacets().then(setFacets).catch(() => setFacets(null));
  }, []);

  const applyFilters = () => {
    setPage(1);
    setExpanded(new Set());
    setFilters({ ...draft });
  };

  const clearFilters = () => {
    setDraft({});
    setPage(1);
    setExpanded(new Set());
    setFilters({});
  };

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activeFilters = Object.values(filters).filter(Boolean).length;
  const draftChanged = JSON.stringify(draft) !== JSON.stringify(filters);
  const latest = entries[0];

  const actionOptions = useMemo(
    () => [
      { value: "", label: "All actions" },
      ...(facets?.actions ?? []).map((f) => ({ value: f.value, label: actionLabel(f.value), hint: `${formatCount(f.count)} events` })),
    ],
    [facets],
  );
  const entityOptions = useMemo(
    () => [
      { value: "", label: "All entity types" },
      ...(facets?.entity_types ?? []).map((f) => ({ value: f.value, label: entityLabel(f.value), hint: `${formatCount(f.count)} events` })),
    ],
    [facets],
  );
  const operatorOptions = useMemo(
    () => [
      { value: "", label: "All operators" },
      ...(facets?.operators ?? []).map((f) => ({ value: f.value, label: f.value, hint: `${formatCount(f.count)} events` })),
    ],
    [facets],
  );

  if (isDenied(error)) {
    return (
      <section className="premium-page th-onb space-y-4">
        <PageHeader title="Audit Log" description="Append-only record of operator actions across the platform." />
        <div className="th-onb-card th-onb-enter">
          <EmptyState icon={<ShieldAlert className="h-5 w-5" />} title="Access denied" description="Your role does not include the audit log." />
        </div>
      </section>
    );
  }

  return (
    <section className="premium-page th-onb space-y-4">
      <PageHeader
        title="Audit Log"
        description="Append-only record of operator actions across the platform."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void load(filters, page, pageSize)} disabled={loading}>
            <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      {error && (
        <div className="th-onb-note th-onb-reveal" style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties} role="alert">
          <AlertTriangle className="h-4 w-4" />
          <span className="flex-1">{error}</span>
          <button type="button" className="th-onb-action !h-5 !w-5" onClick={() => setError(null)} aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* ── summary ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: activeFilters ? "Matching events" : "Events recorded", value: formatCount(total), hint: activeFilters ? "With the filters applied" : "Since the log began", icon: ClipboardList, tone: "var(--th-accent)" },
          { label: "Latest event", value: latest ? timeAgo(latest.created_at) : "—", hint: latest ? `${latest.operator_username ?? "system"} · ${actionLabel(latest.action)}` : "Nothing recorded", icon: Clock, tone: TONE.info },
          { label: "Active filters", value: String(activeFilters), hint: activeFilters ? "Clear them to see everything" : "Showing every event", icon: SlidersHorizontal, tone: activeFilters ? TONE.warning : TONE.neutral },
        ].map((item, index) => (
          <div key={item.label} className="th-onb-card th-onb-stat th-onb-enter" style={{ "--i": index } as CSSProperties}>
            <span className="th-onb-icon" style={{ "--onb-tone": item.tone } as CSSProperties}><item.icon className="h-4 w-4" /></span>
            <div className="min-w-0">
              <div className="text-[12px] font-medium" style={{ color: "var(--th-text-muted)" }}>{item.label}</div>
              <div className="truncate text-[24px] font-semibold leading-8 tabular-nums" style={{ color: "var(--th-text-primary)" }}>{item.value}</div>
              <div className="truncate text-[12px]" style={{ color: "var(--th-text-faint)" }}>{item.hint}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── filters ─────────────────────────────────────────────────────── */}
      <div className="th-onb-card th-onb-enter" style={{ "--i": 3 } as CSSProperties}>
        <CardHead
          icon={Filter}
          tone="var(--th-accent)"
          title="Filters"
          subtitle="Times are Tirana time"
          aside={
            <div className="flex gap-2">
              {activeFilters > 0 && <Button size="sm" variant="secondary" onClick={clearFilters}><X className="h-3.5 w-3.5" />Clear</Button>}
              <Button size="sm" onClick={applyFilters} disabled={loading || !draftChanged}>Apply</Button>
            </div>
          }
        />
        <div className="th-onb-body">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <div className="th-onb-field">
              Operator
              <Select id="filter-operator" aria-label="Filter by operator" value={draft.operator_username ?? ""} onChange={(value) => setDraft((d) => ({ ...d, operator_username: value || undefined }))} options={operatorOptions} />
            </div>
            <div className="th-onb-field">
              Action
              <Select id="filter-action" aria-label="Filter by action" value={draft.action ?? ""} onChange={(value) => setDraft((d) => ({ ...d, action: value || undefined }))} options={actionOptions} />
            </div>
            <div className="th-onb-field">
              Entity type
              <Select id="filter-entity-type" aria-label="Filter by entity type" value={draft.entity_type ?? ""} onChange={(value) => setDraft((d) => ({ ...d, entity_type: value || undefined }))} options={entityOptions} />
            </div>
            <label className="th-onb-field">
              From
              <input type="datetime-local" value={utcToTiranaInput(draft.from_dt)} onChange={(e) => setDraft((d) => ({ ...d, from_dt: e.target.value ? tiranaInputToUtcIso(e.target.value) : undefined }))} />
            </label>
            <label className="th-onb-field">
              To
              <input type="datetime-local" value={utcToTiranaInput(draft.to_dt)} onChange={(e) => setDraft((d) => ({ ...d, to_dt: e.target.value ? tiranaInputToUtcIso(e.target.value) : undefined }))} />
            </label>
          </div>
        </div>
      </div>

      {/* ── events ──────────────────────────────────────────────────────── */}
      <div className="th-alerts-card th-onb-tokens th-onb-enter" style={{ "--i": 4 } as CSSProperties}>
        <CardHead
          icon={ClipboardList}
          tone="var(--th-accent)"
          title="Events"
          subtitle={loading && entries.length === 0 ? "Loading…" : `${formatCount(total)} event${total === 1 ? "" : "s"} · select a row for its details`}
        />

        {loading && entries.length === 0 ? (
          <div className="th-alerts-scroll" aria-busy="true" aria-label="Loading events">
            {Array.from({ length: 8 }).map((_, i) => <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.1 }} />)}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            className="th-fade-in py-10"
            icon={<ClipboardList className="h-5 w-5" />}
            title={activeFilters ? "No events match these filters" : "No events recorded"}
            action={activeFilters ? <Button size="sm" variant="secondary" onClick={clearFilters}>Clear filters</Button> : undefined}
          />
        ) : (
          <div className="th-alerts-scroll th-table-scroll">
            <table className="th-alerts-table" data-mobile="cards">
              <colgroup>
                <col className="w-11" />
                <col className="w-[170px]" />
                <col className="w-[180px]" />
                <col />
                <col className="w-[22%]" />
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="Details" />
                  <th>When</th>
                  <th>Operator</th>
                  <th>Action</th>
                  <th>Entity</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => {
                  const open = expanded.has(entry.id);
                  const tone = actionTone(entry.action);
                  const who = entry.operator_username ?? "system";
                  return (
                    <Fragment key={entry.id}>
                      <tr
                        className="th-alerts-row"
                        data-clickable="true"
                        data-selected={open || undefined}
                        aria-expanded={open}
                        style={{ "--row": index } as CSSProperties}
                        onClick={() => toggleExpand(entry.id)}
                      >
                        <td data-m="hide">
                          <ChevronRight className="th-onb-chevron h-4 w-4" data-open={open || undefined} style={{ color: "var(--th-text-faint)" }} />
                        </td>
                        <td>
                          <span className="th-alerts-primary tabular-nums">{timeAgo(entry.created_at)}</span>
                          <span className="th-alerts-secondary tabular-nums">{formatLocalDateTime(entry.created_at)}</span>
                        </td>
                        <td>
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="th-onb-avatar" aria-hidden="true">{who.charAt(0).toUpperCase()}</span>
                            <span className="th-alerts-primary truncate">{who}</span>
                          </span>
                        </td>
                        <td>
                          <span className="th-status-chip" style={{ "--chip-tone": tone } as CSSProperties}><i />{actionLabel(entry.action)}</span>
                        </td>
                        <td>
                          {entry.entity_type ? (
                            <>
                              <span className="th-alerts-primary">{entityLabel(entry.entity_type)}</span>
                              {entry.entity_id != null && <span className="th-alerts-secondary font-mono">#{entry.entity_id}</span>}
                            </>
                          ) : (
                            <span className="th-alerts-secondary">—</span>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="th-onb-detail-row">
                          <td data-m="hide" />
                          <td colSpan={4}>
                            <div className="th-onb-reveal py-1">
                              <DetailsBlock json={entry.details_json} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 && (
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={(next) => { setPage(next); setExpanded(new Set()); }}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); setExpanded(new Set()); }}
            pageSizeOptions={[25, 50, 100]}
            itemLabel="events"
            loading={loading}
          />
        )}
      </div>
    </section>
  );
}
