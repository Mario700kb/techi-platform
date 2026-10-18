import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, Radio } from "lucide-react";

import { previewBulkSelfUpdate, type SelfUpdatePreview } from "../api/agentCommands";
import { formatCount } from "../utils/number";

// The plan behind "Update agent" in the Devices bulk bar: which selected
// devices update to which version, which start at once over the live channel,
// and which are left out and why — read from the backend before anything is
// queued, so the confirmation says exactly what will happen.

export function useSelfUpdatePreview(deviceIds: number[] | null) {
  const [state, setState] = useState<{ data: SelfUpdatePreview | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: false,
  });
  const key = deviceIds ? deviceIds.join(",") : null;
  useEffect(() => {
    if (!key) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let live = true;
    setState({ data: null, error: null, loading: true });
    previewBulkSelfUpdate(key.split(",").map(Number))
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch(
        (err) =>
          live &&
          setState({
            data: null,
            error: err instanceof Error ? err.message : "Could not check the selected devices",
            loading: false,
          }),
      );
    return () => {
      live = false;
    };
  }, [key]);
  return state;
}

const MAX_NAMES = 6;

function names(list: string[]): string {
  const shown = list.slice(0, MAX_NAMES).join(", ");
  return list.length > MAX_NAMES ? `${shown} +${formatCount(list.length - MAX_NAMES)} more` : shown;
}

export default function BulkAgentUpdatePlan({
  preview,
  loading,
  error,
}: {
  preview: SelfUpdatePreview | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading)
    return (
      <p className="text-[13px]" style={{ color: "var(--th-text-muted)" }} aria-busy="true">
        Checking the selected devices…
      </p>
    );
  if (error)
    return (
      <p className="flex items-center gap-2 text-[13px]" role="alert" style={{ color: "var(--th-status-critical)" }}>
        <AlertTriangle className="h-4 w-4 flex-none" /> {error}
      </p>
    );
  if (!preview) return null;

  const live = preview.update.filter((u) => u.live).length;
  const later = preview.update.length - live;
  const fromVersions = new Map<string, string[]>();
  for (const u of preview.update) {
    const from = u.from_version ?? "unknown";
    fromVersions.set(from, [...(fromVersions.get(from) ?? []), u.name]);
  }
  const reasons = new Map<string, string[]>();
  for (const s of preview.skipped) reasons.set(s.reason, [...(reasons.get(s.reason) ?? []), s.name]);

  return (
    <div className="space-y-3 text-[13px]" data-testid="bulk-update-plan">
      {preview.update.length === 0 ? (
        <p style={{ color: "var(--th-text-secondary)" }}>Nothing to update in this selection.</p>
      ) : (
        <>
          <p style={{ color: "var(--th-text-secondary)" }}>
            Each agent downloads{" "}
            <strong style={{ color: "var(--th-text-primary)" }}>{preview.version ?? "the active version"}</strong>,
            checks it and restarts its service — about a minute, with no effect on the signed-in user. Progress shows on
            each device's TECHI Agent card.
          </p>
          <ul className="space-y-1.5" aria-label="Devices to update">
            {[...fromVersions.entries()].map(([from, list]) => (
              <li key={from} className="flex items-start gap-2">
                <span
                  className="inline-flex flex-none items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[12px] tabular-nums"
                  style={{ background: "var(--th-chip-bg)", color: "var(--th-text-secondary)" }}
                >
                  {from} <ArrowRight className="h-3 w-3" aria-hidden="true" /> {preview.version ?? list[0]}
                </span>
                <span className="min-w-0" style={{ color: "var(--th-text-muted)" }}>
                  <strong style={{ color: "var(--th-text-primary)" }}>{formatCount(list.length)}</strong> ·{" "}
                  {names(list)}
                </span>
              </li>
            ))}
          </ul>
          <p className="flex items-center gap-2" style={{ color: "var(--th-text-muted)" }}>
            <Radio className="h-3.5 w-3.5 flex-none" style={{ color: "var(--th-status-online)" }} aria-hidden="true" />
            {formatCount(live)} start at once over the live channel
            {later ? ` · ${formatCount(later)} at their next heartbeat (offline ones only if back within 15 min)` : ""}
          </p>
        </>
      )}
      {reasons.size > 0 && (
        <div className="th-drawer-callout" style={{ "--tone": "var(--th-status-info)" } as React.CSSProperties}>
          <p className="mb-1 font-medium">{formatCount(preview.skipped.length)} left out</p>
          <ul className="space-y-0.5" aria-label="Devices left out">
            {[...reasons.entries()].map(([reason, list]) => (
              <li key={reason}>
                {reason} · {names(list)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
