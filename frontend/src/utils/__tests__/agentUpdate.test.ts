import { describe, expect, it } from "vitest";

import type { RemoteAction } from "../../api/actions";
import {
  downloadDetail,
  formatElapsed,
  latestAgentUpdate,
  mergeActionUpdate,
  pickAgentUpdate,
  updatePercent,
  updateStageText,
  updateStep,
  updateTargetVersion,
  upsertAction,
} from "../agentUpdate";

function update(overrides: Partial<RemoteAction> = {}): RemoteAction {
  return {
    id: 10,
    device_id: 1,
    action_type: "self_update" as RemoteAction["action_type"],
    status: "running",
    created_at: "2026-10-18T10:00:00Z",
    execution_timeout_seconds: 600,
    parameters: { version: "2.1.31" },
    progress: null,
    stage: null,
    ...overrides,
  };
}

describe("agent update stage words", () => {
  it("names every step in plain words", () => {
    expect(updateStageText(update({ status: "queued" }))).toBe("Queued — goes out at once over the live channel");
    expect(updateStageText(update({ status: "queued" }), false)).toBe("Queued — goes out at the next heartbeat");
    expect(updateStageText(update({ status: "sent" }))).toBe("Sent to the agent");
    expect(updateStageText(update({ status: "acknowledged" }))).toBe("Sent to the agent");
    expect(updateStageText(update({ stage: "downloading", progress: 42 }))).toBe("Downloading 42%");
    expect(updateStageText(update({ stage: "downloading" }))).toBe("Downloading");
    expect(updateStageText(update({ stage: "verifying", progress: 85 }))).toBe("Verifying the package");
    expect(updateStageText(update({ stage: "installing", progress: 90 }))).toBe("Installing");
    expect(updateStageText(update({ stage: "restarting", progress: 95 }))).toBe("Restarting the agent");
    expect(updateStageText(update({ stage: "confirming", progress: 97 }))).toBe("Confirming the new version");
    expect(updateStageText(update({ status: "failed" }))).toBe("Update failed");
  });

  it("numbers the step under way", () => {
    expect(updateStep(update({ status: "queued" }))).toBeNull();
    expect(updateStep(update({ stage: "downloading" }))).toBe(1);
    expect(updateStep(update({ stage: "confirming" }))).toBe(5);
    expect(updateStep(update({ stage: "toString" as RemoteAction["stage"] }))).toBeNull();
  });
});

describe("agent update percentage", () => {
  it("is determinate only when the backend sent a number", () => {
    expect(updatePercent(update({ progress: null }))).toBeNull();
    expect(updatePercent(update({ progress: undefined }))).toBeNull();
    expect(updatePercent(update({ progress: 41.6 }))).toBe(42);
    expect(updatePercent(update({ progress: 140 }))).toBe(100);
    expect(updatePercent(update({ progress: -3 }))).toBe(0);
    expect(updatePercent(update({ status: "completed", progress: null }))).toBe(100);
  });

  it("reads the download size from the result message", () => {
    expect(downloadDetail("Downloading (2.6 of 6.3 MB)")).toBe("2.6 of 6.3 MB");
    expect(downloadDetail("12 of 48 KB")).toBe("12 of 48 KB");
    expect(downloadDetail("Verifying")).toBeNull();
    expect(downloadDetail(null)).toBeNull();
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(7)).toBe("0:07");
    expect(formatElapsed(272)).toBe("4:32");
    expect(formatElapsed(3729)).toBe("1:02:09");
  });

  it("takes the target version from the payload", () => {
    expect(updateTargetVersion(update())).toBe("2.1.31");
    expect(updateTargetVersion(update({ parameters: null }))).toBeNull();
  });
});

describe("merging copies of an update", () => {
  it("never moves an update backwards", () => {
    const at60 = update({ stage: "downloading", progress: 60 });
    const at20 = update({ stage: "downloading", progress: 20 });
    expect(mergeActionUpdate(at60, at20)).toBe(at60);
    expect(mergeActionUpdate(at20, at60).progress).toBe(60);
    // A later stage wins over any percentage, and completion over everything.
    const restarting = update({ stage: "restarting", progress: null });
    expect(mergeActionUpdate(at60, restarting).stage).toBe("restarting");
    const done = update({ status: "completed", progress: null, stage: null });
    expect(mergeActionUpdate(restarting, done).status).toBe("completed");
    expect(mergeActionUpdate(done, at60).status).toBe("completed");
  });

  it("upserts into a list and picks the newest update", () => {
    const list = [update({ status: "sent" })];
    expect(upsertAction(list, update({ id: 11, status: "queued" })).map((a) => a.id)).toEqual([11, 10]);
    expect(upsertAction(list, update({ status: "queued" }))).toBe(list);
    expect(upsertAction(list, update({ stage: "verifying", progress: 85 }))[0].stage).toBe("verifying");
    expect(pickAgentUpdate(update({ id: 9 }), update({ id: 12 }))?.id).toBe(12);
    expect(
      latestAgentUpdate([update({ id: 3 }), update({ id: 8 }), { ...update({ id: 20 }), action_type: "ping" }])?.id,
    ).toBe(8);
  });
});
