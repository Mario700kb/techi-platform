import { describe, expect, it } from "vitest";
import type { Device } from "../api/devices";
import { remoteSupportConnectAvailable, remoteSupportPresentation } from "./remoteSupportState";

function device(state: string, rustdeskId: string | null = "486641675"): Device {
  return {
    remote_support_state: state,
    rustdesk_id: rustdeskId,
    rustdesk_conflict_detected: false,
  } as Device;
}

describe("remoteSupportPresentation", () => {
  it("does not map unknown or legacy status to missing", () => {
    expect(remoteSupportPresentation(device("unknown")).label).toBe("Status unavailable");
    expect(remoteSupportPresentation(device("legacy_status_unavailable")).label).toBe("Status unavailable");
  });

  it.each(["installed_running", "unknown", "damaged", "legacy_status_unavailable"])(
    "keeps Connect available with persisted Remote ID when state is %s",
    (state) => {
      expect(remoteSupportConnectAvailable(device(state))).toBe(true);
    },
  );

  it("blocks Connect only for a missing, invalid, or conflicting Remote ID", () => {
    expect(remoteSupportConnectAvailable(device("installed_running", null))).toBe(false);
    expect(remoteSupportConnectAvailable(device("installed_running", "pending_device"))).toBe(false);
    expect(remoteSupportConnectAvailable({
      ...device("installed_running"),
      rustdesk_conflict_detected: true,
    })).toBe(false);
  });
});
