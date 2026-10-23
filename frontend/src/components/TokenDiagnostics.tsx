import { useEffect, useState } from "react";
import { Info, LoaderCircle, X } from "lucide-react";

import {
  EnrollmentAuditEvent,
  EnrollmentToken,
  EnrollmentTokenDiagnostics,
  getEnrollmentTokenDiagnostics,
  getEnrollmentTokenEvents,
} from "../api/enrollmentBootstrap";
import { formatTokenPrefix } from "./EnrollmentTokenBits";
import { Button } from "./ui";
import { formatLocalDateTime } from "../utils/time";

// Enrollment history of one token (uses, duplicates, failures, the audit
// trail), opened from the token table. Owns its own loading so a caller only
// says which token to show.
export default function TokenDiagnostics({ token, onClose }: { token: EnrollmentToken; onClose: () => void }) {
  const [diagnostics, setDiagnostics] = useState<EnrollmentTokenDiagnostics | null>(null);
  const [events, setEvents] = useState<EnrollmentAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiagnostics(null);
    setEvents([]);
    setError(null);
    setLoading(true);
    Promise.all([getEnrollmentTokenDiagnostics(token.id), getEnrollmentTokenEvents(token.id, { limit: 50 })])
      .then(([summary, firstEvents]) => {
        if (cancelled) return;
        setDiagnostics(summary);
        setEvents(firstEvents);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load token diagnostics"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [token.id]);

  const loadMore = async () => {
    if (eventsLoading) return;
    setEventsLoading(true);
    try {
      const next = await getEnrollmentTokenEvents(token.id, { limit: 50, offset: events.length });
      setEvents((current) => [...current, ...next]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more enrollment events");
    } finally {
      setEventsLoading(false);
    }
  };

  return (
    <TokenDiagnosticsDrawer
      token={token}
      diagnostics={diagnostics}
      events={events}
      loading={loading}
      eventsLoading={eventsLoading}
      error={error}
      onLoadMore={() => void loadMore()}
      onClose={onClose}
    />
  );
}

function diagnosticValue(value?: number | null): string {
  return value === null || value === undefined ? "Unknown" : String(value);
}

function resultBadgeClass(result: EnrollmentAuditEvent["result"]): string {
  if (result === "failed") return "border-red-400/25 bg-red-400/10 text-red-300";
  if (result === "duplicate" || result === "updated_existing") {
    return "border-amber-400/25 bg-amber-400/10 text-amber-300";
  }
  if (result === "ignored") return "border-slate-500/25 bg-slate-500/10 text-slate-400";
  return "border-emerald-400/25 bg-emerald-400/10 text-emerald-300";
}

function TokenDiagnosticsDrawer({
  token,
  diagnostics,
  events,
  loading,
  eventsLoading,
  error,
  onLoadMore,
  onClose,
}: {
  token: EnrollmentToken;
  diagnostics: EnrollmentTokenDiagnostics | null;
  events: EnrollmentAuditEvent[];
  loading: boolean;
  eventsLoading: boolean;
  error: string | null;
  onLoadMore: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const metrics = [
    ["Uses", `${token.use_count} / ${token.max_uses}`],
    ["Unique devices", diagnosticValue(diagnostics?.unique_devices)],
    ["Duplicate / re-enrollments", diagnosticValue(diagnostics?.duplicate_enrollments)],
    ["Failed attempts", diagnosticValue(diagnostics?.failed_events)],
    ["Orphaned uses", diagnosticValue(diagnostics?.orphaned_uses)],
    ["Archived devices", diagnosticValue(diagnostics?.archived_devices)],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[var(--th-scrim)] backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="flex h-full w-full max-w-6xl flex-col border-l border-[color:var(--th-border-default)] bg-[var(--th-bg-surface)] shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={`Token diagnostics: ${token.name}`}
      >
        <div className="flex items-start justify-between border-b border-[color:var(--th-border-subtle)] px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-techi-orange">Token Diagnostics</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-100">{token.name}</h2>
            <p className="mt-1 font-mono text-xs text-slate-500">{formatTokenPrefix(token.token_prefix)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-500 hover:bg-[var(--th-chip-bg)] hover:text-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Loading diagnostics…
            </div>
          )}
          {error && (
            <div className="mb-4 rounded-lg border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">
              {error}
            </div>
          )}
          {!loading && diagnostics && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {metrics.map(([label, value]) => (
                  <div key={label} className="premium-card-soft p-4">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
                    <p className="mt-2 text-xl font-semibold text-slate-100">{value}</p>
                  </div>
                ))}
              </div>

              {diagnostics.inference_note && (
                <div className="mt-4 flex gap-2 rounded-lg border border-blue-400/15 bg-blue-400/[0.06] p-3 text-xs leading-5 text-blue-100">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
                  <span>
                    {diagnostics.inferred && <strong className="mr-1">Inferred:</strong>}
                    {diagnostics.inference_note}
                  </span>
                </div>
              )}

              <div className="mt-6 overflow-hidden rounded-xl border border-[color:var(--th-border-subtle)]">
                <div className="border-b border-[color:var(--th-border-subtle)] px-4 py-3">
                  <h3 className="text-sm font-semibold text-slate-100">Enrollment History</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1050px] text-left text-xs">
                    <thead className="th-table-head">
                      <tr className="uppercase tracking-wide text-slate-500">
                        <th className="px-3 py-3">Time</th>
                        <th className="px-3 py-3">Hostname</th>
                        <th className="px-3 py-3">User</th>
                        <th className="px-3 py-3">Device</th>
                        <th className="px-3 py-3">RustDesk ID</th>
                        <th className="px-3 py-3">Result</th>
                        <th className="px-3 py-3">Reason</th>
                        <th className="px-3 py-3">IP</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[color:var(--th-border-subtle)]">
                      {!events.length && (
                        <tr>
                          <td colSpan={8} className="px-3 py-10 text-center text-slate-500">
                            No enrollment audit events recorded.
                          </td>
                        </tr>
                      )}
                      {events.map((event) => (
                        <tr key={event.id} className="text-slate-300">
                          <td className="whitespace-nowrap px-3 py-3 text-slate-500">
                            {formatLocalDateTime(event.created_at)}
                          </td>
                          <td className="px-3 py-3 font-semibold text-slate-100">{event.hostname || "—"}</td>
                          <td className="px-3 py-3">{event.username || "—"}</td>
                          <td className="px-3 py-3">{event.device_id ? `#${event.device_id}` : "—"}</td>
                          <td className="px-3 py-3 font-mono">{event.rustdesk_id || "—"}</td>
                          <td className="px-3 py-3">
                            <span
                              className={`inline-flex rounded-full border px-2 py-0.5 font-semibold ${resultBadgeClass(event.result)}`}
                            >
                              {event.result.replace("_", " ")}
                            </span>
                          </td>
                          <td
                            className="max-w-[240px] truncate px-3 py-3"
                            title={event.raw_error || event.reason || ""}
                          >
                            {event.reason || event.raw_error || "—"}
                          </td>
                          <td className="px-3 py-3 font-mono text-slate-400">
                            {event.public_ip || event.local_ip || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {events.length > 0 && events.length % 50 === 0 && (
                  <div className="flex justify-center border-t border-[color:var(--th-border-subtle)] p-3">
                    <Button size="sm" onClick={onLoadMore} disabled={eventsLoading} variant="secondary">
                      {eventsLoading ? "Loading…" : "Load more"}
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
