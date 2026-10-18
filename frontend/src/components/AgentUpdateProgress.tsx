import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Clock,
  Download,
  Loader2,
  Package,
  RefreshCw,
  RotateCw,
  Send,
  ShieldCheck,
} from "lucide-react";

import type { RemoteAction } from "../api/actions";
import {
  AGENT_UPDATE_STEPS,
  downloadDetail,
  formatElapsed,
  updatePercent,
  updateStageText,
  updateStartedAt,
  updateStep,
} from "../utils/agentUpdate";

// The live progress of a TECHI Agent self-update: the full block that takes
// the place of the TECHI Agent card's buttons while the update runs, and the
// compact line in the Maintenance action history. Everything shown comes
// from the action (status / stage / progress / result_message), which the
// realtime events keep current.

type Tone = "active" | "success" | "failed";

/** Seconds since `startMs`, ticking once a second while `running`. */
function useElapsed(startMs: number | null, running: boolean, endMs: number | null = null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (startMs === null) return null;
  return Math.max(0, ((endMs ?? now) - startMs) / 1000);
}

function StageIcon({ action }: { action: RemoteAction }) {
  const cls = "h-3.5 w-3.5 flex-none";
  if (action.status === "queued") return <Clock className={cls} aria-hidden />;
  if (action.status === "sent" || action.status === "acknowledged") return <Send className={cls} aria-hidden />;
  switch (action.stage) {
    case "downloading":
      return <Download className={cls} aria-hidden />;
    case "verifying":
      return <ShieldCheck className={cls} aria-hidden />;
    case "installing":
      return <Package className={cls} aria-hidden />;
    case "restarting":
      return <RotateCw className={cls} aria-hidden />;
    case "confirming":
      return <BadgeCheck className={cls} aria-hidden />;
    default:
      return <Loader2 className={`${cls} animate-spin`} aria-hidden />;
  }
}

/** Slim bar: determinate with a width when `percent` is known, else an indeterminate sweep. */
export function UpdateBar({
  percent,
  tone = "active",
  label,
  size = "md",
}: {
  percent: number | null;
  tone?: Tone;
  label: string;
  size?: "sm" | "md";
}) {
  const determinate = percent !== null;
  return (
    <div
      className="th-upd-bar"
      data-size={size}
      data-tone={tone}
      data-indeterminate={determinate ? undefined : "true"}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? percent : undefined}
      aria-valuetext={label}
    >
      <span className="th-upd-fill" style={determinate ? { width: `${percent}%` } : undefined} />
    </div>
  );
}

function VersionArrow({ from, to }: { from: string | null; to: string | null }) {
  if (!to) return null;
  return (
    <span className="th-upd-version" title={from ? `${from} → ${to}` : `Target ${to}`}>
      {from && from !== to && <span className="th-upd-version-from">{from}</span>}
      <span aria-hidden>→</span>
      <span className="sr-only">to</span>
      <span className="th-upd-version-to">{to}</span>
    </span>
  );
}

export interface AgentUpdateLiveProps {
  action: RemoteAction;
  /** The installed version when the update started. */
  fromVersion: string | null;
  /** The version the update installs. */
  toVersion: string | null;
  /** Whether the agent holds its live channel open (null: unknown). */
  liveChannel?: boolean | null;
  outcome: Tone;
  onCancel?: () => void;
  cancelling?: boolean;
  onRetry?: () => void;
  retrying?: boolean;
  onDismiss?: () => void;
}

/** The TECHI Agent card's live update block. */
export function AgentUpdateLive({
  action,
  fromVersion,
  toVersion,
  liveChannel = null,
  outcome,
  onCancel,
  cancelling = false,
  onRetry,
  retrying = false,
  onDismiss,
}: AgentUpdateLiveProps) {
  const startMs = updateStartedAt(action);
  const endAt = Date.parse(action.completed_at ?? action.failed_at ?? action.expired_at ?? "");
  const elapsed = useElapsed(
    startMs,
    outcome === "active",
    outcome === "active" || !Number.isFinite(endAt) ? null : endAt,
  );

  if (outcome === "success") {
    const took = action.duration_seconds ?? elapsed;
    return (
      <div className="th-upd" data-tone="success" data-testid="agent-update-live">
        <div className="th-upd-head">
          <span className="th-upd-stage" role="status">
            <CheckCircle2 className="h-4 w-4 flex-none" aria-hidden />
            {toVersion ? `Updated to ${toVersion}` : "Updated"}
          </span>
          {took != null && <span className="th-upd-meta">took {formatElapsed(took)}</span>}
        </div>
        <UpdateBar percent={100} tone="success" label={toVersion ? `Updated to ${toVersion}` : "Updated"} />
      </div>
    );
  }

  if (outcome === "failed") {
    const reason =
      action.error_message?.trim() ||
      action.result_message?.trim() ||
      (action.status === "expired" ? "The agent did not pick the update up in time." : "The agent reported no reason.");
    return (
      <div className="th-upd" data-tone="failed" data-testid="agent-update-live">
        <div className="th-upd-head">
          <span className="th-upd-stage" role="alert">
            <AlertTriangle className="h-4 w-4 flex-none" aria-hidden />
            {updateStageText(action)}
          </span>
          <VersionArrow from={fromVersion} to={toVersion} />
        </div>
        <p className="th-upd-reason">{reason}</p>
        <div className="th-upd-foot">
          <span className="th-upd-meta">{elapsed != null ? `after ${formatElapsed(elapsed)}` : ""}</span>
          <span className="th-upd-actions">
            {onDismiss && (
              <button type="button" className="th-link-btn" onClick={onDismiss}>
                Dismiss
              </button>
            )}
            {onRetry && (
              <button
                type="button"
                className="th-upd-btn"
                data-tone="failed"
                onClick={onRetry}
                disabled={retrying}
                aria-busy={retrying}
              >
                {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Retry update
              </button>
            )}
          </span>
        </div>
      </div>
    );
  }

  const percent = updatePercent(action);
  const stageText = updateStageText(action, liveChannel);
  const detail = action.stage === "downloading" ? downloadDetail(action.result_message) : null;
  const step = updateStep(action);
  const queued = action.status === "queued";
  return (
    <div className="th-upd" data-tone="active" data-testid="agent-update-live">
      <div className="th-upd-head">
        <span className="th-upd-stage" role="status" aria-live="polite">
          <StageIcon action={action} />
          <span className="truncate">
            {stageText}
            {detail && <span className="th-upd-detail"> ({detail})</span>}
          </span>
        </span>
        <VersionArrow from={fromVersion} to={toVersion} />
      </div>
      <UpdateBar percent={percent} label={stageText} />
      <div className="th-upd-foot">
        <span className="th-upd-meta">{elapsed != null ? `Elapsed ${formatElapsed(elapsed)}` : ""}</span>
        {queued && onCancel ? (
          <button type="button" className="th-upd-btn" onClick={onCancel} disabled={cancelling} aria-busy={cancelling}>
            {cancelling && <Loader2 className="h-3 w-3 animate-spin" />}
            Cancel
          </button>
        ) : (
          <span className="th-upd-meta">
            {step
              ? `Step ${step} of ${AGENT_UPDATE_STEPS}`
              : action.status === "running"
                ? "In progress"
                : "Waiting for the agent"}
          </span>
        )}
      </div>
    </div>
  );
}

/** The same progress, one line and a hairline bar, for the action history row. */
export function AgentUpdateCompact({ action, toVersion }: { action: RemoteAction; toVersion: string | null }) {
  const percent = updatePercent(action);
  const stageText = updateStageText(action);
  const detail = action.stage === "downloading" ? downloadDetail(action.result_message) : null;
  return (
    <div className="th-upd-compact" data-testid="agent-update-compact">
      <div className="th-upd-compact-line">
        <span className="truncate">
          {stageText}
          {detail && <span className="th-upd-detail"> · {detail}</span>}
        </span>
        {toVersion && <span className="th-upd-version-to">→ {toVersion}</span>}
      </div>
      <UpdateBar percent={percent} label={stageText} size="sm" />
    </div>
  );
}
