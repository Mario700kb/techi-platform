import { describe, expect, it } from "vitest";
import type { Device } from "../api/devices";
import { remoteSupportPresentation } from "./remoteSupportState";

function device(state: string): Device {
  return { remote_support_state: state } as Device;
}

describe("remoteSupportPresentation", () => {
  it("does not map unknown or legacy status to missing", () => {
    expect(remoteSupportPresentation(device("unknown")).label).toBe("Status unavailable");
    expect(remoteSupportPresentation(device("legacy_status_unavailable")).label).toBe("Status unavailable");
  });

  it("allows Connect only for trusted running states", () => {
    expect(remoteSupportPresentation(device("installed_running")).connectAllowed).toBe(true);
    expect(remoteSupportPresentation(device("missing")).connectAllowed).toBe(false);
    expect(remoteSupportPresentation(device("damaged")).connectAllowed).toBe(false);
  });
});
