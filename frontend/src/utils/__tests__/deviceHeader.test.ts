import { describe, expect, it } from "vitest";
import type { Device } from "../../api/devices";
import { deviceTypeLabel, headerGroup } from "../deviceBadges";

const device = (over: Partial<Device>) => ({ id: 924, device_type: "unassigned", ...over }) as Device;

describe("the device header", () => {
  it("names the console's category, not the legacy type column", () => {
    // Mario-Lenovo: device_type unassigned, category Client PC from its group.
    expect(deviceTypeLabel(device({ resolved_device_category: "clientpc" }))).toBe("Client PC");
    expect(deviceTypeLabel(device({ resolved_device_category: "servers" }))).toBe("Server");
    expect(deviceTypeLabel(device({ resolved_device_category: "unassigned" }))).toBe("Unclassified");
  });

  it("does not repeat a standard group after the category", () => {
    expect(headerGroup(device({ resolved_group: "Client PC" }))).toBeNull();
    expect(headerGroup(device({ resolved_group: "Servers" }))).toBeNull();
    expect(headerGroup(device({ resolved_group: "Front desk" }))).toBe("Front desk");
    expect(headerGroup(device({}))).toBeNull();
  });
});
