import { useCallback, useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

import { ApiError } from "../api/client";
import type { RemoteAction } from "../api/actions";
import { controlService, killProcess, uninstallSoftware, type ServiceOperation } from "../api/deviceManage";
import ConfirmationModal from "./ConfirmationModal";

const TERMINAL = new Set(["completed", "failed", "expired", "cancelled"]);
/** A finished row keeps its note this long, then reads from the inventory again. */
const OUTCOME_SHOWN_MS = 20_000;
/** The agent sends a fresh inventory right after it acts; fetch it a moment later. */
const RELOAD_AFTER_MS = 4_000;

/** What the inventory lists may do on this device (given by the drawer). */
export interface InventoryManage {
  deviceId: number;
  deviceName: string;
  /** Why nothing can be done on this device now (offline, older agent); null when it can. */
  blockedReason: string | null;
  /** End processes, start/stop/restart services. */
  canOperate: boolean;
  /** Uninstall apps (administrators, with a two-factor code). */
  canUninstall: boolean;
  /** The device's actions, kept live by the drawer. */
  actions: RemoteAction[];
  onQueued: (action: RemoteAction) => void;
}

export type ManageRequest =
  | { kind: "kill"; pid: number; name: string }
  | { kind: "service"; name: string; label: string; operation: ServiceOperation }
  | { kind: "uninstall"; name: string; uninstallKey: string; method: "msi" | "quiet" };

export interface RowOutcome {
  state: "running" | "done" | "failed";
  message: string;
  request: ManageRequest;
}

export function requestKey(request: ManageRequest): string {
  if (request.kind === "kill") return `process:${request.pid}`;
  if (request.kind === "service") return `service:${request.name.toLowerCase()}`;
  return `software:${request.uninstallKey}`;
}

export function runningLabel(request: ManageRequest): string {
  if (request.kind === "kill") return "Ending…";
  if (request.kind === "uninstall") return "Uninstalling…";
  return { start: "Starting…", stop: "Stopping…", restart: "Restarting…" }[request.operation];
}

/**
 * The actions this list queued, and what became of each row: running until
 * the device reports, then done or failed with the agent's own words. The
 * inventory is fetched again once a row settles.
 */
export function useManageOutcomes(actions: RemoteAction[] | undefined, onSettled: () => void) {
  const [queued, setQueued] = useState<Record<string, { actionId: number; request: ManageRequest }>>({});
  const [outcomes, setOutcomes] = useState<Record<string, RowOutcome>>({});
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  useEffect(() => {
    if (!actions) return;
    const settled: Record<string, RowOutcome> = {};
    for (const [key, { actionId, request }] of Object.entries(queued)) {
      const action = actions.find((a) => a.id === actionId);
      if (!action || !TERMINAL.has(action.status)) continue;
      const ok = action.status === "completed";
      settled[key] = {
        state: ok ? "done" : "failed",
        request,
        message: ok
          ? action.result_message || "Done"
          : action.error_message ||
            (action.status === "expired" ? "The device did not take it in time" : `The action was ${action.status}`),
      };
    }
    const keys = Object.keys(settled);
    if (keys.length === 0) return;
    setQueued((prev) => {
      const next = { ...prev };
      keys.forEach((k) => delete next[k]);
      return next;
    });
    setOutcomes((prev) => ({ ...prev, ...settled }));
    timers.current.push(window.setTimeout(() => settledRef.current(), RELOAD_AFTER_MS));
    timers.current.push(
      window.setTimeout(
        () =>
          setOutcomes((prev) => {
            const next = { ...prev };
            keys.forEach((k) => {
              if (next[k]?.state === "done") delete next[k];
            });
            return next;
          }),
        OUTCOME_SHOWN_MS,
      ),
    );
  }, [actions, queued]);

  const track = useCallback((request: ManageRequest, action: RemoteAction) => {
    const key = requestKey(request);
    setQueued((prev) => ({ ...prev, [key]: { actionId: action.id, request } }));
    setOutcomes((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const outcomeFor = useCallback(
    (key: string): RowOutcome | undefined =>
      queued[key] ? { state: "running", message: runningLabel(queued[key].request), request: queued[key].request } : outcomes[key],
    [queued, outcomes],
  );

  return { track, outcomeFor };
}

/** One icon button in a row; unavailable ones stay focusable so their reason can be read. */
export function RowActionButton({
  icon: Icon,
  label,
  blockedReason,
  danger = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  blockedReason?: string | null;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="th-icon-btn th-icon-btn-ghost th-inv-act"
      data-danger={danger || undefined}
      aria-disabled={blockedReason ? true : undefined}
      aria-label={blockedReason ? `${label}: ${blockedReason}` : label}
      title={blockedReason ?? label}
      onClick={() => {
        if (!blockedReason) onClick();
      }}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function describe(request: ManageRequest) {
  switch (request.kind) {
    case "kill":
      return {
        title: "End process",
        confirm: "End process",
        destructive: true,
        subject: `${request.name} · PID ${request.pid}`,
        body: "The process closes at once, without saving. Unsaved work in it is lost.",
      };
    case "service":
      if (request.operation === "start") {
        return {
          title: "Start service",
          confirm: "Start",
          destructive: false,
          subject: request.label,
          body: "The service starts now. Its startup type stays as it is.",
        };
      }
      return request.operation === "stop"
        ? {
            title: "Stop service",
            confirm: "Stop",
            destructive: true,
            subject: request.label,
            body: "Programs that use it stop working until it is started again. Services that depend on it must be stopped first.",
          }
        : {
            title: "Restart service",
            confirm: "Restart",
            destructive: true,
            subject: request.label,
            body: "The service stops and starts again; programs using it may lose their connection for a moment.",
          };
    case "uninstall":
      return {
        title: "Uninstall app",
        confirm: "Uninstall",
        destructive: true,
        subject: request.name,
        body:
          request.method === "msi"
            ? "Removed silently with Windows Installer. This cannot be undone from here; a restart may be needed to finish."
            : "Removed with the app's own silent uninstaller. This cannot be undone from here.",
      };
  }
}

function manageErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === "mfa_not_enabled") {
    return "Two-factor is off for your account. Turn it on in Settings → Security, then try again.";
  }
  if (err instanceof ApiError && err.code === "mfa_invalid") {
    return "Wrong or expired code. Enter the current code from your app.";
  }
  return err instanceof Error && err.message ? err.message : "The platform refused it.";
}

/** Asks before acting; an uninstall also asks for a current two-factor code. */
export function ManageDialog({
  request,
  manage,
  onClose,
  onQueued,
}: {
  request: ManageRequest;
  manage: InventoryManage;
  onClose: () => void;
  onQueued: (request: ManageRequest, action: RemoteAction) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsCode = request.kind === "uninstall";
  const text = describe(request);

  const submit = async () => {
    if (busy || (needsCode && code.length !== 6)) return;
    setBusy(true);
    setError(null);
    try {
      const action =
        request.kind === "kill"
          ? await killProcess(manage.deviceId, request.pid, request.name)
          : request.kind === "service"
            ? await controlService(manage.deviceId, request.name, request.operation)
            : await uninstallSoftware(manage.deviceId, request.name, request.uninstallKey, code);
      onQueued(request, action);
    } catch (err) {
      setError(manageErrorMessage(err));
      setCode("");
      setBusy(false);
    }
  };

  return (
    <ConfirmationModal
      title={text.title}
      confirmLabel={text.confirm}
      destructive={text.destructive}
      loading={busy}
      confirmDisabled={needsCode && code.length !== 6}
      onClose={onClose}
      onConfirm={() => void submit()}
    >
      <p className="font-medium" style={{ color: "var(--th-text-primary)" }}>
        {text.subject}
      </p>
      <p className="mt-0.5 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
        on {manage.deviceName}
      </p>
      <p className="mt-3">{text.body}</p>
      {needsCode && (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block">
            <span className="premium-kicker mb-1.5 block">Two-factor code</span>
            <input
              className="th-input h-11 w-full rounded-lg border px-3 text-center font-mono text-[20px] tracking-[0.5em]"
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Two-factor code"
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
            />
          </label>
          <button type="submit" hidden />
        </form>
      )}
      {error && (
        <p role="alert" className="th-drawer-callout mt-3 text-[13px]" data-tone="critical">
          {error}
        </p>
      )}
    </ConfirmationModal>
  );
}
