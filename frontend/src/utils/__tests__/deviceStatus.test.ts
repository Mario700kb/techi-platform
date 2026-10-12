import { describe, expect, it } from "vitest";

import { humanize, metricTone, remoteSupportStatus, TONE } from "../deviceStatus";

describe("remoteSupportStatus", () => {
  it("names every service state the same way everywhere", () => {
    expect(remoteSupportStatus({ rustdesk_status: "running", rustdesk_install_status: "installed" })).toEqual({
      label: "Running",
      tone: TONE.online,
    });
    expect(remoteSupportStatus({ rustdesk_status: "not_running", rustdesk_install_status: "installed" })).toEqual({
      label: "Stopped",
      tone: TONE.warning,
    });
    expect(remoteSupportStatus({ rustdesk_status: "stopped" })).toEqual({ label: "Stopped", tone: TONE.warning });
    expect(remoteSupportStatus({ rustdesk_status: null, rustdesk_install_status: "not_installed" })).toEqual({
      label: "Not installed",
      tone: TONE.neutral,
    });
    expect(remoteSupportStatus({})).toEqual({ label: "Unknown", tone: TONE.neutral });
  });

  it("never shows a raw snake_case value", () => {
    expect(remoteSupportStatus({ rustdesk_status: "start_pending" }).label).toBe("Start pending");
    expect(humanize("not_running")).toBe("Not running");
  });
});

describe("metricTone", () => {
  it("turns amber and red at the same values that open alerts", () => {
    expect(metricTone("ram", 89)).toBe(TONE.online);
    expect(metricTone("ram", 90)).toBe(TONE.warning);
    expect(metricTone("cpu", 95)).toBe(TONE.critical);
    expect(metricTone("disk", null)).toBe(TONE.neutral);
  });
});
