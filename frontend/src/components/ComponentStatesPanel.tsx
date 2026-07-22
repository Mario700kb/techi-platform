import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, Loader2 } from "lucide-react";

import {
  ComponentLifecycle,
  DeviceComponentState,
  getDeviceComponentStates,
  getPlatformComponents,
  queueComponentAction,
} from "../api/platform";
import { useDeviceRealtime } from "../hooks/useDeviceRealtime";
import type { DeviceRealtimeEvent } from "../services/deviceRealtime";

// Live execution phase of a component action, derived from the realtime action
// status (Operational M6). Pure + exported for direct unit testing.
export type ActionPhase = "pending" | "running" | "success" | "failed";

export function phaseForStatus(status?: string | null): ActionPhase | null {
  switch (status) {
    case "queued":
    case "sent":
    case "acknowledged":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "success";
    case "failed":
    case "expired":
    case "cancelled":
      return "failed";
    default:
      return null;
  }
}

const PHASE_LABEL: Record<ActionPhase, string> = {
  pending: "Pending",
  running: "Running",
  success: "Success",
  failed: "Failed",
};

const PHASE_STYLES: Record<ActionPhase, string> = {
  pending: "border-sky-400/25 bg-sky-400/10 text-sky-300",
  running: "border-indigo-400/25 bg-indigo-400/10 text-indigo-300",
  success: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  failed: "border-red-400/25 bg-red-400/10 text-red-300",
};

// Platform Components panel for the Device Drawer. It reports, per managed
// component, the Installed and Desired versions, the derived Health Status, and
// the lifecycle operations the component supports. Operations whose kind is
// "action" are triggerable buttons (Operational M5) — they queue through the
// EXISTING device-action pipeline via POST /components/{id}/actions, show a
// loading spinner, disable while any op on that component is running, and
// surface a structured error. Out-of-band operations (GPO install, heartbeat
// discover) render as static labels — they are not triggerable. Data comes from
// the Platform Components endpoints (GET /devices/{id}/component-states and GET
// /platform/components); the panel renders nothing when either is unavailable or
// the device has no managed components (e.g. connectors).

const STATUS_STYLES: Record<string, string> = {
  current: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  outdated: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  missing: "border-red-400/25 bg-red-400/10 text-red-300",
  unknown: "border-slate-400/20 bg-slate-400/10 text-slate-300",
};

function StatusBadge({ health, status }: { health: string; status: string }) {
  const cls = STATUS_STYLES[health] ?? STATUS_STYLES.unknown;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
      {status}
    </span>
  );
}

export default function ComponentStatesPanel({ deviceId }: { deviceId: number }) {
  const [states, setStates] = useState<DeviceComponentState[] | null>(null);
  const [lifecycles, setLifecycles] = useState<Record<string, ComponentLifecycle[]>>({});
  // Which (component, operation) is currently being queued, and the last error /
  // success feedback per component.
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, { error: boolean; text: string }>>({});
  // Live execution phase per component, driven by realtime action-status events —
  // no manual refresh needed (Operational M6).
  const [livePhase, setLivePhase] = useState<Record<string, ActionPhase>>({});

  const refreshStates = useCallback(() => {
    getDeviceComponentStates(deviceId)
      .then((resp) => setStates(resp.components))
      .catch(() => { /* keep prior states on a transient refresh failure */ });
  }, [deviceId]);

  // action_type → component_id, from the fetched lifecycle metadata. Lets a
  // realtime RemoteAction event be attributed to the component it belongs to
  // (client-side mirror of the backend reverse index).
  const actionToComponent = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [componentId, entries] of Object.entries(lifecycles)) {
      for (const entry of entries) {
        if (entry.action_type) map[entry.action_type] = componentId;
      }
    }
    return map;
  }, [lifecycles]);

  const onRealtimeEvent = useCallback(
    (event: DeviceRealtimeEvent) => {
      if (event.type !== "action_status_changed" && event.type !== "action_queued") return;
      const data = event.data;
      if (!data || data.device_id !== deviceId || !data.action_type) return;
      const componentId = actionToComponent[data.action_type];
      if (!componentId) return;
      const phase = phaseForStatus(data.status);
      if (!phase) return;
      setLivePhase((prev) => ({ ...prev, [componentId]: phase }));
      // On a terminal phase, the installed version may have changed — refetch.
      if (phase === "success" || phase === "failed") refreshStates();
    },
    [deviceId, actionToComponent, refreshStates],
  );

  useDeviceRealtime({ onEvent: onRealtimeEvent });

  useEffect(() => {
    let alive = true;
    getDeviceComponentStates(deviceId)
      .then((resp) => { if (alive) setStates(resp.components); })
      .catch(() => { if (alive) setStates([]); });
    getPlatformComponents()
      .then((resp) => {
        if (!alive) return;
        const map: Record<string, ComponentLifecycle[]> = {};
        for (const component of resp.components) map[component.id] = component.lifecycle;
        setLifecycles(map);
      })
      .catch(() => { /* lifecycle metadata is optional; versions still render */ });
    return () => { alive = false; };
  }, [deviceId]);

  async function runOperation(componentId: string, operation: string, label: string) {
    if (busy) return;
    const key = `${componentId}:${operation}`;
    setBusy(key);
    setFeedback((prev) => ({ ...prev, [componentId]: { error: false, text: `${label}…` } }));
    try {
      await queueComponentAction(deviceId, componentId, operation);
      setFeedback((prev) => ({ ...prev, [componentId]: { error: false, text: `${label} queued` } }));
      refreshStates();
    } catch (err) {
      const text = err instanceof Error ? err.message : `${label} failed`;
      setFeedback((prev) => ({ ...prev, [componentId]: { error: true, text } }));
    } finally {
      setBusy(null);
    }
  }

  // Loading or nothing to show (connector / endpoint unavailable) → render nothing.
  if (states === null || states.length === 0) return null;

  return (
    <section
      className="rounded-xl border p-3"
      style={{ borderColor: "var(--th-border-card)", background: "var(--th-bg-input, transparent)" }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className="flex h-5 w-5 items-center justify-center rounded-md"
          style={{ background: "var(--th-bg-shell)", color: "var(--th-text-muted)" }}
        >
          <Boxes className="h-3 w-3" />
        </span>
        <h3 className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--th-text-muted)" }}>
          Components
        </h3>
      </div>

      <div className="space-y-2.5">
        {states.map((state) => {
          const operations = lifecycles[state.component_id] ?? [];
          const componentBusy = busy?.startsWith(`${state.component_id}:`) ?? false;
          const note = feedback[state.component_id];
          return (
            <div
              key={state.component_id}
              className="rounded-lg border p-2.5"
              style={{ borderColor: "var(--th-border-subtle)" }}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12.5px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                  {state.display_name}
                </span>
                <div className="flex items-center gap-1.5">
                  {livePhase[state.component_id] && (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${PHASE_STYLES[livePhase[state.component_id]]}`}
                    >
                      {livePhase[state.component_id] === "running" && (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      )}
                      {PHASE_LABEL[livePhase[state.component_id]]}
                    </span>
                  )}
                  <StatusBadge health={state.health} status={state.status} />
                </div>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-3 text-[11.5px]" style={{ color: "var(--th-text-muted)" }}>
                <span>
                  Installed:{" "}
                  <span className="font-mono" style={{ color: "var(--th-text-primary)" }}>
                    {state.installed_version ?? "—"}
                  </span>
                </span>
                <span>
                  Desired:{" "}
                  <span className="font-mono" style={{ color: "var(--th-text-primary)" }}>
                    {state.desired_version ?? "—"}
                  </span>
                </span>
              </div>
              {operations.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {operations.map((entry) => {
                    const key = `${state.component_id}:${entry.operation}`;
                    const isRunning = busy === key;
                    // Out-of-band operations (GPO install, heartbeat discover)
                    // are not triggerable — render them as static labels.
                    if (entry.kind !== "action") {
                      return (
                        <span
                          key={entry.operation}
                          title="Handled out of band (not triggerable)"
                          className="rounded border px-1.5 py-0.5 text-[10px] font-medium opacity-60"
                          style={{ borderColor: "var(--th-border-subtle)", color: "var(--th-text-muted)" }}
                        >
                          {entry.label}
                        </span>
                      );
                    }
                    return (
                      <button
                        key={entry.operation}
                        type="button"
                        disabled={componentBusy}
                        onClick={() => runOperation(state.component_id, entry.operation, entry.label)}
                        className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ borderColor: "var(--th-border-subtle)", color: "var(--th-text-primary)" }}
                      >
                        {isRunning && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                        {entry.label}
                      </button>
                    );
                  })}
                </div>
              )}
              {note && (
                <div
                  className="mt-1.5 text-[10.5px]"
                  style={{ color: note.error ? "var(--th-danger, #f87171)" : "var(--th-text-muted)" }}
                >
                  {note.text}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
