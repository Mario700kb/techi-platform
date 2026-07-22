import { describe, expect, it } from "vitest";

import { phaseForStatus } from "../ComponentStatesPanel";

// Pure mapping from a RemoteAction status → the 4 live execution phases the panel
// shows in realtime (Operational M6): Pending / Running / Success / Failed.
describe("phaseForStatus", () => {
  it("maps queued/sent/acknowledged to pending", () => {
    expect(phaseForStatus("queued")).toBe("pending");
    expect(phaseForStatus("sent")).toBe("pending");
    expect(phaseForStatus("acknowledged")).toBe("pending");
  });

  it("maps running to running", () => {
    expect(phaseForStatus("running")).toBe("running");
  });

  it("maps completed to success", () => {
    expect(phaseForStatus("completed")).toBe("success");
  });

  it("maps failed/expired/cancelled to failed", () => {
    expect(phaseForStatus("failed")).toBe("failed");
    expect(phaseForStatus("expired")).toBe("failed");
    expect(phaseForStatus("cancelled")).toBe("failed");
  });

  it("returns null for unknown/absent status", () => {
    expect(phaseForStatus(undefined)).toBeNull();
    expect(phaseForStatus(null)).toBeNull();
    expect(phaseForStatus("bogus")).toBeNull();
  });
});
