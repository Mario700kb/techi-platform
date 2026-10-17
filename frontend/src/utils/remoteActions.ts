import type { RemoteAction } from "../api/actions";

// How far an action has got. Terminal states share the top rank.
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

/**
 * Add an action the operator just queued to the history, once.
 *
 * Delivered over the live channel, an action's realtime events can reach the
 * page before the POST that created it returns, and the merge of those events
 * may already have added it, further along ("completed"). Prepending the POST
 * response again showed it twice, the copy stuck on "Sent".
 */
export function addQueuedAction(list: RemoteAction[], created: RemoteAction): RemoteAction[] {
  const index = list.findIndex((a) => a.id === created.id);
  if (index === -1) return [created, ...list];
  const existing = list[index];
  if ((STATUS_RANK[created.status] ?? 0) <= (STATUS_RANK[existing.status] ?? 0)) return list;
  const next = [...list];
  next[index] = { ...existing, ...created };
  return next;
}
