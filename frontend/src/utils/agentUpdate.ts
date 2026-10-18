import type { ActionStage, RemoteAction } from "../api/actions";

// Live progress of a TECHI Agent self-update (action_type "self_update").
//
// The backend reports it on the action itself: `progress` is the overall
// 0–100 and `stage` the step — downloading 5→80, verifying 85, installing 90,
// restarting 95, confirming 97, completed 100. Both are null while the action
// is only queued/sent, and again once it has finished. Agents up to 2.1.31
// report no download percentage: only the server-side stages appear
// (restarting when their live channel drops, confirming when it is back), so
// the bar stays indeterminate until a number arrives.

export const AGENT_UPDATE_ACTION = "self_update";

const STAGE_ORDER: Record<ActionStage, number> = {
  downloading: 1,
  verifying: 2,
  installing: 3,
  restarting: 4,
  confirming: 5,
};
export const AGENT_UPDATE_STEPS = 5;

const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  acknowledged: 2,
  running: 3,
  completed: 4,
  failed: 4,
  expired: 4,
  cancelled: 4,
};

const ACTIVE = new Set(["queued", "sent", "acknowledged", "running"]);

export function isAgentUpdate(action: { action_type?: string | null } | null | undefined): boolean {
  return action?.action_type === AGENT_UPDATE_ACTION;
}

function knownStage(stage: unknown): ActionStage | null {
  return typeof stage === "string" && Object.prototype.hasOwnProperty.call(STAGE_ORDER, stage)
    ? (stage as ActionStage)
    : null;
}

/** The overall percentage, clamped and rounded; null when the bar must be indeterminate. */
export function updatePercent(action: Pick<RemoteAction, "progress" | "status">): number | null {
  if (action.status === "completed") return 100;
  if (typeof action.progress !== "number" || !Number.isFinite(action.progress)) return null;
  return Math.round(Math.min(100, Math.max(0, action.progress)));
}

/** "2.6 of 6.3 MB" from a result_message like "Downloading (2.6 of 6.3 MB)". */
export function downloadDetail(message: string | null | undefined): string | null {
  if (!message) return null;
  const match = /(\d+(?:\.\d+)?\s*of\s*\d+(?:\.\d+)?\s*[KMGT]i?B)/i.exec(message);
  return match ? match[1].replace(/\s+/g, " ") : null;
}

/**
 * The stage in plain words. `liveChannel` false means the agent is not holding
 * its live channel open, so a queued update waits for the next heartbeat.
 */
export function updateStageText(
  action: Pick<RemoteAction, "status" | "stage" | "progress">,
  liveChannel: boolean | null = null,
): string {
  switch (action.status) {
    case "queued":
      return liveChannel === false
        ? "Queued — goes out at the next heartbeat"
        : "Queued — goes out at once over the live channel";
    case "sent":
    case "acknowledged":
      return "Sent to the agent";
    case "completed":
      return "Updated";
    case "failed":
      return "Update failed";
    case "expired":
      return "Update expired";
    case "cancelled":
      return "Update cancelled";
  }
  switch (knownStage(action.stage)) {
    case "downloading": {
      const percent = updatePercent(action);
      return percent === null ? "Downloading" : `Downloading ${percent}%`;
    }
    case "verifying":
      return "Verifying the package";
    case "installing":
      return "Installing";
    case "restarting":
      return "Restarting the agent";
    case "confirming":
      return "Confirming the new version";
    default:
      return "Starting the update";
  }
}

/** Which of the five steps is under way (1-based), or null before the first one. */
export function updateStep(action: Pick<RemoteAction, "status" | "stage">): number | null {
  if (action.status !== "running") return null;
  const stage = knownStage(action.stage);
  return stage ? STAGE_ORDER[stage] : null;
}

/** The version the update installs, from the queued payload. */
export function updateTargetVersion(action: Pick<RemoteAction, "parameters"> | null | undefined): string | null {
  const version = action?.parameters?.version;
  return typeof version === "string" && version.trim() ? version.trim() : null;
}

/** How far an action has got, for ordering two copies of the same action. */
function advance(action: RemoteAction): number {
  const status = STATUS_RANK[action.status] ?? 0;
  const stage = knownStage(action.stage);
  const progress = typeof action.progress === "number" ? Math.min(100, Math.max(0, action.progress)) : -1;
  // status ≫ stage ≫ progress: a later stage outranks any percentage.
  return status * 100_000 + (stage ? STAGE_ORDER[stage] : 0) * 1_000 + (progress + 1);
}

/**
 * Merge an incoming copy of an action into the one already shown, never
 * moving it backwards. The same event reaches the page over more than one
 * socket and from the fallback refresh; whichever copy lands last must not
 * undo a newer one (60% must not drop back to 20%).
 */
export function mergeActionUpdate(existing: RemoteAction, incoming: RemoteAction): RemoteAction {
  if (existing.id !== incoming.id) return incoming;
  if (advance(incoming) < advance(existing)) return existing;
  return { ...existing, ...incoming };
}

/** Put an action into a list: prepend it when new, else merge it forward. */
export function upsertAction(list: RemoteAction[], incoming: RemoteAction): RemoteAction[] {
  const index = list.findIndex((a) => a.id === incoming.id);
  if (index === -1) return [incoming, ...list];
  const merged = mergeActionUpdate(list[index], incoming);
  if (merged === list[index]) return list;
  const next = [...list];
  next[index] = merged;
  return next;
}

/** The newer of two copies of "the latest agent update": a newer id wins, the same id merges forward. */
export function pickAgentUpdate(a: RemoteAction | null, b: RemoteAction | null): RemoteAction | null {
  if (!a) return b;
  if (!b) return a;
  if (a.id !== b.id) return a.id > b.id ? a : b;
  return mergeActionUpdate(a, b);
}

/** The most recent agent update in an action list (newest id). */
export function latestAgentUpdate(actions: readonly RemoteAction[] | null | undefined): RemoteAction | null {
  let latest: RemoteAction | null = null;
  for (const action of actions ?? []) {
    if (isAgentUpdate(action) && (!latest || action.id > latest.id)) latest = action;
  }
  return latest;
}

export function isActiveUpdate(action: RemoteAction | null | undefined): boolean {
  return Boolean(action && isAgentUpdate(action) && ACTIVE.has(action.status));
}

/** When the update was asked for, in ms (for the elapsed clock). */
export function updateStartedAt(action: Pick<RemoteAction, "queued_at" | "created_at">): number | null {
  const at = Date.parse(action.queued_at ?? action.created_at ?? "");
  return Number.isFinite(at) ? at : null;
}

/** 0:07, 4:32, 1:02:09 */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
