import { describe, expect, it } from "vitest";
import { DeviceRequestGate } from "./deviceRequestGate";

describe("DeviceRequestGate", () => {
  it("rejects a device A response after switching to device B", () => {
    const gate = new DeviceRequestGate();
    const deviceA = gate.begin(101);
    const deviceB = gate.begin(202);

    expect(gate.isCurrent(deviceA)).toBe(false);
    expect(gate.isCurrent(deviceB)).toBe(true);
  });

  it("rejects an older request generation for the same device", () => {
    const gate = new DeviceRequestGate();
    const first = gate.begin(101);
    const second = gate.begin(101);

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(second)).toBe(false);
  });
});
