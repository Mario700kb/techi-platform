import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, Loader2 } from "lucide-react";

import {
  ComponentLifecycle,
  DeviceComponentState,
  getDeviceComponentStates,
  getPlatformComponents,
  queueComponentAction,
  retryComponentAction,
} from "../api/platform";
import { cancelAction, getDeviceActions, type RemoteAction } from "../api/actions";
import { useDeviceRealtime } from "../hooks/useDeviceRealtime";
import ConfirmationModal from "./ConfirmationModal";
import { AgentUpdateLive } from "./AgentUpdateProgress";
import type { DeviceRealtimeEvent } from "../services/deviceRealtime";
import {
  isActiveUpdate,
  isAgentUpdate,
  latestAgentUpdate,
  mergeActionUpdate,
  pickAgentUpdate,
  updateTargetVersion,
} from "../utils/agentUpdate";

// Live execution phase of a component action, derived from the realtime action
// status (Operational M6). Pure + exported for direct unit testing.
export type ActionPhase = "pending" | "running" | "success" | "failed";

// Operations that interrupt the component on the device ask before queueing.
const CONFIRM_OPERATIONS = new Set(["reinstall", "repair", "restart", "update"]);

type PendingOperation = { componentId: string; componentName: string; operation: string; label: string };

// The TECHI Agent component; its "update" is the self_update action whose live
// progress replaces the card's buttons while it runs.
const AGENT_COMPONENT = "agent";
// How long "Updated to x" stays before the buttons come back.
const SUCCESS_HOLD_MS = 6000;
// Without the realtime socket no event arrives: re-read the device's actions at
// the app's socket-down cadence (AppDataContext polls the overview at 30 s).
const FALLBACK_REFRESH_MS = 30_000;

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
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {status}
    </span>
  );
}

export interface ComponentStatesPanelProps {
  deviceId: number;
  /** The device's action history as the drawer holds it (seeds an update already under way). */
  actions?: readonly RemoteAction[];
  /** Tell the holder of that history about a newer copy of an action (lossless, per event). */
  onActionChange?: (action: RemoteAction) => void;
  /** Whether the agent holds its live command channel open (null: unknown). */
  liveChannel?: boolean | null;
}

/** An action as the realtime event carries it, or null when it is not a full action. */
function actionFromEvent(data: DeviceRealtimeEvent["data"]): RemoteAction | null {
  if (!data || typeof data.id !== "number" || !data.action_type || !data.status) return null;
  return data as unknown as RemoteAction;
}

export default function ComponentStatesPanel({
  deviceId,
  actions,
  onActionChange,
  liveChannel = null,
}: ComponentStatesPanelProps) {
  const [states, setStates] = useState<DeviceComponentState[] | null>(null);
  const [lifecycles, setLifecycles] = useState<Record<string, ComponentLifecycle[]>>({});
  // Which (component, operation) is currently being queued, and the last error /
  // success feedback per component.
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, { error: boolean; text: string }>>({});
  // Live execution phase per component, driven by realtime action-status events —
  // no manual refresh needed (Operational M6).
  const [livePhase, setLivePhase] = useState<Record<string, ActionPhase>>({});

  // The agent update as this panel last saw it: from its own socket (every
  // event, in order), the queue/cancel/retry responses, and the fallback refresh.
  const [eventUpdate, setEventUpdate] = useState<RemoteAction | null>(null);
  const onActionChangeRef = useRef(onActionChange);
  useEffect(() => {
    onActionChangeRef.current = onActionChange;
  }, [onActionChange]);
  const noteUpdate = useCallback((action: RemoteAction) => {
    setEventUpdate((prev) => (prev && prev.id === action.id ? mergeActionUpdate(prev, action) : action));
    onActionChangeRef.current?.(action);
  }, []);
  const agentUpdate = useMemo(
    () => pickAgentUpdate(latestAgentUpdate(actions), eventUpdate?.device_id === deviceId ? eventUpdate : null),
    [actions, eventUpdate, deviceId],
  );

  // The version the finished update installs, until component-states reports
  // it; a device_updated that lands while a read is in flight is answered by
  // one more read only if that one still shows the old version.
  const awaitingVersion = useRef<string | null>(null);
  const statesInFlight = useRef(false);
  const recheckStates = useRef(false);
  const refreshStates = useCallback(() => {
    statesInFlight.current = true;
    const read = (): Promise<void> =>
      getDeviceComponentStates(deviceId)
        .then((resp): Promise<void> | void => {
          setStates(resp.components);
          const agent = resp.components.find((c) => c.component_id === AGENT_COMPONENT);
          if (agent && agent.installed_version === awaitingVersion.current) awaitingVersion.current = null;
          if (recheckStates.current && awaitingVersion.current) {
            recheckStates.current = false;
            awaitingVersion.current = null;
            return read();
          }
        })
        .catch(() => {
          /* keep prior states on a transient refresh failure */
        });
    void read().finally(() => {
      statesInFlight.current = false;
      recheckStates.current = false;
    });
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
      // The backend publishes device_updated once the new agent_version is
      // stored; if the completion refetch came too early, this one shows it.
      if (event.type === "device_updated") {
        if (event.data?.id === deviceId && awaitingVersion.current) {
          if (statesInFlight.current) {
            recheckStates.current = true;
          } else {
            awaitingVersion.current = null;
            refreshStates();
          }
        }
        return;
      }
      if (event.type !== "action_status_changed" && event.type !== "action_queued") return;
      const data = event.data;
      if (!data || data.device_id !== deviceId || !data.action_type) return;
      // The agent update is tracked whole (stage, progress) by the live block;
      // its completion refetch happens once, below.
      if (isAgentUpdate(data)) {
        const action = actionFromEvent(data);
        if (action) noteUpdate(action);
        return;
      }
      const componentId = actionToComponent[data.action_type];
      if (!componentId) return;
      const phase = phaseForStatus(data.status);
      if (!phase) return;
      setLivePhase((prev) => ({ ...prev, [componentId]: phase }));
      // On a terminal phase, the installed version may have changed — refetch.
      if (phase === "success" || phase === "failed") refreshStates();
    },
    [deviceId, actionToComponent, refreshStates, noteUpdate],
  );

  const realtimeStatus = useDeviceRealtime({ onEvent: onRealtimeEvent });
  const socketUp = realtimeStatus === "connected";
  const updateActive = isActiveUpdate(agentUpdate);

  // Socket down while an update runs: no event will say how it went, so read
  // the device's actions at the fallback cadence — and once more when the
  // socket comes back, for whatever happened while it was away.
  const refreshUpdateFromServer = useCallback(() => {
    getDeviceActions(deviceId, 10)
      .then((list) => {
        const latest = latestAgentUpdate(list);
        if (latest) noteUpdate(latest);
      })
      .catch(() => {
        /* the next tick or event tries again */
      });
  }, [deviceId, noteUpdate]);
  const socketWasDown = useRef(false);
  useEffect(() => {
    if (!updateActive) return;
    if (!socketUp) {
      socketWasDown.current = true;
      const timer = window.setInterval(() => {
        if (document.visibilityState === "visible") refreshUpdateFromServer();
      }, FALLBACK_REFRESH_MS);
      return () => window.clearInterval(timer);
    }
    if (socketWasDown.current) {
      socketWasDown.current = false;
      refreshUpdateFromServer();
    }
  }, [updateActive, socketUp, refreshUpdateFromServer]);

  // Which update this panel watched start, the installed version at that
  // moment, and the one the operator has put away (success shown, failure
  // dismissed). An update that had already ended before the panel opened is
  // history, not news: only a watched one shows its outcome here.
  const [watched, setWatched] = useState<{ id: number; from: string | null } | null>(null);
  const [dismissedId, setDismissedId] = useState<number | null>(null);
  const agentState = states?.find((s) => s.component_id === AGENT_COMPONENT) ?? null;
  if (updateActive && agentUpdate && watched?.id !== agentUpdate.id) {
    setWatched({ id: agentUpdate.id, from: agentState?.installed_version ?? null });
  }
  const watchedUpdate = agentUpdate && watched?.id === agentUpdate.id ? agentUpdate : null;
  const updateOutcome: "active" | "success" | "failed" | null = !watchedUpdate
    ? null
    : updateActive
      ? "active"
      : dismissedId === watchedUpdate.id
        ? null
        : watchedUpdate.status === "completed"
          ? "success"
          : watchedUpdate.status === "failed" || watchedUpdate.status === "expired"
            ? "failed"
            : null;
  const targetVersion = updateTargetVersion(agentUpdate) ?? agentState?.desired_version ?? null;

  // Finished: re-read the component states once, so Installed shows the new
  // version and the Outdated chip clears without a reload.
  const refreshedFor = useRef<number | null>(null);
  const finishedId = watchedUpdate && !updateActive ? watchedUpdate.id : null;
  const finishedStatus = finishedId !== null ? watchedUpdate?.status : null;
  useEffect(() => {
    if (finishedId === null || refreshedFor.current === finishedId) return;
    refreshedFor.current = finishedId;
    if (finishedStatus === "completed") awaitingVersion.current = targetVersion;
    refreshStates();
  }, [finishedId, finishedStatus, targetVersion, refreshStates]);

  // "Updated to x" holds a moment, then the buttons come back.
  const succeededId = updateOutcome === "success" && watchedUpdate ? watchedUpdate.id : null;
  useEffect(() => {
    if (succeededId === null) return;
    const timer = window.setTimeout(() => setDismissedId(succeededId), SUCCESS_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [succeededId]);

  const [updateBusy, setUpdateBusy] = useState<"cancel" | "retry" | null>(null);
  async function cancelUpdate(action: RemoteAction) {
    setUpdateBusy("cancel");
    try {
      const updated = await cancelAction(action.id);
      noteUpdate(updated);
      setFeedback((prev) => ({ ...prev, [AGENT_COMPONENT]: { error: false, text: "Update cancelled" } }));
    } catch (err) {
      const text = err instanceof Error ? err.message : "Cancel failed";
      setFeedback((prev) => ({ ...prev, [AGENT_COMPONENT]: { error: true, text } }));
    } finally {
      setUpdateBusy(null);
    }
  }
  async function retryUpdate(action: RemoteAction) {
    setUpdateBusy("retry");
    setFeedback((prev) => {
      const next = { ...prev };
      delete next[AGENT_COMPONENT];
      return next;
    });
    try {
      const accepted = await retryComponentAction(deviceId, action.id);
      noteUpdate({
        parameters: action.parameters,
        execution_timeout_seconds: action.execution_timeout_seconds,
        progress: null,
        stage: null,
        ...accepted.action,
      } as RemoteAction);
    } catch (err) {
      const text = err instanceof Error ? err.message : "Retry failed";
      setFeedback((prev) => ({ ...prev, [AGENT_COMPONENT]: { error: true, text } }));
    } finally {
      setUpdateBusy(null);
    }
  }

  useEffect(() => {
    let alive = true;
    getDeviceComponentStates(deviceId)
      .then((resp) => {
        if (alive) setStates(resp.components);
      })
      .catch(() => {
        if (alive) setStates([]);
      });
    getPlatformComponents()
      .then((resp) => {
        if (!alive) return;
        const map: Record<string, ComponentLifecycle[]> = {};
        for (const component of resp.components) map[component.id] = component.lifecycle;
        setLifecycles(map);
      })
      .catch(() => {
        /* lifecycle metadata is optional; versions still render */
      });
    return () => {
      alive = false;
    };
  }, [deviceId]);

  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);

  async function runOperation(componentId: string, operation: string, label: string) {
    if (busy) return;
    const key = `${componentId}:${operation}`;
    setBusy(key);
    setFeedback((prev) => ({ ...prev, [componentId]: { error: false, text: `${label}…` } }));
    try {
      const accepted = await queueComponentAction(deviceId, componentId, operation);
      const queued = accepted?.action;
      if (queued && isAgentUpdate(queued)) {
        // The live block takes it from here (queued → … → Updated).
        noteUpdate({ progress: null, stage: null, ...queued } as RemoteAction);
        setFeedback((prev) => {
          const next = { ...prev };
          delete next[componentId];
          return next;
        });
        return;
      }
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
    <>
      <section className="th-drawer-card">
        <div className="mb-2 flex items-center gap-2">
          <span
            className="flex h-5 w-5 items-center justify-center rounded-md"
            style={{ background: "var(--th-bg-shell)", color: "var(--th-text-muted)" }}
          >
            <Boxes className="h-3 w-3" />
          </span>
          <h3 className="premium-kicker">Components</h3>
        </div>

        <div className="space-y-2.5">
          {states.map((state) => {
            const operations = lifecycles[state.component_id] ?? [];
            const componentBusy = busy?.startsWith(`${state.component_id}:`) ?? false;
            const note = feedback[state.component_id];
            // The TECHI Agent card shows a running/just-finished update in
            // place of its buttons.
            const liveUpdate =
              state.component_id === AGENT_COMPONENT && updateOutcome && watchedUpdate ? watchedUpdate : null;
            return (
              <div
                key={state.component_id}
                data-component={state.component_id}
                className="rounded-lg border p-2.5"
                style={{ borderColor: "var(--th-border-subtle)" }}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                    {state.display_name}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {livePhase[state.component_id] && !liveUpdate && (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${PHASE_STYLES[livePhase[state.component_id]]}`}
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
                <div className="mt-1 grid grid-cols-2 gap-x-3 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
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
                {liveUpdate && updateOutcome ? (
                  <AgentUpdateLive
                    action={liveUpdate}
                    fromVersion={watched?.from ?? state.installed_version}
                    toVersion={targetVersion}
                    liveChannel={liveChannel}
                    outcome={updateOutcome}
                    onCancel={() => void cancelUpdate(liveUpdate)}
                    cancelling={updateBusy === "cancel"}
                    onRetry={() => void retryUpdate(liveUpdate)}
                    retrying={updateBusy === "retry"}
                    onDismiss={() => setDismissedId(liveUpdate.id)}
                  />
                ) : (
                  operations.length > 0 && (
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
                              className="rounded border px-1.5 py-0.5 text-[11px] font-medium opacity-60"
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
                            onClick={() =>
                              CONFIRM_OPERATIONS.has(entry.operation)
                                ? setPendingOperation({
                                    componentId: state.component_id,
                                    componentName: state.display_name,
                                    operation: entry.operation,
                                    label: entry.label,
                                  })
                                : runOperation(state.component_id, entry.operation, entry.label)
                            }
                            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-[var(--th-table-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                            style={{ borderColor: "var(--th-border-subtle)", color: "var(--th-text-primary)" }}
                          >
                            {isRunning && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                            {entry.label}
                          </button>
                        );
                      })}
                    </div>
                  )
                )}
                {note && (
                  <div
                    className="mt-1.5 text-[11px]"
                    style={{ color: note.error ? "var(--th-status-critical)" : "var(--th-text-muted)" }}
                  >
                    {note.text}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
      {pendingOperation && (
        <ConfirmationModal
          title={`${pendingOperation.label} ${pendingOperation.componentName}?`}
          confirmLabel={pendingOperation.label}
          destructive={pendingOperation.operation !== "update"}
          onClose={() => setPendingOperation(null)}
          onConfirm={() => {
            const { componentId, operation, label } = pendingOperation;
            setPendingOperation(null);
            void runOperation(componentId, operation, label);
          }}
        >
          {pendingOperation.componentName} will be interrupted on this device while the{" "}
          {pendingOperation.label.toLowerCase()} runs.
        </ConfirmationModal>
      )}
    </>
  );
}
