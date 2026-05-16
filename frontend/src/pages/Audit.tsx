import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ClipboardList, Filter, RefreshCcw, X } from "lucide-react";
import {
  ACTION_LABELS,
  ALL_ACTIONS,
  ALL_ENTITY_TYPES,
  AuditFilters,
  AuditLogEntry,
  ENTITY_TYPE_LABELS,
  getAuditLogs,
} from "../api/audit";
import { Button } from "../components/ui";

const PAGE_SIZE = 100;

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function actionBadgeClass(action: string): string {
  if (action === "login") return "border-sky-400/25 bg-sky-400/10 text-sky-300";
  if (action.startsWith("operator_")) return "border-violet-400/25 bg-violet-400/10 text-violet-300";
  if (action.startsWith("device_") || action.startsWith("maintenance_") || action.startsWith("note_"))
    return "border-amber-400/25 bg-amber-400/10 text-amber-200";
  if (action.startsWith("action_")) return "border-orange-400/25 bg-orange-400/10 text-orange-300";
  if (action.startsWith("scope_")) return "border-emerald-400/25 bg-emerald-400/10 text-emerald-300";
  return "border-slate-500/30 bg-slate-800/50 text-slate-400";
}

const INPUT_CLS =
  "rounded-md border border-white/[0.08] bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white outline-none focus:border-techi-orange/50 placeholder:text-slate-600";
const SELECT_CLS = INPUT_CLS + " cursor-pointer";

interface DetailsRowProps {
  json: string | null;
}
function DetailsRow({ json }: DetailsRowProps) {
  if (!json) return <p className="text-xs text-slate-500 italic">No details</p>;
  try {
    const parsed = JSON.parse(json);
    return (
      <pre className="max-h-40 overflow-auto rounded-md border border-white/[0.08] bg-slate-900/70 p-3 text-[11px] leading-5 text-slate-300">
        {JSON.stringify(parsed, null, 2)}
      </pre>
    );
  } catch {
    return <p className="text-xs text-slate-400 font-mono">{json}</p>;
  }
}

export default function Audit() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const firstLoadDoneRef = useRef(false);

  const [filters, setFilters] = useState<AuditFilters>({});
  const [draft, setDraft] = useState<AuditFilters>({});

  const load = useCallback(async (f: AuditFilters, off: number) => {
    const showLoading = !firstLoadDoneRef.current;
    try {
      if (showLoading) {
        setLoading(true);
      }
      setError(null);
      const page = await getAuditLogs({ ...f, limit: PAGE_SIZE, offset: off });
      setEntries(page.items);
      setTotal(page.total);
      firstLoadDoneRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(filters, offset);
  }, [filters, offset, load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void load(filters, offset);
    }, 120000);
    return () => window.clearInterval(id);
  }, [filters, offset, load]);

  const applyFilters = () => {
    setOffset(0);
    setExpanded(new Set());
    setFilters({ ...draft });
  };

  const clearFilters = () => {
    setDraft({});
    setOffset(0);
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

  const hasFilters = Object.values(filters).some(Boolean);
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <section className="premium-page space-y-5">
      <div className="premium-card overflow-hidden p-5 md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="premium-kicker">Security & Compliance</p>
            <h1 className="mt-1.5 text-3xl font-semibold text-white">Audit Log</h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-400">
              Append-only record of operator actions across the platform.
            </p>
          </div>
          <Button size="sm" onClick={() => void load(filters, offset)} disabled={loading}>
            <RefreshCcw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="premium-card-soft p-4">
        <div className="mb-3 flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-techi-orange" />
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Filters</span>
          {hasFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="ml-auto flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold text-slate-400 transition hover:bg-white/[0.05] hover:text-white"
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
          <input
            className={INPUT_CLS}
            placeholder="Operator username"
            value={draft.operator_username ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, operator_username: e.target.value || undefined }))}
          />
          <select
            className={SELECT_CLS}
            value={draft.action ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value || undefined }))}
          >
            <option value="">All actions</option>
            {ALL_ACTIONS.map((a) => (
              <option key={a} value={a}>{ACTION_LABELS[a] ?? a}</option>
            ))}
          </select>
          <select
            className={SELECT_CLS}
            value={draft.entity_type ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, entity_type: e.target.value || undefined }))}
          >
            <option value="">All entity types</option>
            {ALL_ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>{ENTITY_TYPE_LABELS[t] ?? t}</option>
            ))}
          </select>
          <input
            type="datetime-local"
            className={INPUT_CLS}
            value={draft.from_dt ? draft.from_dt.slice(0, 16) : ""}
            onChange={(e) => setDraft((d) => ({ ...d, from_dt: e.target.value ? new Date(e.target.value).toISOString() : undefined }))}
            title="From date/time"
          />
          <input
            type="datetime-local"
            className={INPUT_CLS}
            value={draft.to_dt ? draft.to_dt.slice(0, 16) : ""}
            onChange={(e) => setDraft((d) => ({ ...d, to_dt: e.target.value ? new Date(e.target.value).toISOString() : undefined }))}
            title="To date/time"
          />
        </div>
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={applyFilters} disabled={loading}>
            Apply
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-sm font-medium text-red-100">
          {error}
        </div>
      )}

      <div className="premium-card-soft overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-techi-orange" />
            <span className="text-sm font-semibold text-white">
              {loading ? "Loading…" : `${total.toLocaleString()} event${total !== 1 ? "s" : ""}`}
            </span>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <button
                type="button"
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0}
                className="rounded px-2 py-0.5 transition hover:bg-white/[0.05] disabled:opacity-40"
              >
                ← Prev
              </button>
              <span>{currentPage} / {totalPages}</span>
              <button
                type="button"
                onClick={() => setOffset(offset + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= total}
                className="rounded px-2 py-0.5 transition hover:bg-white/[0.05] disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <th className="w-6 px-3 py-3" />
                <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">When</th>
                <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Operator</th>
                <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Action</th>
                <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Entity</th>
                <th className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {entries.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm font-medium text-slate-500">
                    {loading ? "Loading…" : "No events found."}
                  </td>
                </tr>
              )}
              {entries.map((entry) => {
                const isExpanded = expanded.has(entry.id);
                return [
                  <tr
                    key={entry.id}
                    className="cursor-pointer transition hover:bg-white/[0.025]"
                    onClick={() => toggleExpand(entry.id)}
                  >
                    <td className="px-3 py-3 text-slate-500">
                      {isExpanded
                        ? <ChevronDown className="h-3.5 w-3.5" />
                        : <ChevronRight className="h-3.5 w-3.5" />}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-slate-400" title={new Date(entry.created_at).toLocaleString()}>
                      {timeAgo(entry.created_at)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="font-mono text-[13px] font-medium text-slate-200">
                        {entry.operator_username ?? "—"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${actionBadgeClass(entry.action)}`}>
                        {ACTION_LABELS[entry.action] ?? entry.action}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-slate-400 capitalize">
                      {entry.entity_type ? (ENTITY_TYPE_LABELS[entry.entity_type] ?? entry.entity_type) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] font-mono text-slate-500">
                      {entry.entity_id ?? "—"}
                    </td>
                  </tr>,
                  isExpanded && (
                    <tr key={`${entry.id}-detail`} className="bg-slate-950/60">
                      <td />
                      <td colSpan={5} className="px-4 py-3">
                        <DetailsRow json={entry.details_json} />
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
