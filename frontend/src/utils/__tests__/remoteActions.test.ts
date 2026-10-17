import { describe, expect, it } from "vitest";

import type { RemoteAction } from "../../api/actions";
import { addQueuedAction } from "../remoteActions";

function action(id: number, status: RemoteAction["status"]): RemoteAction {
  return { id, device_id: 924, action_type: "restart_device", status } as RemoteAction;
}

describe("addQueuedAction", () => {
  it("adds an action the history does not have yet", () => {
    const list = [action(1, "completed")];
    expect(addQueuedAction(list, action(2, "sent")).map((a) => a.id)).toEqual([2, 1]);
  });

  it("does not show an action twice when its live events arrived first", () => {
    // The restart ran over the live channel: "completed" was merged in from the
    // realtime events before the POST answered with "sent".
    const list = [action(2584, "completed"), action(2583, "completed")];
    const next = addQueuedAction(list, action(2584, "sent"));
    expect(next).toHaveLength(2);
    expect(next[0].status).toBe("completed");
  });

  it("moves an action forward when the POST answer is further along", () => {
    const next = addQueuedAction([action(7, "queued")], action(7, "sent"));
    expect(next).toEqual([action(7, "sent")]);
  });
});
