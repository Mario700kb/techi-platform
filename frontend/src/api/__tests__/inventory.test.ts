import { describe, expect, it } from "vitest";
import { DeviceInventory, patchStatusFromEvent, withPatchStatus } from "../inventory";

const report = {
  type: "patch_status_updated" as const,
  data: {
    id: 12,
    client_id: 3,
    pending_updates: 384,
    reboot_required: false,
    patch_state: "updates_available" as const,
  },
};

describe("patch status events", () => {
  it("reads the report a patch_status_updated event carries", () => {
    expect(patchStatusFromEvent(report)).toEqual({
      device_id: 12,
      pending_updates: 384,
      reboot_required: false,
      last_update_at: null,
      patch_state: "updates_available",
    });
  });

  it("ignores every other event", () => {
    expect(patchStatusFromEvent({ type: "telemetry_updated", data: { id: 12 } })).toBeNull();
    expect(patchStatusFromEvent(null)).toBeNull();
  });

  it("updates the count of the same device's inventory and leaves the rest", () => {
    const inventory: DeviceInventory = {
      device_id: 12,
      processes: [{ pid: 4, name: "System" }],
      services: [],
      software: [],
      pending_updates: 3,
      reboot_required: false,
      patch_state: "updates_available",
    };
    const patch = patchStatusFromEvent(report)!;

    expect(withPatchStatus(inventory, patch)).toEqual({ ...inventory, pending_updates: 384, last_update_at: null });
    expect(withPatchStatus({ ...inventory, device_id: 13 }, patch).pending_updates).toBe(3);
  });
});
